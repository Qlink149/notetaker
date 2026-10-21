import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real feature switches are used here: live recording, Insights and Benchmark are all off.
const h = vi.hoisted(() => ({ create: vi.fn(), upload: vi.fn() }));
vi.mock('@/api/client', () => ({
  api: {
    workspace: { settings: vi.fn().mockResolvedValue({ languages: ['hi'], engine: 'gemini' }) },
    meetings: { create: (...a) => h.create(...a) },
    tasks: { list: vi.fn().mockResolvedValue([]), suggestions: vi.fn().mockResolvedValue([]) },
    speakers: { list: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ workspace: { mePersonId: null }, updateWorkspace: vi.fn(), logout: vi.fn() }),
}));
vi.mock('@/lib/cloudinaryUpload', async (orig) => ({
  ...(await orig()),
  getUploadSignature: vi.fn().mockResolvedValue({ meetingId: 'm1' }),
  uploadToCloudinary: (...a) => h.upload(...a),
  validateAudioFile: vi.fn(() => null),
}));

import Layout from '@/components/Layout';
import Record from '@/pages/Record';
import Today from '@/pages/Today';

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

  it('takes one meeting in several files, in the order chosen (client request, 20 Oct)', async () => {
    const { getUploadSignature } = await import('@/lib/cloudinaryUpload');
    h.upload.mockImplementation(async (f) => ({
      publicId: `p/${f.name}`,
      url: `b2://p/${f.name}`,
    }));
    const { container } = openRecord();
    await screen.findByText('Upload audio file');
    const input = container.querySelector('input[type="file"]');
    expect(input.multiple).toBe(true);
    const at = (name, t) =>
      new File(['x'.repeat(2048)], name, { type: 'audio/x-m4a', lastModified: t });
    // picked out of order: put in recording order (oldest first)
    fireEvent.change(input, { target: { files: [at('second.m4a', 2000), at('first.m4a', 1000)] } });
    const list = await screen.findByTestId('parts');
    expect(list.textContent).toMatch(/One meeting in 2 files/);
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      expect.stringContaining('first.m4a'),
      expect.stringContaining('second.m4a'),
    ]);
    // the person swaps them
    fireEvent.click(screen.getByRole('button', { name: 'Move part 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: /Process meeting/ }));
    await screen.findByText('meeting page');

    expect(h.upload).toHaveBeenCalledTimes(2);
    // the second file is signed into the first file's meeting folder
    expect(getUploadSignature).toHaveBeenNthCalledWith(2, 'm1');
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: 'm1',
        publicId: 'p/second.m4a',
        parts: [
          { publicId: 'p/second.m4a', url: 'b2://p/second.m4a', fileName: 'second.m4a' },
          { publicId: 'p/first.m4a', url: 'b2://p/first.m4a', fileName: 'first.m4a' },
        ],
      }),
    );
  });

  it('removing a part back to one file shows the single-file preview again', async () => {
    const { container } = openRecord();
    await screen.findByText('Upload audio file');
    const at = (name, t) =>
      new File(['x'.repeat(2048)], name, { type: 'audio/x-m4a', lastModified: t });
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [at('a.m4a', 1), at('b.m4a', 2)] },
    });
    await screen.findByTestId('parts');
    fireEvent.click(screen.getByRole('button', { name: 'Remove part 2' }));
    await waitFor(() => expect(screen.queryByTestId('parts')).toBeNull());
    expect(screen.getByText(/a\.m4a/)).toBeTruthy();
    expect(screen.getByTestId('add-part')).toBeTruthy();
  });
});

describe('navigation while those parts are off', () => {
  it('shows the Kept tab bar, and Speakers and Settings (not Insights or Benchmark) under the profile', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Today />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(
      [...nav.querySelectorAll('a')].map((a) => a.textContent || a.getAttribute('aria-label')),
    ).toEqual(['Today', 'Meetings', 'New meeting', 'Team', 'Search']);
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }));
    const sheet = await screen.findByRole('dialog');
    expect([...sheet.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Speakers (voice directory)',
      'Settings',
    ]);
  });
});
