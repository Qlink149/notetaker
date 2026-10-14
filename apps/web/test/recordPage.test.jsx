import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  cleared: vi.fn(),
  order: [],
  recorderInfo: { stoppedEarly: true, seconds: 754 },
}));

vi.mock('@/api/client', () => ({
  api: {
    workspace: { settings: vi.fn().mockResolvedValue({ languages: ['hi'], engine: 'gemini' }) },
    meetings: { create: (...a) => h.create(...a) },
  },
}));
vi.mock('@/lib/cloudinaryUpload', async (orig) => ({
  ...(await orig()),
  getUploadSignature: vi.fn().mockResolvedValue({ meetingId: 'm1' }),
  uploadToCloudinary: vi.fn().mockResolvedValue({ publicId: 'p', url: 'b2://p' }),
  validateAudioFile: vi.fn(() => null),
}));
vi.mock('@/lib/recordingStore', () => ({ clearRecording: (...a) => h.cleared(...a) }));
// the recorder flow is kept working for when live recording is switched back on
vi.mock('@/lib/features', () => ({
  FEATURES: { liveRecording: true, insights: true, benchmark: true },
}));
vi.mock('@/components/GroupRecording', () => ({ default: () => null }));
// the recorder itself is covered in audioRecorder.test.jsx: here it just hands over a file
vi.mock('@/components/AudioRecorder', () => ({
  default: ({ onComplete }) => (
    <>
      <button
        onClick={() =>
          onComplete(
            Object.assign(new File(['x'.repeat(2048)], 'r.webm', { type: 'audio/webm' }), {
              recorded: true,
            }),
            h.recorderInfo,
          )
        }
      >
        make recording
      </button>
      <button
        onClick={() => onComplete(new File(['x'.repeat(2048)], 'u.mp3', { type: 'audio/mpeg' }))}
      >
        pick file
      </button>
    </>
  ),
}));

import Record from '@/pages/Record';

beforeEach(() => {
  h.order.length = 0;
  h.create.mockImplementation(async () => {
    h.order.push('create');
    return { id: 'm1' };
  });
  h.cleared.mockImplementation(async () => void h.order.push('clear'));
  URL.createObjectURL = vi.fn(() => 'blob:x');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const open = () =>
  render(
    <MemoryRouter initialEntries={['/record']}>
      <Routes>
        <Route path="/record" element={<Record />} />
        <Route path="/meetings/:id" element={<p>meeting page</p>} />
      </Routes>
    </MemoryRouter>,
  );
const closePage = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

describe('new meeting page', () => {
  it("drops the phone's saved copy of a recording only after the meeting was created", async () => {
    open();
    fireEvent.click(await screen.findByText('make recording'));
    fireEvent.click(screen.getByRole('button', { name: /Process meeting/ }));
    await screen.findByText('meeting page');
    expect(h.order).toEqual(['create', 'clear']);
  });

  it('keeps the saved copy when creating the meeting fails', async () => {
    h.create.mockRejectedValueOnce(new Error('server down'));
    open();
    fireEvent.click(await screen.findByText('make recording'));
    fireEvent.click(screen.getByRole('button', { name: /Process meeting/ }));
    await screen.findByText(/server down/);
    expect(h.cleared).not.toHaveBeenCalled();
  });

  it('leaves an uploaded file alone: nothing saved on the phone to clear', async () => {
    open();
    fireEvent.click(await screen.findByText('pick file'));
    fireEvent.click(screen.getByRole('button', { name: /Process meeting/ }));
    await screen.findByText('meeting page');
    expect(h.cleared).not.toHaveBeenCalled();
  });

  it('says when the recording stopped by itself, and how far it got', async () => {
    open();
    fireEvent.click(await screen.findByText('make recording'));
    const note = await screen.findByRole('alert');
    expect(note.textContent).toContain('stopped by itself at 12:34');
  });

  it('asks before leaving while a recording waits to be uploaded, but not for an uploaded file', async () => {
    open();
    expect(closePage()).toBe(false);
    fireEvent.click(await screen.findByText('make recording'));
    await waitFor(() => expect(closePage()).toBe(true));
    cleanup();
    open();
    fireEvent.click(await screen.findByText('pick file'));
    await screen.findByRole('button', { name: /Process meeting/ });
    expect(closePage()).toBe(false);
  });
});
