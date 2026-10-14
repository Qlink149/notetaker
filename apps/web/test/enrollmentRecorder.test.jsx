import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EnrollmentRecorder from '@/components/EnrollmentRecorder';

let proc;
beforeEach(() => {
  proc = null;
  const track = { stop: vi.fn() };
  navigator.mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }),
  };
  window.AudioContext = class {
    sampleRate = 16000;
    destination = {};
    resume() {}
    close() {
      return Promise.resolve();
    }
    createGain() {
      return { gain: {}, connect() {} };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createScriptProcessor() {
      proc = { connect() {}, disconnect() {}, onaudioprocess: null };
      return proc;
    }
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('voice sample recorder', () => {
  it('records into a WAV file that plays on every phone', async () => {
    const onComplete = vi.fn();
    render(<EnrollmentRecorder onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
    await screen.findByText(/Recording/);
    for (let i = 0; i < 20; i++) {
      proc.onaudioprocess({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) },
      });
    }
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 25000);
    const stop = await screen.findByRole('button', { name: 'Stop & save' }, { timeout: 2000 });
    fireEvent.click(stop);
    expect(onComplete).toHaveBeenCalledTimes(1);
    const f = onComplete.mock.calls[0][0];
    expect(f.type).toBe('audio/wav');
    expect(f.name).toMatch(/\.wav$/);
  });

  it('takes an uploaded clip instead and refuses other file types', () => {
    const onComplete = vi.fn();
    const { container } = render(<EnrollmentRecorder onComplete={onComplete} />);
    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' })] },
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText(/not supported/)).toBeTruthy();
    fireEvent.change(input, {
      target: { files: [new File(['x'.repeat(4096)], 'voice.m4a', { type: '' })] },
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
