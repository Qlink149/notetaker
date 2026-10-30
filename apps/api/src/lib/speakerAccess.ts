import { env } from '../config/env.js';
import { HttpError } from './http.js';
import { SpeakerModel, type SpeakerDoc, type WorkspaceDoc } from '../models/index.js';

/**
 * Who may use the global speaker assign controls and their APIs.
 *
 * Phase 1 has no user accounts or roles: one shared access code signs everyone in, and the only
 * per-person identity is the speaker chosen as "This is me" (`workspace.mePersonId`). The allowlist
 * is `SPEAKER_ADMINS` (default `Heet`). A name matches case-insensitively, and a single word also
 * matches a longer name that starts with it ("Heet" matches "Heet Dholakia"). An entry that is a
 * speaker id matches that person exactly. Nothing else in the app reads the list.
 */

export function speakerAdminAllowlist(): string[] {
  return env().SPEAKER_ADMINS;
}

export function nameOnAllowlist(name: string, personId: string, allow: string[]): boolean {
  const folded = name.trim().toLowerCase();
  return allow.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    if (e === personId.toLowerCase()) return true;
    return folded === e || folded.startsWith(`${e} `);
  });
}

export async function speakerAdmin(
  workspace: WorkspaceDoc,
): Promise<{ allowed: boolean; me: SpeakerDoc | null }> {
  if (!workspace.mePersonId) return { allowed: false, me: null };
  const me = await SpeakerModel.findOne({
    _id: workspace.mePersonId,
    workspaceId: workspace._id,
  }).lean<SpeakerDoc>();
  if (!me) return { allowed: false, me: null };
  return {
    allowed: nameOnAllowlist(me.name, String(me._id), speakerAdminAllowlist()),
    me,
  };
}

export async function assertSpeakerAdmin(workspace: WorkspaceDoc): Promise<SpeakerDoc> {
  const { allowed, me } = await speakerAdmin(workspace);
  if (!allowed || !me) throw new HttpError(403, 'speaker_admin_only');
  return me;
}
