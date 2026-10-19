import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Stage } from '@meetingid/shared';
import { jobLogger, logger } from '../lib/logger.js';
import { HeartbeatModel, MeetingModel, type JobDoc } from '../models/index.js';
import type { Deps, StageRegistry } from './context.js';
import {
  CREDIT_NOTICE,
  FatalError,
  RetryableError,
  backoffMs,
  classify,
  isOutOfCredit,
} from './errors.js';
import { failMeeting } from './meetings.js';
import {
  claimNext,
  markDone,
  markFailed,
  release,
  renewLease,
  scheduleRetry,
  waitForJob,
  wakeIdleLoops,
  type ClaimLane,
} from './queue.js';

const HEARTBEAT_MS = 30_000;
const IDLE_POLL_MS = 2_000;
/**
 * Longest wait between empty checks of the queue. A new upload waits at most this long before the worker
 * picks it up; work this worker queues itself (chunks, the next stage) starts at once (waitForJob).
 */
const IDLE_POLL_MAX_MS = 30_000;

export interface RunnerOptions {
  workerId?: string;
  /** Jobs at once on the main lane (every stage, or every stage but transcription when `transcribeConcurrency` is set). */
  concurrency?: number;
  /** Extra lane that only transcribes chunks, this many at once. 0 or unset: no separate lane. */
  transcribeConcurrency?: number;
}

/**
 * The worker loop: claim a job → run its stage → persist → the stage enqueues the next one.
 * Every stage is idempotent and resumable from MongoDB, so a deploy or crash mid-job only
 * costs a reclaim after the lease expires (or immediately, on graceful shutdown).
 */
export class Runner {
  readonly workerId: string;
  private readonly concurrency: number;
  private readonly transcribeConcurrency: number;
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
    this.transcribeConcurrency = opts.transcribeConcurrency ?? 0;
  }

  /** Claim and run one job. Returns false when nothing was runnable. */
  async runOnce(lane: ClaimLane = {}): Promise<boolean> {
    const job = await claimNext(this.workerId, this.deps.now(), lane);
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
    logger.info(
      {
        workerId: this.workerId,
        concurrency: this.concurrency,
        transcribeConcurrency: this.transcribeConcurrency,
      },
      'worker started',
    );
    // Transcription only waits on Gemini, so it gets its own lane and several chunks run at once; every other
    // stage (ingest, speaker analysis, gap fill, ...) stays on the main lane where they are CPU and memory heavy.
    const split = this.transcribeConcurrency > 0;
    await Promise.all([
      ...Array.from({ length: this.concurrency }, () =>
        this.loop(split ? { except: ['transcribe'] } : {}),
      ),
      ...Array.from({ length: split ? this.transcribeConcurrency : 0 }, () =>
        this.loop({ only: ['transcribe'] }),
      ),
    ]);
  }

  /** Stop claiming, give in-flight jobs `graceMs` to finish, hand the rest back to the queue. */
  async stop(graceMs = 25_000): Promise<void> {
    this.stopping = true;
    wakeIdleLoops();
    const deadline = Date.now() + graceMs;
    while (this.active.size && Date.now() < deadline) await sleep(250);
    for (const job of this.active.values()) await release(job._id, this.workerId);
    if (this.heartbeat) clearInterval(this.heartbeat);
    logger.info({ released: this.active.size }, 'worker stopped');
  }

  private async loop(lane: ClaimLane): Promise<void> {
    // Empty checks double the wait, up to IDLE_POLL_MAX_MS; finding a job resets it.
    let idle = IDLE_POLL_MS;
    while (!this.stopping) {
      try {
        if (await this.runOnce(lane)) idle = IDLE_POLL_MS;
        else {
          await waitForJob(idle);
          idle = Math.min(idle * 2, IDLE_POLL_MAX_MS);
        }
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
    // A failed renewal (e.g. a DNS blip to Atlas) must never reject unhandled: Node would exit.
    const lease = setInterval(
      () =>
        void renewLease(job._id, this.workerId).catch((err: unknown) =>
          log.warn({ err }, 'lease renewal failed'),
        ),
      HEARTBEAT_MS,
    );
    const started = Date.now();
    try {
      log.info({ attempt: job.attempts }, 'job started');
      // A job whose worker died is claimed again without ever recording an error, so nothing else stops
      // a recording that crashes the server (out of memory) from being retried for ever.
      if (job.attempts > job.maxAttempts)
        throw new FatalError(
          'The server restarted several times while processing this step (it ran out of memory or stopped answering). Try again, or use a shorter recording.',
        );
      await handler.run(ctx);
      await markDone(job._id, this.workerId);
      await clearNotice(job.meetingId);
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
        if (isOutOfCredit(err)) await setNotice(job.meetingId, CREDIT_NOTICE);
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

/** A short note on the meeting page while processing is paused for a reason outside our control. */
async function setNotice(meetingId: JobDoc['meetingId'], notice: string): Promise<void> {
  await MeetingModel.updateOne({ _id: meetingId }, { $set: { notice } }).catch(() => undefined);
}
async function clearNotice(meetingId: JobDoc['meetingId']): Promise<void> {
  await MeetingModel.updateOne(
    { _id: meetingId, notice: { $nin: [null, ''] } },
    { $set: { notice: null } },
  ).catch(() => undefined);
}
