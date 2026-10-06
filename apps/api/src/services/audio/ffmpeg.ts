import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Segment } from '@meetingid/shared';
import { env } from '../../config/env.js';
import { FatalError } from '../../pipeline/errors.js';

const require = createRequire(import.meta.url);

// Binaries ship as npm packages (@ffmpeg-installer/*), so nothing is downloaded at install time.
// FFMPEG_PATH / FFPROBE_PATH override them (e.g. a system ffmpeg in a Docker image).
function ffmpegPath(): string {
  return env().FFMPEG_PATH ?? (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
}
function ffprobePath(): string {
  return env().FFPROBE_PATH ?? (require('@ffprobe-installer/ffprobe') as { path: string }).path;
}

function run(
  bin: string,
  args: string[],
  timeoutMs = 20 * 60_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin.split(/[\\/]/).pop()} exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

export interface ProbeResult {
  durationSec: number;
  channels: number;
  sampleRate: number;
  codec: string;
}

export async function probe(path: string): Promise<ProbeResult> {
  let out: string;
  try {
    ({ stdout: out } = await run(ffprobePath(), [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-select_streams',
      'a',
      path,
    ]));
  } catch (err) {
    throw new FatalError(
      `The audio format is not supported (${(err as Error).message.slice(0, 200)})`,
    );
  }
  const data = JSON.parse(out) as {
    streams?: { channels?: number; sample_rate?: string; codec_name?: string; duration?: string }[];
    format?: { duration?: string };
  };
  const stream = data.streams?.[0];
  if (!stream) throw new FatalError('No speech detected: the file has no audio stream');
  const durationSec = Number.parseFloat(data.format?.duration ?? stream.duration ?? '');
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    channels: stream.channels ?? 1,
    sampleRate: Number.parseInt(stream.sample_rate ?? '0', 10) || 0,
    codec: stream.codec_name ?? 'unknown',
  };
}

/** 16 kHz mono FLAC: what every engine receives. */
export async function toAnalysisFlac(input: string, output: string): Promise<void> {
  await run(ffmpegPath(), [
    '-y',
    '-hide_banner',
    '-i',
    input,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'flac',
    output,
  ]);
}

/**
 * Exact duration by decoding (container durations from browser recordings are often missing or
 * wrong, which is what produced "no playable audio" for valid files).
 */
export async function decodedDuration(path: string): Promise<number> {
  const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-i', path, '-f', 'null', '-']);
  const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = matches.at(-1);
  if (!last) return 0;
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

/** Silences from ffmpeg silencedetect (`noise=-35dB:d=0.8`). */
export async function detectSilences(
  path: string,
  noiseDb = -35,
  minSilenceSec = 0.8,
): Promise<Segment[]> {
  const { stderr } = await run(ffmpegPath(), [
    '-hide_banner',
    '-i',
    path,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    '-f',
    'null',
    '-',
  ]);
  return parseSilencedetect(stderr);
}

export function parseSilencedetect(stderr: string): Segment[] {
  const out: Segment[] = [];
  let start: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  // Silence running to the end of the file has a start but no end.
  if (start !== null) out.push({ start, end: Number.POSITIVE_INFINITY });
  return out;
}

/** Cut [startSec, endSec) out of a FLAC file into a new FLAC file. */
export async function cutFlac(
  input: string,
  output: string,
  startSec: number,
  endSec: number,
): Promise<void> {
  await run(ffmpegPath(), [
    '-y',
    '-hide_banner',
    '-ss',
    startSec.toFixed(3),
    '-i',
    input,
    '-t',
    (endSec - startSec).toFixed(3),
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'flac',
    output,
  ]);
}
