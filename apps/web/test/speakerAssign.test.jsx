import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  speakers: {
    page: vi.fn(),
    enrol: vi.fn(),
    remove: vi.fn(),
    assign: vi.fn(),
    leave: vi.fn(),
    comeBack: vi.fn(),
    undo: vi.fn(),
  },
}));
vi.mock('@/api/client', () => ({ api }));
vi.mock('@/components/EnrollmentRecorder', () => ({ default: () => null }));

import Speakers from '@/pages/Speakers';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const amit = (id, email, role) => ({
  id,
  name: 'Amit',
  anonymous: false,
  hasVoiceprint: true,
  email,
  role,
  leftAt: null,
  enrollmentAudioUrl: null,
  createdAt: '2026-10-01T00:00:00.000Z',
});

const voice = {
  id: 'voice-1',
  name: 'Speaker A (Meeting Post)',
  anonymous: true,
  hasVoiceprint: true,
  email: null,
  role: null,
  leftAt: null,
  enrollmentAudioUrl: null,
  createdAt: '2026-10-01T00:00:00.000Z',
};

describe('Speakers assign controls', () => {
  it('hides assign when this person is not on the allowlist', async () => {
    api.speakers.page.mockResolvedValue({
      speakers: [voice],
      canAssignSpeakers: false,
      undos: [],
    });
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    expect(screen.queryByRole('button', { name: 'Assign to' })).toBeNull();
  });

  it('lists same-name people by email and asks before merging', async () => {
    api.speakers.page.mockResolvedValue({
      speakers: [voice, amit('sales', 'a@kisna.test', 'Sales'), amit('ops', 'b@kisna.test', 'Ops')],
      canAssignSpeakers: true,
      undos: [],
    });
    api.speakers.assign.mockResolvedValue({
      needsConfirmation: true,
      action: 'merge',
      undoMinutes: 10,
      meetings: 2,
      source: { id: 'voice-1', name: voice.name },
      target: { id: 'ops', name: 'Amit', email: 'b@kisna.test', role: 'Ops' },
    });
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    fireEvent.click(screen.getAllByRole('button', { name: 'Assign to' })[0]);
    const select = screen.getByLabelText('Assign Speaker A (Meeting Post) to');
    const labels = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(labels).toContain('Amit · a@kisna.test');
    expect(labels).toContain('Amit · b@kisna.test');
    expect(labels).toContain('Add new');
    fireEvent.change(select, { target: { value: 'ops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() =>
      expect(api.speakers.assign).toHaveBeenCalledWith('voice-1', { personId: 'ops' }),
    );
    expect(await screen.findByText(/You can undo this for 10 minutes/)).toBeTruthy();
    expect(api.speakers.assign).toHaveBeenCalledTimes(1);
    api.speakers.assign.mockResolvedValue({
      needsConfirmation: false,
      action: 'merge',
      undoId: 'u1',
      expiresAt: '2026-10-01T00:10:00.000Z',
      undoMinutes: 10,
      meetings: ['m1'],
      label: 'Merged',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(api.speakers.assign).toHaveBeenCalledWith('voice-1', {
        personId: 'ops',
        confirm: true,
      }),
    );
  });

  it('blocks an empty new name and offers to merge when the name exists', async () => {
    api.speakers.page.mockResolvedValue({
      speakers: [voice, amit('sales', 'a@kisna.test', 'Sales')],
      canAssignSpeakers: true,
      undos: [],
    });
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    fireEvent.click(screen.getAllByRole('button', { name: 'Assign to' })[0]);
    fireEvent.change(screen.getByLabelText('Assign Speaker A (Meeting Post) to'), {
      target: { value: '__new__' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText('Enter a name.')).toBeTruthy();
    expect(api.speakers.assign).not.toHaveBeenCalled();

    api.speakers.assign.mockResolvedValue({
      matches: [{ id: 'sales', name: 'Amit', email: 'a@kisna.test', role: 'Sales' }],
    });
    fireEvent.change(screen.getByLabelText('New name for Speaker A (Meeting Post)'), {
      target: { value: '  Amit ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(await screen.findByText(/already saved/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge into Amit · a@kisna.test' })).toBeTruthy();
    expect(api.speakers.assign).toHaveBeenCalledWith('voice-1', { name: '  Amit ' });
  });

  it('marks someone who left as back, after asking', async () => {
    const left = { ...amit('p', 'p@kisna.test', 'Sales'), name: 'Parag', leftAt: '2026-10-20T00:00:00Z' };
    api.speakers.page.mockResolvedValue({ speakers: [left], canAssignSpeakers: true, undos: [] });
    api.speakers.comeBack.mockResolvedValue({ leftAt: null });
    render(<Speakers />);
    await screen.findByText('Parag');
    expect(screen.queryByRole('button', { name: 'Mark as left' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as back' }));
    expect(await screen.findByText(/will match Parag’s voice again/)).toBeTruthy();
    expect(api.speakers.comeBack).not.toHaveBeenCalled();
    api.speakers.page.mockResolvedValue({
      speakers: [{ ...left, leftAt: null }],
      canAssignSpeakers: true,
      undos: [],
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark as back' }).at(-1));
    await waitFor(() => expect(api.speakers.comeBack).toHaveBeenCalledWith('p'));
    expect(await screen.findByRole('button', { name: 'Mark as left' })).toBeTruthy();
  });

  it('says in words why an undo was refused', async () => {
    api.speakers.page.mockResolvedValue({
      speakers: [voice],
      canAssignSpeakers: true,
      undos: [{ id: 'u1', label: 'Merged A into B', expiresAt: '2026-10-01T00:10:00Z', kind: 'merge' }],
    });
    api.speakers.undo.mockRejectedValue(new Error('undo_newer_change'));
    render(<Speakers />);
    await screen.findByText('Merged A into B');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo', hidden: false }));
    expect(await screen.findByText(/Undo that one first/)).toBeTruthy();
    expect(screen.queryByText('undo_newer_change')).toBeNull();
  });
});
