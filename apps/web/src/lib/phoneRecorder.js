// PROTOTYPE: records raw microphone audio on a phone for a group recording. Echo cancellation, noise
// suppression and auto-gain are switched OFF (they would distort the level differences between
// phones that the mix and the speaker hints rely on). Audio is downsampled to 16 kHz mono and cut
// into independent 60-second WAV parts, so each part can be uploaded and decoded on its own.

export const TARGET_RATE = 16000;
export const PART_SECONDS = 60;

/** Streaming box-filter downsampler to 16 kHz. */
export class Downsampler {
  constructor(inRate) {
    this.ratio = inRate / TARGET_RATE;
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
  }
  push(input) {
    const out = [];
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        out.push(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
        this.pos -= this.ratio;
      }
    }
    return Float32Array.from(out);
  }
}

export function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(v * 32767);
  }
  return out;
}

/** 16-bit PCM mono WAV at 16 kHz. */
export function encodeWav(int16) {
  const buffer = new ArrayBuffer(44 + int16.length * 2);
  const view = new DataView(buffer);
  const write = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + int16.length * 2, true);
  write(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, int16.length * 2, true);
  new Int16Array(buffer, 44).set(int16);
  return new Blob([buffer], { type: 'audio/wav' });
}

export function levelDb(samples) {
  if (!samples.length) return -100;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.max(-100, 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-5));
}

export class PhoneRecorder {
  /**
   * onLevel(db) is called continuously once the microphone is open.
   * onPart({ index, wav: Blob, startSample, samples }) when a 60 s part is complete (and for the last, shorter one).
   * onFirstSample(clientMs) when the first kept sample arrives (best estimate of when it was captured).
   */
  constructor({ onLevel, onPart, onFirstSample }) {
    this.onLevel = onLevel;
    this.onPart = onPart;
    this.onFirstSample = onFirstSample;
    this.recording = false;
    this.buffer = [];
    this.buffered = 0;
    this.emitted = 0;
    this.index = 0;
  }

  async open() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    this.down = new Downsampler(this.ctx.sampleRate);
    const source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor is old but works in every mobile browser; a worklet needs a separate module file.
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // keep the graph running without playing the microphone back
    this.proc.onaudioprocess = (e) => this.handle(e.inputBuffer.getChannelData(0));
    source.connect(this.proc);
    this.proc.connect(mute);
    mute.connect(this.ctx.destination);
  }

  handle(input) {
    const samples = this.down.push(input);
    this.onLevel?.(levelDb(samples));
    if (!this.recording || !samples.length) return;
    if (this.buffered === 0 && this.emitted === 0 && this.index === 0 && !this.started) {
      this.started = true;
      // the buffer was captured just before now; subtract its length and the input latency
      const chunkMs = (input.length / this.ctx.sampleRate) * 1000;
      this.onFirstSample?.(Date.now() - chunkMs - (this.ctx.baseLatency || 0) * 1000);
    }
    this.buffer.push(samples);
    this.buffered += samples.length;
    while (this.buffered >= PART_SECONDS * TARGET_RATE) this.cut(PART_SECONDS * TARGET_RATE);
  }

  /** Take `count` samples (or all) from the buffer as one part. */
  cut(count) {
    const all = new Float32Array(this.buffered);
    let o = 0;
    for (const b of this.buffer) {
      all.set(b, o);
      o += b.length;
    }
    const part = all.subarray(0, Math.min(count, all.length));
    const rest = all.subarray(part.length);
    this.buffer = rest.length ? [Float32Array.from(rest)] : [];
    this.buffered = rest.length;
    const startSample = this.emitted;
    this.emitted += part.length;
    const index = this.index++;
    this.onPart?.({ index, wav: encodeWav(toInt16(part)), startSample, samples: part.length });
  }

  begin() {
    this.recording = true;
  }

  /** The samples of the unfinished part, for saving locally every couple of seconds. */
  snapshot() {
    if (!this.buffered) return null;
    const all = new Float32Array(this.buffered);
    let o = 0;
    for (const b of this.buffer) {
      all.set(b, o);
      o += b.length;
    }
    return { index: this.index, startSample: this.emitted, pcm: toInt16(all) };
  }

  /** Stop recording, hand over the last (shorter) part, and release the microphone. */
  stop() {
    this.recording = false;
    if (this.buffered > 0) this.cut(this.buffered);
  }

  close() {
    this.recording = false;
    this.proc?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
  }
}

// ---- tiny IndexedDB store so a reload or crash does not lose audio that was not uploaded yet ----

const DB = 'meetingid-phone';
function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('parts');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('parts', mode);
    const result = fn(t.objectStore('parts'));
    t.oncomplete = () => resolve(result.result);
    t.onerror = () => reject(t.error);
  });
}
export const partStore = {
  put: (key, value) => tx('readwrite', (s) => s.put(value, key)).catch(() => {}),
  del: (key) => tx('readwrite', (s) => s.delete(key)).catch(() => {}),
  keys: () => tx('readonly', (s) => s.getAllKeys()).catch(() => []),
  get: (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined),
};
