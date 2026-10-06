import { z } from 'zod';
import { EngineName, Language } from './meeting.js';

export const ScriptPreference = z.enum(['roman', 'native']);
export type ScriptPreference = z.infer<typeof ScriptPreference>;

export const WorkspaceSettings = z.object({
  engine: EngineName,
  languages: z.array(Language).min(1),
  scriptPreference: ScriptPreference,
  summaryModel: z.string().min(1),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  settings: WorkspaceSettings,
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

export const DEFAULT_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

export const defaultWorkspaceSettings = (): WorkspaceSettings => ({
  engine: 'gemini',
  languages: ['hi', 'gu', 'en'],
  scriptPreference: 'roman',
  summaryModel: DEFAULT_SUMMARY_MODEL,
});
