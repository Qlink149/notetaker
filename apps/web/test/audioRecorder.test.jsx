import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The saved copy on the phone (IndexedDB) is replaced by memory so the tests can look inside it.
const store = vi.hoisted(() => ({ meta: null, chunks: [], cleared: 0 }));
vi.mock('@/lib/recordingStore', () => ({
  saveChunk: vi.fn(async (blob, seq) => void store.chunks.push({ seq, blob })),
  setMeta: vi.fn(async (m) => void (store.meta = m)),
  getMeta: vi.fn(async () => store.meta),
  getAllChunks: vi.fn(async () => store.chunks),
  clearRecording: vi.fn(async () => {
    store.cleared++;
    store.meta = null;
    store.chunks = [];
  }),
}));

import AudioRecorder from '@/components/AudioRecorder';

// ---- fake browser ----
const mic = { level: 0.2, track: null, recorders: [], getUserMedia: vi.fn() };
class FakeRecorder {
  constructor() {
    this.state = 'inactive';
    this.mimeType = 'audio/webm';
    mic.recorders.push(this);
  }
  start() {
    this.state = 'recording';
    this.ondataavailable?.({ data: new Blob(['abc']) });
  }
  requestData() {}
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  async stop() {
    this.state = 'inactive';
    await this.onstop?.();
  }
}
class FakeAudioContext {
  resume() {
    return Promise.resolve();
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData: (buf) => buf.fill(mic.level) };
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  close() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  store.meta = null;
  store.chunks = [];
  store.cleared = 0;
  mic.level = 0.2;
  mic.recorders = [];
  mic.track = { stop: vi.fn() };
  mic.getUserMedia = vi.fn(async () => ({ getTracks: () => [mic.track] }));
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: (...a) => mic.getUserMedia(...a) },
    configurable: true,
  });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  window.AudioContext = FakeAudioContext;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const tick = (ms) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
async function start(onComplete = vi.fn()) {
  render(<AudioRecorder onComplete={onComplete} />);
  await tick(0);
  fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
  await screen.findByText('Recording');
  return onComplete;
}
const closePage = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe('recording survives until the upload is confirmed', () => {
  it('keeps the saved copy after Stop and hands over a file marked as recorded here', async () => {
    const onComplete = await start();
    await tick(2000);
    expect(store.cleared).toBe(1); // only the clean-up before starting
    fireEvent.click(screen.getByRole('button', { name: /Stop & save/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const [file, info] = onComplete.mock.calls[0];
    expect(file.recorded).toBe(true);
    expect(info.stoppedEarly).toBe(false);
    expect(store.cleared).toBe(1); // the copy is still there
    expect(store.chunks.length).toBeGreaterThan(0);
    expect(store.meta).toMatchObject({ active: false, pending: true });
  });

  it('offers a recording that was never uploaded, keeps it when chosen, and discards it on request', async () => {
    store.meta = {
      id: 'current',
      active: false,
      pending: true,
      duration: 3725,
      ts: 1,
      mime: 'audio/webm',
    };
    store.chunks = [{ seq: 0, blob: new Blob(['abc']) }];
    const onComplete = vi.fn();
    const { unmount } = render(<AudioRecorder onComplete={onComplete} />);
    await screen.findByText(/not uploaded yet was found \(62:05\)/);
    fireEvent.click(screen.getByRole('button', { name: /Keep recording/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(onComplete.mock.calls[0][0].recorded).toBe(true);
    expect(store.cleared).toBe(0); // kept until the upload is confirmed
    unmount();

    render(<AudioRecorder onComplete={vi.fn()} />);
    await screen.findByText(/not uploaded yet was found/);
    fireEvent.click(screen.getByRole('button', { name: /Discard/ }));
    await waitFor(() => expect(store.cleared).toBe(1));
    expect(screen.queryByText(/not uploaded yet was found/)).toBeNull();
  });

  it('still reports an interrupted recording as interrupted', async () => {
    store.meta = {
      id: 'current',
      active: true,
      pending: false,
      duration: 600,
      ts: Date.now() - 120_000,
    };
    store.chunks = [{ seq: 0, blob: new Blob(['abc']) }];
    render(<AudioRecorder onComplete={vi.fn()} />);
    await screen.findByText(/A recording was interrupted \(10:00\)/);
  });
});

describe('two tabs on one phone', () => {
  it('does not call a recording running in another tab "interrupted", and refuses to wipe it', async () => {
    store.meta = {
      id: 'current',
      active: true,
      pending: false,
      duration: 600,
      ts: Date.now() - 2000,
    };
    store.chunks = [{ seq: 0, blob: new Blob(['abc']) }];
    render(<AudioRecorder onComplete={vi.fn()} />);
    await tick(0);
    expect(screen.queryByText(/interrupted/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
    await screen.findByText(/already running in another tab/);
    expect(mic.getUserMedia).not.toHaveBeenCalled();
    expect(store.cleared).toBe(0);
  });
});

describe('while recording', () => {
  it('shows the microphone level, warns after 10 s of silence and clears when sound returns', async () => {
    await start();
    expect(screen.getByRole('meter', { name: /Microphone level/ })).toBeTruthy();
    mic.level = 0;
    await tick(9000);
    expect(screen.queryByText(/No sound for 10 seconds/)).toBeNull();
    await tick(2000);
    expect(screen.getByText(/No sound for 10 seconds/)).toBeTruthy();
    mic.level = 0.2;
    await tick(1000);
    expect(screen.queryByText(/No sound for 10 seconds/)).toBeNull();
  });

  it('tells the person when a call or another app takes the microphone, and when it is back', async () => {
    await start();
    act(() => mic.track.onmute());
    expect(screen.getByText(/The microphone was interrupted/)).toBeTruthy();
    act(() => mic.track.onunmute());
    expect(screen.queryByText(/The microphone was interrupted/)).toBeNull();
  });

  it('says so when the recording ends without Stop being pressed, and still hands over what was captured', async () => {
    const onComplete = await start();
    await tick(5000);
    await act(async () => {
      await mic.recorders[0].stop(); // the browser ended it: the microphone was taken away
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    const [file, info] = onComplete.mock.calls[0];
    expect(file.recorded).toBe(true);
    expect(info.stoppedEarly).toBe(true);
    expect(info.seconds).toBeGreaterThan(4);
  });

  it('asks before the page is closed while recording, and not afterwards', async () => {
    const onComplete = await start();
    expect(closePage()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Stop & save/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    await tick(0);
    expect(closePage()).toBe(false);
  });
});
