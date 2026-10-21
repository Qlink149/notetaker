import { z } from 'zod';

/** A follow-up someone owns ("Kept" tasks): from a meeting's action items or added by hand. */
export const TaskPriority = z.enum(['high', 'med', 'low']);
export type TaskPriority = z.infer<typeof TaskPriority>;

export const TaskStatus = z.enum(['open', 'done']);
export type TaskStatus = z.infer<typeof TaskStatus>;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Id = z.string().regex(/^[a-f0-9]{24}$/);

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  /** The person doing it (a person in the speaker directory). */
  ownerId: z.string().nullable(),
  ownerName: z.string(),
  /** A second person sharing it. */
  buddyId: z.string().nullable(),
  buddyName: z.string().nullable(),
  priority: TaskPriority,
  /** YYYY-MM-DD; null when no deadline was set. */
  due: Day.nullable(),
  status: TaskStatus,
  doneAt: z.string().nullable(),
  /** Who gave it: the person set as "me" when it was created, if any. */
  createdById: z.string().nullable(),
  createdByName: z.string().nullable(),
  meetingId: z.string().nullable(),
  meetingTitle: z.string().nullable(),
  /** The action item it came from (its position in the meeting's summary). */
  source: z.object({ meetingId: z.string(), index: z.number(), text: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const CreateTaskBody = z.object({
  title: z.string().trim().min(1).max(500),
  ownerId: Id,
  buddyId: Id.nullable().optional(),
  priority: TaskPriority.default('med'),
  due: Day.nullable().optional(),
  meetingId: Id.nullable().optional(),
  /** Approving a suggested task: the action item's position in that meeting's summary. */
  fromSuggestion: z.object({ meetingId: Id, index: z.number().int().min(0) }).optional(),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBody>;

export const PatchTaskBody = z
  .object({
    title: z.string().trim().min(1).max(500),
    ownerId: Id,
    buddyId: Id.nullable(),
    priority: TaskPriority,
    due: Day.nullable(),
    status: TaskStatus,
  })
  .partial();
export type PatchTaskBody = z.infer<typeof PatchTaskBody>;

/** An action item of a meeting not yet approved or skipped as a task. */
export const TaskSuggestion = z.object({
  meetingId: z.string(),
  meetingTitle: z.string(),
  index: z.number(),
  title: z.string(),
  due: Day.nullable(),
  priority: TaskPriority,
  quote: z.string(),
  /** The speaker the summary gave it to, and the person that is when known. */
  speakerName: z.string(),
  ownerId: z.string().nullable(),
});
export type TaskSuggestion = z.infer<typeof TaskSuggestion>;

export const SetMeBody = z.object({ personId: Id.nullable() });
export type SetMeBody = z.infer<typeof SetMeBody>;
