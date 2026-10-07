import type {
  BenchmarkEngineName,
  EngineName,
  EvalRun,
  GlossaryEntry,
  Language,
  Meeting,
  MeetingDataView,
  RetryableStage,
  UploadSignResponse,
  Workspace,
  WorkspaceSettings,
} from '@meetingid/shared';

// Typed client for the MeetingID API (replaces the Base44 SDK).

const BASE = `${(import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:8080'}/api/v1`;
const TOKEN_KEY = 'meetingid_token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly similar?: SimilarName[],
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode): the httpOnly cookie still authenticates
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
/** Called when any request comes back 401 (token expired or revoked). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/auth/login'))
    unauthorizedListeners.forEach((fn) => fn());
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as { error?: string; similar?: SimilarName[] };
  if (!res.ok) throw new ApiError(res.status, json.error ?? `Request failed (${res.status})`, json.similar);
  return json as T;
}

export interface Speaker {
  id: string;
  name: string;
  hasVoiceprint: boolean;
  enrollmentAudioUrl: string | null;
  createdAt: string;
}

export interface SpeakerCard {
  diar: string;
  label: string;
  displayName: string;
  personId: string | null;
  personName: string | null;
  anonymous: boolean;
  voiceprints: number;
  speakerSec: number;
  turns: number;
  status: 'solid' | 'review' | 'new' | 'manual';
  match: { personId: string; name: string; score: number; margin: number } | null;
  candidate: { name: string; score: number; status: string } | null;
  clips: { start: number; end: number; quality: number | null }[];
  appearsIn: { meetingId: string; title: string; label: string; displayName: string; score: number | null }[];
}

export interface AuditClip {
  start: number;
  end: number;
  quality: number | null;
}
export interface AuditCluster {
  diar: string;
  label: string;
  seconds: number;
  name: string;
  sameAs: string;
  clips: AuditClip[];
}
export interface AuditItemView {
  id: string;
  start: number;
  end: number;
  assigned: string;
  textRoman: string;
  textNative: string;
  speaker: 'right' | 'wrong' | 'unsure' | null;
  text: 'match' | 'partly' | 'no' | null;
}
export interface AuditTally {
  method: string;
  items: number;
  answered: number;
  right: number;
  wrong: number;
  unsure: number;
  speakerCorrectRate: number | null;
  speakerCorrectRateDecided: number | null;
  wrongNameRate: number | null;
  textAnswered: number;
  textMatch: number;
  textPartly: number;
  textNo: number;
  textMatchRate: number | null;
}

export interface SimilarName {
  id: string;
  name: string;
}

export interface CreateMeetingInput {
  meetingId: string;
  title: string;
  publicId: string;
  url: string;
  languages?: Language[];
  engine?: EngineName;
  expectedParticipants?: number | null;
}

export const api = {
  auth: {
    login: (code: string) =>
      request<{ token: string; workspace: Workspace }>('POST', '/auth/login', { code }),
    me: () => request<{ workspace: Workspace }>('GET', '/auth/me'),
    logout: () => request<void>('POST', '/auth/logout'),
  },
  uploads: {
    sign: () => request<UploadSignResponse>('POST', '/uploads/sign'),
  },
  meetings: {
    list: (limit = 50) =>
      request<{ meetings: Meeting[] }>('GET', `/meetings?limit=${limit}`).then((r) => r.meetings),
    get: (id: string) =>
      request<{ meeting: Meeting }>('GET', `/meetings/${id}`).then((r) => r.meeting),
    data: (id: string) => request<MeetingDataView>('GET', `/meetings/${id}/data`),
    create: (input: CreateMeetingInput) =>
      request<{ meeting: Meeting }>('POST', '/meetings', input).then((r) => r.meeting),
    rename: (id: string, title: string) =>
      request<{ meeting: Meeting }>('PATCH', `/meetings/${id}`, { title }).then((r) => r.meeting),
    retry: (id: string, stage: RetryableStage) =>
      request<{ meeting: Meeting }>('POST', `/meetings/${id}/retry`, { stage }).then(
        (r) => r.meeting,
      ),
    summarise: (id: string, force = true) =>
      request<{ meeting: Meeting }>('POST', `/meetings/${id}/summarise`, { force }).then(
        (r) => r.meeting,
      ),
    remove: (id: string) => request<void>('DELETE', `/meetings/${id}`),
    speakers: (id: string) =>
      request<{ source: 'pyannote' | 'text-fallback'; cards: SpeakerCard[] }>(
        'GET',
        `/meetings/${id}/speakers`,
      ),
    /** Resolves with {similar} instead of saving when the name looks like an existing person. */
    nameSpeaker: async (
      id: string,
      diar: string,
      input: { name: string; usePersonId?: string; createNew?: boolean },
    ): Promise<{ similar?: SimilarName[]; updatedMeetings?: string[]; meetingsWithThisVoice?: string[] }> => {
      try {
        return await request('POST', `/meetings/${id}/speakers/${encodeURIComponent(diar)}/name`, input);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.similar) return { similar: e.similar };
        throw e;
      }
    },
    mergeSpeakers: (id: string, from: string, into: string) =>
      request<{ lines: number }>('POST', `/meetings/${id}/speakers/merge`, { from, into }),
    splitSpeaker: (id: string, lineIndex: number) =>
      request<{ newSpeaker: string }>('POST', `/meetings/${id}/speakers/split`, { lineIndex }),
    reassignLine: (id: string, lineIndex: number, toDiar: string) =>
      request<{ lines: number }>('POST', `/meetings/${id}/lines/reassign`, { lineIndex, toDiar }),
    reidentify: (id: string) =>
      request<{ changes: { speaker: string; person: string; score: number }[]; warnings: string[] }>(
        'POST',
        `/meetings/${id}/speakers/reidentify`,
      ),
  },
  glossary: {
    get: () => request<{ entries: GlossaryEntry[] }>('GET', '/glossary').then((r) => r.entries),
    put: (entries: GlossaryEntry[]) =>
      request<{ entries: GlossaryEntry[] }>('PUT', '/glossary', { entries }).then((r) => r.entries),
  },
  workspace: {
    settings: () =>
      request<{ settings: WorkspaceSettings }>('GET', '/workspace/settings').then(
        (r) => r.settings,
      ),
    saveSettings: (settings: WorkspaceSettings) =>
      request<{ settings: WorkspaceSettings }>('PUT', '/workspace/settings', settings).then(
        (r) => r.settings,
      ),
    rotateAccessCode: (code: string) =>
      request<{ token: string }>('POST', '/workspace/access-code', { code }),
  },
  speakers: {
    list: () => request<{ speakers: Speaker[] }>('GET', '/speakers').then((r) => r.speakers),
    enrol: (name: string, audio: File) => {
      const form = new FormData();
      form.append('name', name);
      form.append('audio', audio);
      return request<{ speaker: Speaker }>('POST', '/speakers/enrol', form).then((r) => r.speaker);
    },
    remove: (id: string) => request<void>('DELETE', `/speakers/${id}`),
  },
  audit: {
    list: () =>
      request<{
        meetings: { id: string; title: string; seeded: boolean; items: number; answered: number; named: number }[];
      }>('GET', '/audit').then((r) => r.meetings),
    seed: (id: string) => request<{ seeded: boolean; items: number }>('POST', `/audit/${id}/seed`, {}),
    get: (id: string) =>
      request<{
        meeting: { id: string; title: string; playbackUrl: string | null };
        clusters: AuditCluster[];
        items: AuditItemView[];
      }>('GET', `/audit/${id}`),
    saveNaming: (id: string, names: Record<string, string>, sameAs: Record<string, string>) =>
      request<{ ok: boolean }>('PUT', `/audit/${id}/naming`, { names, sameAs }),
    answer: (id: string, itemId: string, answer: { speaker?: string; text?: string }) =>
      request<{ ok: boolean }>('PATCH', `/audit/${id}/items/${itemId}`, answer),
    results: () =>
      request<{ methods: AuditTally[]; shortLines: AuditTally[]; note: string }>('GET', '/audit/results/all'),
  },
  benchmark: {
    run: (meetingIds: string[], engines: BenchmarkEngineName[], evalSetName?: string) =>
      request<{ run: EvalRun }>('POST', '/benchmark/run', {
        meetingIds,
        engines,
        evalSetName,
      }).then((r) => r.run),
    runs: () => request<{ runs: EvalRun[] }>('GET', '/benchmark/runs').then((r) => r.runs),
    get: (id: string) =>
      request<{ run: EvalRun }>('GET', `/benchmark/runs/${id}`).then((r) => r.run),
    promote: (name: string, meetingIds: string[]) =>
      request<{ evalSet: { id: string; name: string; size: number } }>(
        'POST',
        '/benchmark/eval-sets',
        { name, meetingIds },
      ),
  },
  health: () =>
    request<{ ok: boolean; db: string; worker: { lastHeartbeat: string | null } }>(
      'GET',
      '/health',
    ),
};
