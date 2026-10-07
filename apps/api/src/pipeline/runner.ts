import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stage } from '@meetingid/shared';
import { jobLogger, logger } from '../lib/logger.js';
import { HeartbeatModel, type JobDoc } from '../models/index.js';
import type { Deps, StageRegistry } from './context.js';
import { FatalError, RetryableError, backoffMs, classify } from './errors.js';
import { failMeeting } from './meetings.js';
import { claimNext, markDone, markFailed, release, renewLease, scheduleRetry } from './queue.js';

const HEARTBEAT_MS = 30_000;
const IDLE_POLL_MS = 2_000;

export interface RunnerOptions {
  workerId?: string;
  concurrency?: number;
}

/**
 * The worker loop: claim a job → run its stage → persist → the stage enqueues the next one.
 * Every stage is idempotent and resumable from MongoDB, so a deploy or crash mid-job only
 * costs a reclaim after the lease expires (or immediately, on graceful shutdown).
 */
export class Runner {
  readonly workerId: string;
  private readonly concurrency: number;
  private stopping = false;
  private readonly active = new Map<string, JobDoc>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: Deps,
    private readonly stages: StageRegistry,
    opts: RunnerOptions = {},
  ) {
    this.workerId = opts.workerId ?? `${hostname()}-${process.pid}`;
    this.concurrency = opts.concurrency ?? 2;
  }

  /** Claim and run one job. Returns false when nothing was runnable. */
  async runOnce(): Promise<boolean> {
    const job = await claimNext(this.workerId, this.deps.now());
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Run jobs until the queue has nothing runnable (tests, eval CLI). */
  async drain(maxJobs = 500): Promise<number> {
    let n = 0;
    while (n < maxJobs && (await this.runOnce())) n++;
    return n;
  }

  async start(): Promise<void> {
    await this.beat();
    this.heartbeat = setInterval(() => void this.beat(), HEARTBEAT_MS);
    logger.info({ workerId: this.workerId, concurrency: this.concurrency }, 'worker started');
    await Promise.all(Array.from({ length: this.concurrency }, () => this.loop()));
  }

  /** Stop claiming, give in-flight jobs `graceMs` to finish, hand the rest back to the queue. */
  async stop(graceMs = 25_000): Promise<void> {
    this.stopping = true;
    const deadline = Date.now() + graceMs;
    while (this.active.size && Date.now() < deadline) await sleep(250);
    for (const job of this.active.values()) await release(job._id, this.workerId);
    if (this.heartbeat) clearInterval(this.heartbeat);
    logger.info({ released: this.active.size }, 'worker stopped');
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        if (!(await this.runOnce())) await sleep(IDLE_POLL_MS);
      } catch (err) {
        logger.error({ err }, 'worker loop error');
        await sleep(IDLE_POLL_MS * 5);
      }
    }
  }

  private async beat(): Promise<void> {
    await HeartbeatModel.updateOne(
      { _id: this.workerId },
      { $set: { lastHeartbeat: new Date() }, $setOnInsert: { startedAt: new Date() } },
      { upsert: true },
    ).catch((err: unknown) => logger.warn({ err }, 'heartbeat failed'));
  }

  private async execute(job: JobDoc): Promise<void> {
    const handler = this.stages[job.stage];
    const log = jobLogger({
      meetingId: String(job.meetingId),
      jobId: String(job._id),
      stage: job.stage,
      step: job.step,
    });
    const tmpDir = await mkdtemp(join(tmpdir(), `mid-${job.stage}-`));
    const ctx = { job, log, deps: this.deps, tmpDir };
    this.active.set(String(job._id), job);
    const lease = setInterval(() => void renewLease(job._id, this.workerId), HEARTBEAT_MS);
    const started = Date.now();
    try {
      log.info({ attempt: job.attempts }, 'job started');
      await handler.run(ctx);
      await markDone(job._id, this.workerId);
      log.info({ ms: Date.now() - started }, 'job done');
    } catch (raw) {
      const err = classify(raw);
      // Waiting on a quota reset or an external answer is not a failed attempt.
      const quota =
        err instanceof RetryableError && (err.reason === 'quota' || err.reason === 'waiting');
      const giveUp = err instanceof FatalError || (!quota && job.attempts >= job.maxAttempts);
      log.warn({ err: err.message, attempt: job.attempts, giveUp }, 'job failed');
      if (giveUp) {
        await markFailed(job._id, this.workerId, err.message);
        try {
          if (handler.onGiveUp) await handler.onGiveUp(ctx, err);
          else if (job.stage !== 'benchmark') {
            await failMeeting(job.meetingId, job.stage as Stage, err, true);
          }
        } catch (hookErr) {
          log.error({ err: hookErr }, 'give-up handler failed');
        }
      } else {
        const wait = (err instanceof RetryableError && err.retryAfterMs) || backoffMs(job.attempts);
        const runAfter = new Date(this.deps.now().getTime() + wait);
        await scheduleRetry(job._id, this.workerId, runAfter, err.message, quota);
      }
    } finally {
      clearInterval(lease);
      this.active.delete(String(job._id));
      await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
