import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ status: vi.fn(), save: vi.fn(), setFolder: vi.fn() }));
vi.mock('@/api/client', () => ({
  api: {
    drive: { status: (...a) => h.status(...a) },
    meetings: { saveToDrive: (...a) => h.save(...a), setFolder: (...a) => h.setFolder(...a) },
  },
}));
vi.mock('@/lib/keptStore', () => ({
  useKeptOptional: () => ({ folders: ['Jolto', 'Internal', 'Consultant'] }),
}));

import MeetingDrive from '@/components/kept/MeetingDrive';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const meeting = { id: 'm1', title: 'Vendor meeting', folder: 'Jolto', drive: null };
const show = (m = meeting, onChange = vi.fn(), hasTranscript = true) => {
  render(
    <MemoryRouter>
      <MeetingDrive meeting={m} hasTranscript={hasTranscript} onChange={onChange} />
    </MemoryRouter>,
  );
  return onChange;
};

describe('Save to Drive on a meeting (client request, 20 Oct)', () => {
  it('saves to Drive and links to the Doc', async () => {
    h.status.mockResolvedValue({ available: true, connected: true, email: 'heet@kisna.in' });
    const saved = {
      ...meeting,
      drive: {
        fileId: 'd1',
        url: 'https://docs.google.com/document/d/d1/edit',
        folder: 'Jolto',
        savedAt: '2026-10-21T10:00:00Z',
      },
    };
    h.save.mockResolvedValue(saved);
    const onChange = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Save to Drive' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(saved));
    expect(h.save).toHaveBeenCalledWith('m1');

    cleanup();
    show(saved);
    expect(await screen.findByRole('button', { name: 'Save to Drive again' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open in Drive/ }).getAttribute('href')).toBe(
      saved.drive.url,
    );
  });

  it('says to save again after the folder changed', async () => {
    h.status.mockResolvedValue({ available: true, connected: true, email: null });
    show({
      ...meeting,
      folder: 'Internal',
      drive: { fileId: 'd1', url: 'u', folder: 'Jolto', savedAt: '2026-10-21T10:00:00Z' },
    });
    expect(await screen.findByText(/save again to move it/)).toBeTruthy();
  });

  it('sends to Settings when Drive is not connected, and waits for the transcript', async () => {
    h.status.mockResolvedValue({ available: true, connected: false, email: null });
    show();
    expect(
      (await screen.findByRole('link', { name: /Connect Google Drive/ })).getAttribute('href'),
    ).toBe('/settings');

    cleanup();
    h.status.mockResolvedValue({ available: true, connected: true, email: null });
    show(meeting, vi.fn(), false);
    expect((await screen.findByRole('button', { name: 'Save to Drive' })).disabled).toBe(true);
  });

  it('files the meeting under another folder', async () => {
    h.status.mockResolvedValue({ available: false, connected: false, email: null });
    h.setFolder.mockResolvedValue({ ...meeting, folder: 'Consultant' });
    const onChange = show();
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: 'Consultant' } });
    await waitFor(() => expect(h.setFolder).toHaveBeenCalledWith('m1', 'Consultant'));
    expect(onChange).toHaveBeenCalledWith({ ...meeting, folder: 'Consultant' });
    // no Drive button when the server has no Google sign-in set up
    expect(screen.queryByRole('button', { name: /Save to Drive/ })).toBeNull();
  });
});
