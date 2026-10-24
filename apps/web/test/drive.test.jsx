import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  status: vi.fn(),
  save: vi.fn(),
  setFolder: vi.fn(),
  start: vi.fn(),
}));
vi.mock('@/api/client', () => ({
  api: {
    drive: { status: (...a) => h.status(...a), start: (...a) => h.start(...a) },
    meetings: { saveToDrive: (...a) => h.save(...a), setFolder: (...a) => h.setFolder(...a) },
  },
}));
vi.mock('@/lib/keptStore', () => ({
  useKeptOptional: () => ({ folders: ['Jolto', 'Internal', 'Consultant'] }),
}));

import MeetingDrive from '@/components/kept/MeetingDrive';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
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
    expect(h.start).not.toHaveBeenCalled();

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

  it('starts Google sign-in from the meeting when Drive is not connected', async () => {
    h.status.mockResolvedValue({ available: true, connected: false, email: null });
    h.start.mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=signed');
    show();
    expect(screen.queryByRole('link', { name: /Connect Google Drive/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Save to Drive' }));
    await waitFor(() =>
      expect(h.start).toHaveBeenCalledWith({ meetingId: 'm1', folder: 'Jolto' }),
    );
    expect(h.save).not.toHaveBeenCalled();
  });

  it('waits for the transcript before saving or connecting', async () => {
    h.status.mockResolvedValue({ available: true, connected: true, email: null });
    show(meeting, vi.fn(), false);
    expect((await screen.findByRole('button', { name: 'Save to Drive' })).disabled).toBe(true);
  });

  it('saves once when Google sends the meeting back, then drops the flag', async () => {
    h.status.mockResolvedValue({ available: true, connected: true, email: 'heet@kisna.in' });
    h.save.mockResolvedValue(meeting);
    window.history.replaceState(null, '', '/meetings/m1?drive=save');
    show();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save).toHaveBeenCalledWith('m1');
    expect(h.start).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('drive')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('does not save from the flag until the transcript is ready', async () => {
    h.status.mockResolvedValue({ available: true, connected: true, email: null });
    h.save.mockResolvedValue(meeting);
    window.history.replaceState(null, '', '/meetings/m1?drive=save');
    const { rerender } = render(
      <MemoryRouter>
        <MeetingDrive meeting={meeting} hasTranscript={false} onChange={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Save to Drive' });
    expect(h.save).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get('drive')).toBe('save');
    rerender(
      <MemoryRouter>
        <MeetingDrive meeting={meeting} hasTranscript onChange={vi.fn()} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(new URLSearchParams(window.location.search).get('drive')).toBeNull();
  });

  it('clears the flag without saving when Drive is still not connected', async () => {
    h.status.mockResolvedValue({ available: true, connected: false, email: null });
    window.history.replaceState(null, '', '/meetings/m1?drive=save');
    show();
    expect(await screen.findByRole('button', { name: 'Save to Drive' })).toBeTruthy();
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('drive')).toBeNull(),
    );
    expect(h.save).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('shows the error when an automatic save fails, and does not save again', async () => {
    h.status.mockResolvedValue({ available: true, connected: true, email: null });
    h.save.mockRejectedValue(new Error('Could not save to Drive.'));
    window.history.replaceState(null, '', '/meetings/m1?drive=save');
    show();
    expect(await screen.findByText('Could not save to Drive.')).toBeTruthy();
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save to Drive' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('starts sign-in again when the stored Google access was removed', async () => {
    h.status.mockResolvedValue({ available: true, connected: true, email: 'heet@kisna.in' });
    h.save.mockRejectedValue(new Error('drive_reconnect'));
    h.start.mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth?state=again');
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Save to Drive' }));
    await waitFor(() =>
      expect(h.start).toHaveBeenCalledWith({ meetingId: 'm1', folder: 'Jolto' }),
    );
    expect(screen.queryByText(/Settings/)).toBeNull();
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
