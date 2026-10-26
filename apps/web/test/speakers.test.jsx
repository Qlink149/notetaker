import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  meetings: {
    nameSpeaker: vi.fn(),
    mergeSpeakers: vi.fn(),
    reidentify: vi.fn(),
  },
}));
vi.mock('@/api/client', () => ({ api }));

import SpeakerReview from '@/components/SpeakerReview';
import TranscriptView from '@/components/TranscriptView';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const card = (over = {}) => ({
  diar: 'SPEAKER_01',
  label: 'Speaker B',
  displayName: 'Speaker B',
  personId: 'p1',
  personName: 'Speaker B (Meeting AOM)',
  anonymous: true,
  voiceprints: 0,
  speakerSec: 288.6,
  turns: 40,
  status: 'solid',
  match: { personId: 'p9', name: 'Speaker D (Meeting 21/9)', score: 78, margin: 11 },
  candidate: null,
  clips: [
    { start: 12, end: 24, quality: 90 },
    { start: 300, end: 312, quality: 88 },
  ],
  phone: { name: 'Anil', attributed: 30, total: 40 },
  appearsIn: [
    { meetingId: 'm2', title: '21/9', label: 'Speaker D', displayName: 'Speaker D', score: 78 },
  ],
  ...over,
});

// The section starts closed; most tests are about what is inside, so they open it first.
const renderReview = (cards, { closed = false, ...extra } = {}) => {
  const view = render(
    <MemoryRouter>
      <SpeakerReview
        meetingId="m1"
        source="pyannote"
        cards={cards}
        onPlay={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
        {...extra}
      />
    </MemoryRouter>,
  );
  if (!closed) fireEvent.click(screen.getByRole('button', { name: /^Speakers/ }));
  return view;
};

describe('speaker section', () => {
  it('is closed by default and shows no speaker count', () => {
    renderReview(
      [card(), card({ diar: 'SPEAKER_02', label: 'Speaker B', displayName: 'Speaker B' })],
      {
        closed: true,
      },
    );
    const toggle = screen.getByRole('button', { name: /^Speakers/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Speakers');
    expect(screen.queryByText(/\(2\)/)).toBeNull();
    expect(screen.queryByText(/Same voice as/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Re-identify speakers/ })).toBeNull();
  });

  it('shows the count and the cards once opened, and closes again', () => {
    renderReview(
      [card(), card({ diar: 'SPEAKER_02', label: 'Speaker B', displayName: 'Speaker B' })],
      {
        closed: true,
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Speakers/ }));
    expect(
      screen.getByRole('button', { name: /^Speakers \(2\)/ }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: /Re-identify speakers/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Speakers/ }));
    expect(screen.getByRole('button', { name: /^Speakers$/ })).toBeTruthy();
    expect(screen.queryByText(/\(2\)/)).toBeNull();
  });
});

describe('speaker cards', () => {
  it('shows who the voice matches, where else it is heard, the closest phone and playable samples', () => {
    const onPlay = vi.fn();
    renderReview([card()], { onPlay });
    expect(screen.getByText(/Same voice as/)).toBeTruthy();
    expect(screen.getByText('Speaker D (Meeting 21/9)')).toBeTruthy();
    expect(screen.getByText(/match score 78/)).toBeTruthy();
    expect(screen.getByText(/Also heard in/)).toBeTruthy();
    expect(screen.getByText(/Mostly closest to/)).toBeTruthy();
    expect(screen.getByText('Matched by voice')).toBeTruthy();
    const play = screen.getAllByRole('button', { name: /Play sample/ });
    expect(play).toHaveLength(2);
    fireEvent.click(play[1]);
    expect(onPlay).toHaveBeenCalledWith(300, 312);
  });

  it('jumps to a clip and can move that clip to a saved person without the rest of the group', async () => {
    const onPlay = vi.fn();
    const onLocate = vi.fn();
    const onAssignClip = vi.fn().mockResolvedValue(undefined);
    renderReview([card()], {
      onPlay,
      onLocate,
      onAssignClip,
      people: [{ id: 'p-parag', name: 'Parag', anonymous: false }],
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Play sample/ })[0]);
    expect(onPlay).toHaveBeenCalledWith(12, 24);
    expect(onLocate).toHaveBeenCalledWith(12);
    fireEvent.click(screen.getByRole('button', { name: 'Move clip at 0:12' }));
    fireEvent.click(screen.getByRole('option', { name: 'Parag' }));
    await waitFor(() =>
      expect(onAssignClip).toHaveBeenCalledWith(expect.objectContaining({ start: 12, end: 24 }), {
        type: 'person',
        personId: 'p-parag',
        name: 'Parag',
      }),
    );
  });

  it('warns plainly when the speaker labels are not voice-based', () => {
    renderReview([card({ match: null, appearsIn: [], phone: null })], { source: 'text-fallback' });
    expect(screen.getByText(/matching text between recording chunks/)).toBeTruthy();
    expect(screen.queryByText('Re-identify speakers')).toBeNull();
  });

  it('names a voice from a saved person instead of typing a second profile', async () => {
    api.meetings.nameSpeaker.mockResolvedValue({ updatedMeetings: ['m1'] });
    renderReview([card({ match: null })], {
      people: [{ id: 'p-parag', name: 'Parag', anonymous: false }],
    });
    fireEvent.focus(screen.getByLabelText(/Name for Speaker B/));
    fireEvent.click(screen.getByRole('option', { name: 'Parag' }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenCalledWith('m1', 'SPEAKER_01', {
        name: 'Parag',
        usePersonId: 'p-parag',
      }),
    );
  });

  it('names a voice, reports where else it changed, and refreshes', async () => {
    api.meetings.nameSpeaker.mockResolvedValue({ updatedMeetings: ['m1', 'm2', 'm3'] });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    renderReview([card({ match: null })], { onChanged });
    fireEvent.change(screen.getByLabelText(/Name for Speaker B/), {
      target: { value: 'Ghanshyam Dholakia' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenCalledWith('m1', 'SPEAKER_01', {
        name: 'Ghanshyam Dholakia',
      }),
    );
    await waitFor(() => expect(screen.getByText(/Also updated in 2 other meetings/)).toBeTruthy());
    expect(onChanged).toHaveBeenCalled();
  });

  it('asks before creating a near-duplicate and can link to the existing person', async () => {
    api.meetings.nameSpeaker
      .mockResolvedValueOnce({ similar: [{ id: 'p-existing', name: 'Ghanshyam Dholakia' }] })
      .mockResolvedValueOnce({ updatedMeetings: ['m1'] });
    renderReview([card({ match: null })]);
    fireEvent.change(screen.getByLabelText(/Name for Speaker B/), {
      target: { value: 'Ghanshyam Dholkia' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await screen.findByText(/looks like someone you already have/);
    fireEvent.click(screen.getByRole('button', { name: /Yes, Ghanshyam Dholakia/ }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenLastCalledWith('m1', 'SPEAKER_01', {
        name: 'Ghanshyam Dholkia',
        usePersonId: 'p-existing',
      }),
    );
  });

  it('can keep the typed name as a different person', async () => {
    api.meetings.nameSpeaker
      .mockResolvedValueOnce({ similar: [{ id: 'p-existing', name: 'Rajesh Patel' }] })
      .mockResolvedValueOnce({ updatedMeetings: [] });
    renderReview([card({ match: null })]);
    fireEvent.change(screen.getByLabelText(/Name for Speaker B/), {
      target: { value: 'Rajesh Patal' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    fireEvent.click(await screen.findByRole('button', { name: /No, a different person/ }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenLastCalledWith('m1', 'SPEAKER_01', {
        name: 'Rajesh Patal',
        createNew: true,
      }),
    );
  });

  it('merges two voices of the same meeting', async () => {
    api.meetings.mergeSpeakers.mockResolvedValue({ lines: 5 });
    renderReview([
      card(),
      card({
        diar: 'SPEAKER_02',
        label: 'Speaker C',
        displayName: 'Speaker C',
        match: null,
        appearsIn: [],
        phone: null,
      }),
    ]);
    fireEvent.focus(screen.getAllByLabelText(/Merge Speaker B with/)[0]);
    fireEvent.click(screen.getByRole('option', { name: 'Speaker C' }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Merge$/ })[0]);
    await waitFor(() =>
      expect(api.meetings.mergeSpeakers).toHaveBeenCalledWith('m1', 'SPEAKER_01', 'SPEAKER_02'),
    );
  });

  it('merges with a saved person who is not a voice in this meeting', async () => {
    api.meetings.mergeSpeakers.mockResolvedValue({ lines: 4 });
    renderReview([card({ match: null, appearsIn: [], phone: null })], {
      people: [{ id: 'p-parag', name: 'Parag', anonymous: false }],
    });
    expect(screen.getByText(/combines the two identities/)).toBeTruthy();
    expect(screen.getByText(/asks before a second person is created/)).toBeTruthy();
    fireEvent.focus(screen.getByLabelText(/Merge Speaker B with/));
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
    fireEvent.click(screen.getByRole('option', { name: 'Parag' }));
    fireEvent.click(screen.getByRole('button', { name: /^Merge$/ }));
    await waitFor(() =>
      expect(api.meetings.mergeSpeakers).toHaveBeenCalledWith('m1', 'SPEAKER_01', {
        personId: 'p-parag',
      }),
    );
  });

  it('offers a near miss for one-click confirmation instead of naming it', async () => {
    api.meetings.nameSpeaker.mockResolvedValue({ updatedMeetings: ['m1'] });
    renderReview([
      card({
        match: null,
        status: 'new',
        candidate: { name: 'Paresh Ecom', personId: 'p-paresh', score: 62, status: 'possible' },
      }),
    ]);
    expect(screen.getByText(/Possibly/).textContent).toContain('Paresh Ecom');
    expect(screen.queryByText(/not confident enough to link/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Yes, it's Paresh Ecom/ }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenCalledWith('m1', 'SPEAKER_01', {
        name: 'Paresh Ecom',
        usePersonId: 'p-paresh',
      }),
    );
  });

  it('renames every meeting only when that box is ticked', async () => {
    api.meetings.nameSpeaker.mockResolvedValue({ updatedMeetings: ['m1', 'm2'] });
    renderReview([card({ match: null })]);
    expect(screen.getByText(/applies to this recording/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Rename in every meeting/ }));
    fireEvent.change(screen.getByLabelText(/Name for Speaker B/), {
      target: { value: 'Ghanshyam Dholakia' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenCalledWith('m1', 'SPEAKER_01', {
        name: 'Ghanshyam Dholakia',
        renameEverywhere: true,
      }),
    );
  });

  it('confirming a match does not rename the person in other meetings', async () => {
    api.meetings.nameSpeaker.mockResolvedValue({ updatedMeetings: ['m1'] });
    renderReview([card({ personId: 'p9' })]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Rename in every meeting/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenCalledWith('m1', 'SPEAKER_01', {
        name: 'Speaker D (Meeting 21/9)',
        usePersonId: 'p9',
      }),
    );
  });

  it('lets a person confirm an automatic match', async () => {
    api.meetings.nameSpeaker.mockResolvedValue({ updatedMeetings: ['m1'] });
    renderReview([card({ personId: 'p9' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenCalledWith('m1', 'SPEAKER_01', {
        name: 'Speaker D (Meeting 21/9)',
        usePersonId: 'p9',
      }),
    );
  });

  it('says a person chose the name, and drops the old "not confident" note', () => {
    renderReview([
      card({
        displayName: 'Paresh Ecom',
        anonymous: false,
        match: null,
        confirmed: true,
        candidate: { name: 'Paresh Ecom', score: 54, status: 'below-threshold' },
      }),
    ]);
    expect(screen.getByText('Named by hand')).toBeTruthy();
    expect(screen.queryByText('Matched by voice')).toBeNull();
    expect(screen.queryByText(/not confident enough to link/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.getByLabelText(/Name for Paresh Ecom/).getAttribute('placeholder')).toBe(
      'Search saved people, or type a new name',
    );
  });

  it('tells the truth when re-identifying is unavailable', async () => {
    api.meetings.reidentify.mockRejectedValue(
      new Error('Speaker recognition is unavailable: the pyannote account has no credits.'),
    );
    renderReview([card()]);
    fireEvent.click(screen.getByRole('button', { name: /Re-identify speakers/ }));
    await screen.findByText(/no credits/);
  });
});

describe('transcript editing', () => {
  const lines = [
    { speakerName: 'Speaker A', start: 1, end: 5, textRoman: 'aaj hum', textNative: 'आज हम' },
    { speakerName: 'Speaker B', start: 6, end: 9, textRoman: 'saru', textNative: 'સારું' },
  ];
  const speakers = [
    { diar: 'S0', displayName: 'Speaker A' },
    { diar: 'S1', displayName: 'Speaker B' },
  ];

  it('is read-only without edit handlers', () => {
    render(<TranscriptView lines={lines} />);
    expect(screen.queryByRole('button', { name: /change who said this/ })).toBeNull();
    expect(screen.getByText('aaj hum')).toBeTruthy();
  });

  it('moves one line to a meeting speaker, a saved person, or a new name', async () => {
    const onReassign = vi.fn().mockResolvedValue(undefined);
    const onSplit = vi.fn().mockResolvedValue(undefined);
    render(
      <TranscriptView
        lines={lines}
        speakers={speakers}
        people={[{ id: 'p-parag', name: 'Parag', anonymous: false }]}
        onReassign={onReassign}
        onSplit={onSplit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Speaker B: change who said this/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Speaker A' }));
    await waitFor(() =>
      expect(onReassign).toHaveBeenCalledWith(1, {
        type: 'speaker',
        diar: 'S0',
        name: 'Speaker A',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Speaker B: change who said this/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Parag' }));
    await waitFor(() =>
      expect(onReassign).toHaveBeenLastCalledWith(1, {
        type: 'person',
        personId: 'p-parag',
        name: 'Parag',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Speaker B: change who said this/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Hetal' } });
    fireEvent.click(screen.getByRole('option', { name: 'Create “Hetal”' }));
    await waitFor(() =>
      expect(onReassign).toHaveBeenLastCalledWith(1, { type: 'new', name: 'Hetal' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Speaker B: change who said this/ }));
    fireEvent.click(await screen.findByRole('button', { name: /different person from here on/ }));
    await waitFor(() => expect(onSplit).toHaveBeenCalledWith(1));
  });

  it('shows both scripts when asked', () => {
    render(<TranscriptView lines={lines} scriptMode="both" />);
    expect(screen.getByText('aaj hum')).toBeTruthy();
    expect(screen.getByText('आज हम')).toBeTruthy();
  });

  it('shows an error from a failed edit instead of closing silently', async () => {
    const onReassign = vi
      .fn()
      .mockRejectedValue(new Error('Could not find the speech of that line.'));
    render(<TranscriptView lines={lines} speakers={speakers} onReassign={onReassign} />);
    fireEvent.click(screen.getByRole('button', { name: /Speaker A: change who said this/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Speaker B' }));
    await screen.findByText(/Could not find the speech/);
  });
});
