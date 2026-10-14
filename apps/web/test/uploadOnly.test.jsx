import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real feature switches are used here: live recording, Insights and Benchmark are all off.
const h = vi.hoisted(() => ({ create: vi.fn(), upload: vi.fn() }));
vi.mock('@/api/client', () => ({
  api: {
    workspace: { settings: vi.fn().mockResolvedValue({ languages: ['hi'], engine: 'gemini' }) },
    meetings: { create: (...a) => h.create(...a) },
  },
}));
vi.mock('@/lib/cloudinaryUpload', async (orig) => ({
  ...(await orig()),
  getUploadSignature: vi.fn().mockResolvedValue({ meetingId: 'm1' }),
  uploadToCloudinary: (...a) => h.upload(...a),
  validateAudioFile: vi.fn(() => null),
}));

import Layout from '@/components/Layout';
import Record from '@/pages/Record';

beforeEach(() => {
  h.create.mockResolvedValue({ id: 'm1' });
  h.upload.mockResolvedValue({ publicId: 'p', url: 'b2://p' });
  URL.createObjectURL = vi.fn(() => 'blob:x');
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openRecord = () =>
  render(
    <MemoryRouter initialEntries={['/record']}>
      <Routes>
        <Route path="/record" element={<Record />} />
        <Route path="/meetings/:id" element={<p>meeting page</p>} />
      </Routes>
    </MemoryRouter>,
  );

describe('new meeting page while live recording is not offered', () => {
  it('offers upload only and says live recording is a prototype', async () => {
    openRecord();
    await screen.findByText('Upload audio file');
    expect(screen.getByTestId('recording-prototype-note').textContent).toMatch(
      /Live recording from the dashboard is in the prototype stage/,
    );
    expect(screen.queryByRole('button', { name: /Start recording/ })).toBeNull();
    expect(screen.queryByText(/group recording/i)).toBeNull();
  });

  it('still takes a file through to a created meeting', async () => {
    const { container } = openRecord();
    await screen.findByText('Upload audio file');
    const input = container.querySelector('input[type="file"]');
    expect(input.getAttribute('accept')).toContain('.m4a');
    fireEvent.change(input, {
      target: { files: [new File(['x'.repeat(2048)], 'memo.m4a', { type: 'audio/x-m4a' })] },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Process meeting/ }));
    await screen.findByText('meeting page');
    expect(h.upload).toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ meetingId: 'm1' }));
  });
});

describe('navigation while those parts are off', () => {
  it('shows Meetings, Upload, Speakers and Settings, and not Record, Insights or Benchmark', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<p>home</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('home')).toBeTruthy());
    const labels = screen.getAllByRole('link').map((a) => a.textContent);
    expect(labels).toEqual(['Meetings', 'Upload', 'Speakers', 'Settings']);
  });
});
