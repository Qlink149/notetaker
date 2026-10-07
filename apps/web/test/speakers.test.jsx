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

const renderReview = (cards, extra = {}) =>
  render(
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

describe('speaker cards', () => {
  it('shows who the voice matches, where else it is heard, the closest phone and playable samples', () => {
    const onPlay = vi.fn();
    renderReview([card()], { onPlay });
    expect(screen.getByText(/Same voice as/)).toBeTruthy();
    expect(screen.getByText('Speaker D (Meeting 21/9)')).toBeTruthy();
    expect(screen.getByText(/match score 78/)).toBeTruthy();
    expect(screen.getByText(/Also heard in/)).toBeTruthy();
    expect(screen.getByText(/Mostly closest to/)).toBeTruthy();
    expect(screen.getByText('Confident')).toBeTruthy();
    const play = screen.getAllByRole('button', { name: /Play sample/ });
    expect(play).toHaveLength(2);
    fireEvent.click(play[1]);
    expect(onPlay).toHaveBeenCalledWith(300, 312);
  });

  it('warns plainly when the speaker labels are not voice-based', () => {
    renderReview([card({ match: null, appearsIn: [], phone: null })], { source: 'text-fallback' });
    expect(screen.getByText(/matching text between recording chunks/)).toBeTruthy();
    expect(screen.queryByText('Re-identify speakers')).toBeNull();
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
    const select = screen.getAllByLabelText(/Merge Speaker B into/)[0];
    fireEvent.change(select, { target: { value: 'SPEAKER_02' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Merge/ })[0]);
    await waitFor(() =>
      expect(api.meetings.mergeSpeakers).toHaveBeenCalledWith('m1', 'SPEAKER_01', 'SPEAKER_02'),
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

  it('moves one line to another speaker, and splits a speaker from a line', async () => {
    const onReassign = vi.fn().mockResolvedValue(undefined);
    const onSplit = vi.fn().mockResolvedValue(undefined);
    render(
      <TranscriptView
        lines={lines}
        speakers={speakers}
        onReassign={onReassign}
        onSplit={onSplit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Speaker B: change who said this/ }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'S0' } });
    await waitFor(() => expect(onReassign).toHaveBeenCalledWith(1, 'S0'));
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
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'S1' } });
    await screen.findByText(/Could not find the speech/);
  });
});
