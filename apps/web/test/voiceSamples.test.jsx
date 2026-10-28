import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  speakers: { list: vi.fn(), samples: vi.fn(), enrol: vi.fn(), remove: vi.fn() },
}));
vi.mock('@/api/client', () => ({ api }));
vi.mock('@/components/EnrollmentRecorder', () => ({ default: () => null }));

import Speakers from '@/pages/Speakers';

const harshit = {
  id: 'p1',
  name: 'Harshit Google DV360',
  hasVoiceprint: true,
  voiceprintCount: 2,
  enrollmentAudioUrl: null,
  createdAt: '2026-10-07T00:00:00Z',
};
const samples = [
  {
    index: 0,
    source: 'meeting',
    createdAt: 'x',
    meetingId: 'm1',
    meetingTitle: 'AOM Meeting part 1',
    start: 109.75,
    end: 134.67,
    seconds: 24.9,
    audioUrl: 'https://a.test/aom.mp3',
  },
  {
    index: 1,
    source: 'meeting',
    createdAt: 'x',
    meetingId: 'm2',
    meetingTitle: 'Google DV',
    start: 152.13,
    end: 177.13,
    seconds: 25,
    audioUrl: 'https://a.test/dv.mp3',
  },
];

const render1 = () =>
  render(
    <MemoryRouter>
      <Speakers />
    </MemoryRouter>,
  );

let play;
let pause;
beforeEach(() => {
  api.speakers.list.mockResolvedValue([
    harshit,
    { ...harshit, id: 'p2', name: 'No Voice', hasVoiceprint: false, voiceprintCount: 0 },
  ]);
  api.speakers.samples.mockResolvedValue(samples);
  play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(window.HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('listening to a person’s voice samples (28 Oct)', () => {
  it('shows how many samples a person has and nothing for a person without one', async () => {
    render1();
    expect(await screen.findByText(/Listen to voice samples \(2\)/)).toBeTruthy();
    expect(screen.getAllByText(/voice samples/i)).toHaveLength(1);
    expect(api.speakers.samples).not.toHaveBeenCalled();
  });

  it('lists every sample with its meeting and place, and links to that moment', async () => {
    render1();
    fireEvent.click(await screen.findByText(/Listen to voice samples/));
    expect(await screen.findByRole('button', { name: /Play sample 1 of Harshit/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Play sample 2 of Harshit/ })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Google DV' });
    expect(link.getAttribute('href')).toBe('/meetings/m2?t=152');
    // 24.9 s and 25 s both show as 25 s
    expect(screen.getAllByText('25 s')).toHaveLength(2);
    expect(api.speakers.samples).toHaveBeenCalledWith('p1');
  });

  it('plays a sample from its own start in that meeting’s recording and stops at its end', async () => {
    const { container } = render1();
    fireEvent.click(await screen.findByText(/Listen to voice samples/));
    fireEvent.click(await screen.findByRole('button', { name: /Play sample 2 of Harshit/ }));
    const el = container.querySelector('audio');
    expect(el.getAttribute('src')).toBe('https://a.test/dv.mp3');
    fireEvent(el, new Event('loadedmetadata'));
    expect(el.currentTime).toBeCloseTo(152.13);
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Stop sample 2/ })).toBeTruthy();
    // before the end it keeps playing, at the end it stops
    el.currentTime = 170;
    fireEvent.timeUpdate(el);
    expect(pause).not.toHaveBeenCalled();
    el.currentTime = 177.2;
    fireEvent.timeUpdate(el);
    expect(pause).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Play sample 2 of Harshit/ })).toBeTruthy(),
    );
  });

  it('switches to another sample’s recording and says when a recording is gone', async () => {
    api.speakers.samples.mockResolvedValue([
      ...samples,
      {
        index: 2,
        source: 'meeting',
        createdAt: 'x',
        meetingId: null,
        meetingTitle: null,
        start: 0,
        end: 7,
        seconds: 7,
        audioUrl: null,
      },
    ]);
    const { container } = render1();
    fireEvent.click(await screen.findByText(/Listen to voice samples/));
    fireEvent.click(await screen.findByRole('button', { name: /Play sample 1 of Harshit/ }));
    expect(container.querySelector('audio').getAttribute('src')).toBe('https://a.test/aom.mp3');
    fireEvent.click(screen.getByRole('button', { name: /Play sample 2 of Harshit/ }));
    expect(container.querySelector('audio').getAttribute('src')).toBe('https://a.test/dv.mp3');
    expect(screen.getByText('Recording no longer available')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Play sample 3 of Harshit/ }).disabled).toBe(true);
  });

  it('says so when the samples cannot be loaded', async () => {
    api.speakers.samples.mockRejectedValue(new Error('boom'));
    render1();
    fireEvent.click(await screen.findByText(/Listen to voice samples/));
    expect(await screen.findByText(/Could not load the voice samples/)).toBeTruthy();
  });
});
