import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  speakers: {
    list: vi.fn(),
    samples: vi.fn(),
    useSample: vi.fn(),
    removeSample: vi.fn(),
    restoreSample: vi.fn(),
    enrol: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock('@/api/client', () => ({ api }));
vi.mock('@/components/EnrollmentRecorder', () => ({ default: () => null }));

import Speakers from '@/pages/Speakers';

const harshit = {
  id: 'p1',
  name: 'Harshit Google DV360',
  hasVoiceprint: true,
  voiceprintCount: 3,
  enrollmentAudioUrl: null,
  createdAt: '2026-10-07T00:00:00Z',
};
const base = {
  removed: false,
  main: false,
  meetingConfirmed: false,
  source: 'meeting',
  createdAt: 'x',
};
// sample 1 is the voice in use; 2 and 3 are spares
const samples = [
  {
    ...base,
    main: true,
    index: 0,
    key: 'k0',
    meetingId: 'm1',
    meetingTitle: 'AOM Meeting part 1',
    start: 109.75,
    end: 134.67,
    seconds: 24.9,
    audioUrl: 'https://a.test/aom.mp3',
  },
  {
    ...base,
    meetingConfirmed: true,
    index: 1,
    key: 'k1',
    meetingId: 'm2',
    meetingTitle: 'Google DV',
    start: 152.13,
    end: 177.13,
    seconds: 25,
    audioUrl: 'https://a.test/dv.mp3',
  },
  {
    ...base,
    index: 2,
    key: 'k2',
    meetingId: 'm3',
    meetingTitle: 'NDPF',
    start: 10,
    end: 30,
    seconds: 20,
    audioUrl: 'https://a.test/ndpf.mp3',
  },
];
const withMain = (k) => samples.map((s) => ({ ...s, main: s.key === k }));

const render1 = () =>
  render(
    <MemoryRouter>
      <Speakers />
    </MemoryRouter>,
  );
const openVoice = async () => {
  const view = render1();
  fireEvent.click(await screen.findByText(/Listen to voice/));
  await screen.findByRole('button', { name: /Play sample 1 of Harshit/ });
  return view;
};
const openSpares = async () => {
  const view = await openVoice();
  fireEvent.click(screen.getByRole('button', { name: /Change voice/ }));
  return view;
};

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

describe('the one voice a person is recognised by (28 Oct)', () => {
  it('offers to listen to the voice of a person who has one, and nothing for a person without', async () => {
    render1();
    expect(await screen.findByText(/Listen to voice/)).toBeTruthy();
    expect(screen.getAllByText(/Listen to voice/)).toHaveLength(1);
    expect(api.speakers.samples).not.toHaveBeenCalled();
  });

  it('shows the one voice in use, and keeps the other clips out of sight', async () => {
    await openVoice();
    expect(screen.getByText('In use')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Play sample 2 of Harshit/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change voice (2 other clips)' })).toBeTruthy();
    // the voice in use cannot be removed or swapped for itself
    expect(screen.queryByRole('button', { name: /Remove sample 1 of Harshit/ })).toBeNull();
    expect(api.speakers.samples).toHaveBeenCalledWith('p1');
  });

  it('shows no change button for a person with only one clip', async () => {
    api.speakers.samples.mockResolvedValue([samples[0]]);
    await openVoice();
    expect(screen.queryByRole('button', { name: /Change voice/ })).toBeNull();
  });

  it('lists the other clips with their meeting and place, and links to that moment', async () => {
    await openSpares();
    expect(screen.getByRole('button', { name: /Play sample 2 of Harshit/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Play sample 3 of Harshit/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Google DV' }).getAttribute('href')).toBe(
      '/meetings/m2?t=152',
    );
    // the clip in use (24.9 s) and the spare (25 s) both show as 25 s
    expect(screen.getAllByText('25 s')).toHaveLength(2);
    expect(screen.getByText(/Only the clip marked/)).toBeTruthy();
  });

  it('plays a clip from its own start in that meeting’s recording and stops at its end', async () => {
    const { container } = await openSpares();
    fireEvent.click(screen.getByRole('button', { name: /Play sample 2 of Harshit/ }));
    const el = container.querySelector('audio');
    expect(el.getAttribute('src')).toBe('https://a.test/dv.mp3');
    fireEvent(el, new Event('loadedmetadata'));
    expect(el.currentTime).toBeCloseTo(152.13);
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Stop sample 2/ })).toBeTruthy();
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

  it('says when a recording is gone, and does not let that clip be chosen unheard', async () => {
    api.speakers.samples.mockResolvedValue([
      samples[0],
      {
        ...base,
        index: 1,
        key: 'k1',
        meetingId: null,
        meetingTitle: null,
        start: 0,
        end: 7,
        seconds: 7,
        audioUrl: null,
      },
    ]);
    await openSpares();
    expect(screen.getByText('Recording no longer available')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Play sample 2 of Harshit/ }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: /Use sample 2 of Harshit/ }).disabled).toBe(true);
  });

  it('says so when the clips cannot be loaded', async () => {
    api.speakers.samples.mockRejectedValue(new Error('boom'));
    render1();
    fireEvent.click(await screen.findByText(/Listen to voice/));
    expect(await screen.findByText(/Could not load the voice samples/)).toBeTruthy();
  });

  describe('changing the voice', () => {
    it('makes the chosen clip the voice in use and refreshes the page list', async () => {
      api.speakers.useSample.mockResolvedValue(withMain('k2'));
      await openSpares();
      fireEvent.click(screen.getByRole('button', { name: /Use sample 3 of Harshit/ }));
      await waitFor(() => expect(api.speakers.useSample).toHaveBeenCalledWith('p1', 'k2'));
      // the clip now in use is the one on top, and the old one is a spare
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /Use sample 1 of Harshit/ })).toBeTruthy(),
      );
      expect(screen.queryByRole('button', { name: /Use sample 3 of Harshit/ })).toBeNull();
      expect(screen.getByText('In use')).toBeTruthy();
      expect(api.speakers.list.mock.calls.length).toBeGreaterThan(1);
    });

    it('says nothing was changed when the call fails', async () => {
      api.speakers.useSample.mockRejectedValue(new Error('boom'));
      await openSpares();
      fireEvent.click(screen.getByRole('button', { name: /Use sample 2 of Harshit/ }));
      expect(await screen.findByText(/Nothing was changed/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Use sample 2 of Harshit/ })).toBeTruthy();
    });
  });

  describe('removing a spare clip', () => {
    it('asks first, naming the clip, and changes nothing until confirmed', async () => {
      await openSpares();
      fireEvent.click(screen.getByRole('button', { name: /Remove sample 3 of Harshit/ }));
      const dialog = await screen.findByRole('alertdialog');
      expect(dialog.textContent).toContain('NDPF');
      expect(dialog.textContent).toContain('20 s');
      expect(dialog.textContent).toContain('Names already on past meetings do not change');
      expect(dialog.textContent).toContain('You can restore it');
      expect(api.speakers.removeSample).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(api.speakers.removeSample).not.toHaveBeenCalled();
    });

    it('removes only that clip and greys it out with Restore', async () => {
      api.speakers.removeSample.mockResolvedValue([
        samples[0],
        samples[1],
        { ...samples[2], removed: true },
      ]);
      await openSpares();
      fireEvent.click(screen.getByRole('button', { name: /Remove sample 3 of Harshit/ }));
      await screen.findByRole('alertdialog');
      expect(screen.getByRole('checkbox').checked).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await waitFor(() =>
        expect(api.speakers.removeSample).toHaveBeenCalledWith('p1', 'k2', {
          ignoreMeeting: false,
        }),
      );
      expect(
        await screen.findByRole('button', { name: /Restore sample 3 of Harshit/ }),
      ).toBeTruthy();
      expect(screen.getByText('Removed')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Use sample 3 of Harshit/ })).toBeNull();
    });

    it('offers to ignore the rest of that meeting, ticked when its voice was confirmed as this person', async () => {
      api.speakers.removeSample.mockResolvedValue(samples);
      await openSpares();
      fireEvent.click(screen.getByRole('button', { name: /Remove sample 2 of Harshit/ }));
      await screen.findByRole('alertdialog');
      expect(screen.getByRole('checkbox').checked).toBe(true);
      expect(screen.getByRole('alertdialog').textContent).toContain('was confirmed as this person');
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await waitFor(() =>
        expect(api.speakers.removeSample).toHaveBeenCalledWith('p1', 'k1', { ignoreMeeting: true }),
      );
    });

    it('restores a removed clip', async () => {
      api.speakers.samples.mockResolvedValue([
        samples[0],
        samples[1],
        { ...samples[2], removed: true },
      ]);
      api.speakers.restoreSample.mockResolvedValue(samples);
      await openSpares();
      fireEvent.click(screen.getByRole('button', { name: /Restore sample 3 of Harshit/ }));
      await waitFor(() => expect(api.speakers.restoreSample).toHaveBeenCalledWith('p1', 'k2'));
      expect(await screen.findByRole('button', { name: /Remove sample 3 of Harshit/ })).toBeTruthy();
    });

    it('says nothing was changed when the call fails', async () => {
      api.speakers.removeSample.mockRejectedValue(new Error('boom'));
      await openSpares();
      fireEvent.click(screen.getByRole('button', { name: /Remove sample 3 of Harshit/ }));
      await screen.findByRole('alertdialog');
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      expect(await screen.findByText(/Nothing was changed/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Remove sample 3 of Harshit/ })).toBeTruthy();
    });
  });

  it('says the person will not be recognised when no clip is in use', async () => {
    api.speakers.samples.mockResolvedValue(
      samples.map((s) => ({ ...s, main: false, removed: true })),
    );
    render1();
    fireEvent.click(await screen.findByText(/Listen to voice/));
    expect(
      await screen.findByText(/will not be recognised until a new voice is learned/),
    ).toBeTruthy();
  });
});
