import { Types, type QueryFilter } from 'mongoose';
import { STAGE_LEASE_MS, type JobStage } from '@meetingid/shared';
import { JobModel, type JobDoc } from '../models/index.js';
import { MAX_ATTEMPTS } from './errors.js';

export interface EnqueueInput {
  meetingId: string | Types.ObjectId;
  stage: JobStage;
  step?: number | null;
  payload?: Record<string, unknown> | null;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * Queue a job unless an identical one (same meeting, stage, step) is already queued or running.
 * Returns the queued job either way.
 */
export async function enqueue(input: EnqueueInput): Promise<JobDoc> {
  const meetingId = new Types.ObjectId(String(input.meetingId));
  const step = input.step ?? null;
  const existing = await JobModel.findOne({
    meetingId,
    stage: input.stage,
    step,
    status: { $in: ['queued', 'running'] },
  }).lean<JobDoc>();
  if (existing) {
    if (input.payload && existing.status === 'queued') {
      await JobModel.updateOne({ _id: existing._id }, { $set: { payload: input.payload } });
    }
    return existing;
  }
  const job = await JobModel.create({
    meetingId,
    stage: input.stage,
    step,
    payload: input.payload ?? null,
    runAfter: input.runAfter ?? new Date(),
    maxAttempts: input.maxAttempts ?? MAX_ATTEMPTS,
  });
  return job.toObject() as JobDoc;
}

/**
 * Atomically claim the next runnable job: queued and due, or running past its stage lease
 * (its worker died). The claim stamps `lockedBy`/`lockedAt` and counts an attempt.
 */
export async function claimNext(workerId: string, now = new Date()): Promise<JobDoc | null> {
  const expired: QueryFilter<JobDoc>[] = (
    Object.entries(STAGE_LEASE_MS) as [JobStage, number][]
  ).map(([stage, lease]) => ({
    status: 'running' as const,
    stage,
    lockedAt: { $lt: new Date(now.getTime() - lease) },
  }));
  const filter: QueryFilter<JobDoc> = {
    $or: [{ status: 'queued', runAfter: { $lte: now } }, ...expired],
  };
  return JobModel.findOneAndUpdate(
    filter,
    { $set: { status: 'running', lockedBy: workerId, lockedAt: now }, $inc: { attempts: 1 } },
    { sort: { runAfter: 1 }, returnDocument: 'after' },
  ).lean<JobDoc>();
}

/** Extend the lease of a job this worker still holds. Returns false if the lock was lost. */
export async function renewLease(jobId: Types.ObjectId, workerId: string): Promise<boolean> {
  const res = await JobModel.updateOne(
    { _id: jobId, status: 'running', lockedBy: workerId },
    { $set: { lockedAt: new Date() } },
  );
  return res.matchedCount === 1;
}

export async function markDone(jobId: Types.ObjectId, workerId: string): Promise<void> {
  await JobModel.updateOne(
    { _id: jobId, lockedBy: workerId },
    { $set: { status: 'done', lockedBy: null, lockedAt: null, lastError: null } },
  );
}

export async function scheduleRetry(
  jobId: Types.ObjectId,
  workerId: string,
  runAfter: Date,
  error: string,
): Promise<void> {
  await JobModel.updateOne(
    { _id: jobId, lockedBy: workerId },
    { $set: { status: 'queued', runAfter, lockedBy: null, lockedAt: null, lastError: error } },
  );
}

export async function markFailed(
  jobId: Types.ObjectId,
  workerId: string,
  error: string,
): Promise<void> {
  await JobModel.updateOne(
    { _id: jobId, lockedBy: workerId },
    { $set: { status: 'failed', lockedBy: null, lockedAt: null, lastError: error } },
  );
}

/** Hand a job back without counting the attempt (graceful shutdown). */
export async function release(jobId: Types.ObjectId, workerId: string): Promise<void> {
  await JobModel.updateOne(
    { _id: jobId, lockedBy: workerId, status: 'running' },
    {
      $set: { status: 'queued', lockedBy: null, lockedAt: null, runAfter: new Date() },
      $inc: { attempts: -1 },
    },
  );
}
