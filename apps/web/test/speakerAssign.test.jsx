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

const person = (id, name, email, role) => ({
  id,
  name,
  anonymous: false,
  hasVoiceprint: true,
  email,
  role,
  leftAt: null,
  enrollmentAudioUrl: null,
  createdAt: '2026-10-01T00:00:00.000Z',
});
const amit = (id, email, role) => person(id, 'Amit', email, role);

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

const pencil = (name = 'Speaker A (Meeting Post)') =>
  screen.getByRole('button', { name: `Assign ${name} to a person` });
const people = () => [
  voice,
  amit('sales', 'a@kisna.test', 'Sales'),
  person('ops', 'Rohan Mehta', 'b@kisna.test', 'Ops'),
];
const page = (speakers, canAssignSpeakers = true, undos = []) =>
  api.speakers.page.mockResolvedValue({ speakers, canAssignSpeakers, undos });
const preview = (target) => ({
  needsConfirmation: true,
  action: 'merge',
  undoMinutes: 10,
  meetings: 2,
  source: { id: 'voice-1', name: voice.name },
  target,
});

describe('Speakers assign controls', () => {
  it('shows no pencil when this person is not on the allowlist', async () => {
    page([voice], false);
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    expect(screen.queryByRole('button', { name: /to a person/ })).toBeNull();
  });

  it('has a pencil after each name that opens a search list drawn by the app, not a native select', async () => {
    page(people());
    const { container } = render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    expect(screen.getAllByRole('button', { name: /to a person/ })).toHaveLength(3);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(pencil());
    const list = await screen.findByRole('listbox');
    // the others, with email or role beside the name; not the voice itself
    expect(list.textContent).toContain('Amit');
    expect(list.textContent).toContain('a@kisna.test');
    expect(list.textContent).toContain('Rohan Mehta');
    expect(list.textContent).not.toContain('Speaker A (Meeting Post)');
    expect(screen.getByRole('button', { name: /Add new/ })).toBeTruthy();
    expect(screen.getByPlaceholderText('Search a person…')).toBeTruthy();
    expect(document.querySelector('select')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
  });

  it('filters by name, email and role as you type, and says when no one matches', async () => {
    page(people());
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    fireEvent.click(pencil());
    const box = await screen.findByPlaceholderText('Search a person…');
    const names = () => screen.getAllByRole('option').map((o) => o.textContent);
    fireEvent.change(box, { target: { value: 'roh' } });
    expect(names()).toEqual(['Rohan Mehtab@kisna.test']);
    fireEvent.change(box, { target: { value: 'A@KISNA' } });
    expect(names()).toEqual(['Amita@kisna.test']);
    fireEvent.change(box, { target: { value: 'sales' } });
    expect(names()).toEqual(['Amita@kisna.test']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No one matches “zzz”/)).toBeTruthy();
  });

  it('choosing a person describes the change first, and writes only when confirmed', async () => {
    page(people());
    api.speakers.assign.mockResolvedValue(
      preview({ id: 'ops', name: 'Rohan Mehta', email: 'b@kisna.test', role: 'Ops' }),
    );
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    fireEvent.click(pencil());
    fireEvent.click(await screen.findByRole('option', { name: /Rohan Mehta/ }));
    await waitFor(() =>
      expect(api.speakers.assign).toHaveBeenCalledWith('voice-1', { personId: 'ops' }),
    );
    expect(await screen.findByText(/You can undo this for 10 minutes/)).toBeTruthy();
    // the picker is closed and nothing was confirmed yet
    expect(screen.queryByRole('listbox')).toBeNull();
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

  it('Enter in the search picks the first match', async () => {
    page(people());
    api.speakers.assign.mockResolvedValue(preview({ id: 'ops', name: 'Rohan Mehta' }));
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    fireEvent.click(pencil());
    const box = await screen.findByPlaceholderText('Search a person…');
    fireEvent.change(box, { target: { value: 'roh' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() =>
      expect(api.speakers.assign).toHaveBeenCalledWith('voice-1', { personId: 'ops' }),
    );
  });

  it('"Add new" asks for a name, starts from what was typed, and blocks an empty one', async () => {
    page(people());
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    fireEvent.click(pencil());
    fireEvent.change(await screen.findByPlaceholderText('Search a person…'), {
      target: { value: 'Parag S' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Add new/ }));
    const input = await screen.findByLabelText('New name for Speaker A (Meeting Post)');
    expect(input.value).toBe('Parag S');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText('Enter a name.')).toBeTruthy();
    expect(api.speakers.assign).not.toHaveBeenCalled();
    // Back returns to the search
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByPlaceholderText('Search a person…')).toBeTruthy();
  });

  it('offers to merge when the new name already exists', async () => {
    page([voice, amit('sales', 'a@kisna.test', 'Sales')]);
    api.speakers.assign.mockResolvedValue({
      matches: [{ id: 'sales', name: 'Amit', email: 'a@kisna.test', role: 'Sales' }],
    });
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    fireEvent.click(pencil());
    fireEvent.click(await screen.findByRole('button', { name: /Add new/ }));
    fireEvent.change(await screen.findByLabelText('New name for Speaker A (Meeting Post)'), {
      target: { value: '  Amit ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(await screen.findByText(/already saved/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge into Amit · a@kisna.test' })).toBeTruthy();
    expect(api.speakers.assign).toHaveBeenCalledWith('voice-1', { name: '  Amit ' });
  });

  it('shows a refusal in words, with the picker still open', async () => {
    page(people());
    api.speakers.assign.mockRejectedValue(
      new Error('A meeting is being processed. Try again when it has finished.'),
    );
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    fireEvent.click(pencil());
    fireEvent.click(await screen.findByRole('option', { name: /Rohan Mehta/ }));
    expect(await screen.findByText(/being processed/)).toBeTruthy();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('keeps Mark as left for a named person and has no Assign button any more', async () => {
    page(people());
    render(<Speakers />);
    await screen.findByText('Speaker A (Meeting Post)');
    expect(screen.queryByRole('button', { name: 'Assign to' })).toBeNull();
    // a placeholder voice is not someone who left
    expect(screen.getAllByRole('button', { name: 'Mark as left' })).toHaveLength(2);
  });

  it('marks someone who left as back, after asking', async () => {
    const left = { ...person('p', 'Parag', 'p@kisna.test', 'Sales'), leftAt: '2026-10-20T00:00:00Z' };
    page([left]);
    api.speakers.comeBack.mockResolvedValue({ leftAt: null });
    render(<Speakers />);
    await screen.findByText('Parag');
    expect(screen.queryByRole('button', { name: 'Mark as left' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as back' }));
    expect(await screen.findByText(/will match Parag’s voice again/)).toBeTruthy();
    expect(api.speakers.comeBack).not.toHaveBeenCalled();
    page([{ ...left, leftAt: null }]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Mark as back' }).at(-1));
    await waitFor(() => expect(api.speakers.comeBack).toHaveBeenCalledWith('p'));
    expect(await screen.findByRole('button', { name: 'Mark as left' })).toBeTruthy();
  });

  it('says in words why an undo was refused', async () => {
    page(
      [voice],
      true,
      [{ id: 'u1', label: 'Merged A into B', expiresAt: '2026-10-01T00:10:00Z', kind: 'merge' }],
    );
    api.speakers.undo.mockRejectedValue(new Error('undo_newer_change'));
    render(<Speakers />);
    await screen.findByText('Merged A into B');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo', hidden: false }));
    expect(await screen.findByText(/Undo that one first/)).toBeTruthy();
    expect(screen.queryByText('undo_newer_change')).toBeNull();
  });
});
