import { readFile } from 'node:fs/promises';
import type { Language } from '@meetingid/shared';
import { glossaryKeyterms, type RawTurn } from '@meetingid/pipeline';
import { requireEnv } from '../../config/env.js';
import { RetryableError, classify, errorForStatus } from '../../pipeline/errors.js';
import type { ChunkInput, ChunkResult, TranscriptionEngine } from './types.js';

// Ported from legacy/base44/shared/pipeline.ts `transcribeDeepgram`, now behind the engine interface.
const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const MODEL = 'nova-3';

interface DgWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  speaker?: number;
}
interface DgUtterance {
  transcript?: string;
  start: number;
  end: number;
  speaker?: number;
  words?: DgWord[];
}
interface DgResponse {
  metadata?: { duration?: number };
  results?: {
    utterances?: DgUtterance[];
    channels?: { detected_language?: string; alternatives?: { words?: DgWord[] }[] }[];
  };
}

/**
 * Language parameters from the workspace (Nova-3 supports hi, gu and en; one language per request):
 * one language → set it explicitly; several → per-chunk language detection. Nova-3 rejects a
 * restricted candidate list (`detect_language=hi&detect_language=gu` → 400, tested 2026-10-07).
 */
export function deepgramLanguageParams(languages: Language[]): [string, string][] {
  const langs = languages.length ? languages : (['hi', 'gu', 'en'] as Language[]);
  if (langs.length === 1) return [['language', langs[0]!]];
  return [['detect_language', 'true']];
}

const lang = (l: string): RawTurn['lang'] =>
  l.startsWith('en') ? 'en' : l.startsWith('gu') ? 'gu' : 'hi';

/** Fallback when utterances are missing or sparse: group words on gaps over 0.5 s. */
function utterancesFromWords(words: DgWord[]): DgUtterance[] {
  const out: DgUtterance[] = [];
  let cur: DgUtterance | null = null;
  for (const w of words) {
    if (cur && w.start - cur.end <= 0.5 && w.speaker === cur.speaker) {
      cur.words!.push(w);
      cur.end = w.end;
    } else {
      cur = { start: w.start, end: w.end, speaker: w.speaker, words: [w] };
      out.push(cur);
    }
  }
  for (const u of out) u.transcript = u.words!.map((w) => w.punctuated_word ?? w.word).join(' ');
  return out;
}

export function deepgramToTurns(data: DgResponse, language: string): RawTurn[] {
  const utterances = data.results?.utterances ?? [];
  const metaDuration = data.metadata?.duration ?? 0;
  const uttDuration = utterances.reduce((s, u) => s + (u.end - u.start), 0);
  const coverage = metaDuration > 0 ? uttDuration / metaDuration : 1;
  const source =
    utterances.length > 0 && coverage > 0.3
      ? utterances
      : utterancesFromWords(data.results?.channels?.[0]?.alternatives?.[0]?.words ?? []);
  return source
    .filter((u) => u.transcript?.trim())
    .map((u) => ({
      speaker: `S${(u.speaker ?? 0) + 1}`,
      start: u.start,
      end: u.end,
      text_native: u.transcript!.trim(),
      text_roman: u.transcript!.trim(),
      lang: lang(language),
    }));
}

/** Fallback engine kept behind the workspace engine switch. */
export class DeepgramEngine implements TranscriptionEngine {
  readonly name = 'deepgram' as const;
  readonly accepts = ['url', 'path'] as ChunkInput['audio']['kind'][];

  async transcribeChunk(input: ChunkInput): Promise<ChunkResult> {
    const params = new URLSearchParams({
      model: MODEL,
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'true',
      diarize: 'true',
    });
    for (const [k, v] of deepgramLanguageParams(input.languages)) params.append(k, v);
    for (const t of glossaryKeyterms(input.glossary, 100)) params.append('keyterm', t);

    const headers: Record<string, string> = {
      Authorization: `Token ${requireEnv('DEEPGRAM_API_KEY')}`,
    };
    let body: string | Uint8Array;
    if (input.audio.kind === 'url') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ url: input.audio.url });
    } else if (input.audio.kind === 'path') {
      headers['Content-Type'] = input.audio.mimeType;
      body = new Uint8Array(await readFile(input.audio.path));
    } else {
      throw new RetryableError('DeepgramEngine cannot read a Gemini file', 'other');
    }

    let res: Response;
    try {
      res = await fetch(`${DEEPGRAM_URL}?${params}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(7 * 60_000),
      });
    } catch (err) {
      throw classify(err);
    }
    if (!res.ok) throw errorForStatus('deepgram', res.status, await res.text());
    const data = (await res.json()) as DgResponse;
    const language =
      params.get('language') ?? data.results?.channels?.[0]?.detected_language ?? 'auto';
    return {
      turns: deepgramToTurns(data, language),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        audioSec: data.metadata?.duration ?? input.endSec - input.startSec,
      },
      model: `${MODEL}/${language}`,
      finish: 'complete',
    };
  }
}
