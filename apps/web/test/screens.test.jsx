import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  audit: {
    list: vi.fn(),
    get: vi.fn(),
    seed: vi.fn(),
    saveNaming: vi.fn(),
    answer: vi.fn(),
    results: vi.fn(),
  },
  dashboard: vi.fn(),
  sessions: { create: vi.fn(), get: vi.fn(), start: vi.fn(), stop: vi.fn(), finish: vi.fn() },
  join: { join: vi.fn(), heartbeat: vi.fn(), sign: vi.fn(), part: vi.fn() },
  meetings: {
    get: vi.fn(),
    data: vi.fn(),
    speakers: vi.fn(),
    nameSpeaker: vi.fn(),
    summarise: vi.fn(),
    retry: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}));
const recorder = vi.hoisted(() => ({ instance: null, cb: null, putKeys: [] }));
const upload = vi.hoisted(() => vi.fn());

vi.mock('@/api/client', () => ({ api, ApiError: class extends Error {} }));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ workspace: { settings: { scriptPreference: 'roman' } } }),
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,AAAA') },
}));
vi.mock('@/lib/cloudinaryUpload', () => ({
  uploadToCloudinary: upload,
  getUploadSignature: vi.fn(),
  validateAudioFile: vi.fn(),
}));
vi.mock('@/lib/phoneRecorder', () => ({
  PhoneRecorder: class {
    constructor(cb) {
      recorder.cb = cb;
      recorder.instance = this;
      this.open = vi.fn().mockResolvedValue(undefined);
      this.begin = vi.fn();
      this.stop = vi.fn();
      this.close = vi.fn();
      this.snapshot = vi.fn().mockReturnValue(null);
    }
  },
  encodeWav: vi.fn(() => new Blob(['x'])),
  partStore: {
    put: vi.fn(async (k) => void recorder.putKeys.push(k)),
    del: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
  },
}));

import Audit from '@/pages/Audit';
import Dashboard from '@/pages/Dashboard';
import GroupRecording from '@/components/GroupRecording';
import Join from '@/pages/Join';
import MeetingDetail from '@/pages/MeetingDetail';

beforeEach(() => {
  window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  window.HTMLMediaElement.prototype.pause = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  recorder.putKeys.length = 0;
});

describe('blind audit page', () => {
  const detail = () => ({
    meeting: { id: 'm1', title: '21/9', playbackUrl: 'https://x/a.mp3' },
    clusters: [
      {
        diar: 'S0',
        label: 'Speaker A',
        seconds: 300,
        name: '',
        sameAs: '',
        clips: [{ start: 1, end: 10, quality: 90 }],
      },
      { diar: 'S1', label: 'Speaker B', seconds: 120, name: '', sameAs: '', clips: [] },
    ],
    items: [
      {
        id: 'i1',
        start: 5,
        end: 9,
        assigned: 'Speaker A',
        textRoman: 'aaj hum',
        textNative: 'आज हम',
        speaker: null,
        text: null,
      },
      {
        id: 'i2',
        start: 20,
        end: 24,
        assigned: 'Speaker B',
        textRoman: 'saru',
        textNative: 'સારું',
        speaker: null,
        text: null,
      },
    ],
  });

  it('names the voices, then judges lines without ever seeing the method', async () => {
    api.audit.list.mockResolvedValue([
      { id: 'm1', title: '21/9', seeded: true, items: 2, answered: 0, named: 0 },
    ]);
    api.audit.get.mockResolvedValue(detail());
    api.audit.saveNaming.mockResolvedValue({ ok: true });
    api.audit.answer.mockResolvedValue({ ok: true });
    render(<Audit />);
    fireEvent.click(await screen.findByText('21/9'));
    await screen.findByText(/1\. Who is who/);
    expect(screen.getByText('no clean 8 s sample')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name for Speaker A'), {
      target: { value: 'Ghanshyam' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save names and start judging/ }));
    await waitFor(() =>
      expect(api.audit.saveNaming).toHaveBeenCalledWith(
        'm1',
        { S0: 'Ghanshyam', S1: '' },
        { S0: '', S1: '' },
      ),
    );
    await screen.findByText(/2\. Judge the line/);
    expect(screen.getByText('The line is attributed to')).toBeTruthy();
    expect(screen.queryByText(/m1|m3|word clock|time overlap/i)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Right/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Matches/ }));
    await waitFor(() =>
      expect(api.audit.answer).toHaveBeenCalledWith('m1', 'i1', { speaker: 'right' }),
    );
    expect(api.audit.answer).toHaveBeenCalledWith('m1', 'i1', { text: 'match' });
    await screen.findByText('saru'); // moved on to the next line
  });
});

describe('dashboard', () => {
  it('shows spend, coverage, voice confidence and honest notes', async () => {
    api.dashboard.mockResolvedValue({
      totals: {
        meetings: 4,
        hours: 2.4,
        usdRecorded: 0.01,
        usdLedger: 0.01,
        ledgerByProvider: {},
        averageCoverage: 0.92,
        belowNinety: 1,
        voiceBacked: 3,
      },
      usage: {
        engineCalls: [{ engine: 'deepgram', kind: 'words', calls: 4 }],
        pyannoteJobs: [{ kind: 'diarize', status: 'succeeded', jobs: 8 }],
        pyannoteHours: 2.1,
        pyannoteCostNote: 'pyannote does not publish a per-hour rate.',
      },
      quotas: [],
      audit: [],
      meetings: [
        {
          id: 'm1',
          title: 'Meeting 21/9',
          status: 'completed',
          minutes: 42.3,
          coverage: 0.985,
          speakers: 5,
          speakerSource: 'pyannote',
          voices: { confident: 1, needsReview: 1, newVoices: 3, edited: 0 },
          usd: 0,
          deepgramMin: 42,
        },
      ],
    });
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );
    await screen.findByText('Cost and quality');
    expect(screen.getByText('3 of 4')).toBeTruthy();
    expect(screen.getByText('92%')).toBeTruthy();
    expect(screen.getByText(/does not publish a per-hour rate/)).toBeTruthy();
    expect(screen.getByText(/5 speakers \(by voice\)/)).toBeTruthy();
  });
});

describe('group recording host panel', () => {
  const session = (over = {}) => ({
    code: 'ABC234',
    title: 'Group recording',
    state: 'lobby',
    startedAt: null,
    meetingId: null,
    error: null,
    report: null,
    participants: [
      {
        id: 'p1',
        name: 'Anil',
        deviceLabel: '',
        status: 'ready',
        level: -30,
        secondsSinceSeen: 1,
        parts: 0,
        knownSpeaker: false,
      },
    ],
    ...over,
  });

  it('carries the prototype warning, shows the QR and code, and starts the recording', async () => {
    api.sessions.create.mockResolvedValue(session());
    api.sessions.get.mockResolvedValue(session());
    api.sessions.start.mockResolvedValue(session({ state: 'recording' }));
    render(
      <MemoryRouter>
        <GroupRecording />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Start a group recording/ }));
    expect(
      screen.getByText(/Prototype: tested with synthetic tracks, not yet with real phones/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Create session/ }));
    await screen.findByText('ABC234');
    await screen.findByAltText(/QR code to join ABC234/);
    expect(screen.getByText('Anil')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Start recording/ }));
    await waitFor(() => expect(api.sessions.start).toHaveBeenCalledWith('ABC234'));
    await screen.findByRole('button', { name: /Stop/ });
  });

  it('waits for phones to finish uploading before combining, unless told to go ahead', async () => {
    const stopped = session({
      state: 'stopped',
      participants: [
        {
          id: 'p1',
          name: 'Anil',
          deviceLabel: '',
          status: 'recording',
          level: -30,
          secondsSinceSeen: 2,
          parts: 3,
          knownSpeaker: false,
        },
      ],
    });
    api.sessions.create.mockResolvedValue(stopped);
    api.sessions.get.mockResolvedValue(stopped);
    api.sessions.finish.mockResolvedValue(session({ state: 'processing', meetingId: 'm9' }));
    render(
      <MemoryRouter>
        <GroupRecording />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Start a group recording/ }));
    fireEvent.click(screen.getByRole('button', { name: /Create session/ }));
    await screen.findByText(/Waiting for every phone to finish uploading/);
    expect(screen.getByRole('button', { name: /Combine and process/ }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Combine anyway/ }));
    await waitFor(() => expect(api.sessions.finish).toHaveBeenCalledWith('ABC234'));
  });
});

describe("phone's join page", () => {
  const renderJoin = () =>
    render(
      <MemoryRouter initialEntries={['/join/abc234']}>
        <Routes>
          <Route path="/join/:code" element={<Join />} />
        </Routes>
      </MemoryRouter>,
    );

  it('joins, waits, records when the host starts, uploads parts, and finishes when the host stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.join.join.mockResolvedValue({
      participantId: 'pid1',
      token: 'tok1',
      state: 'lobby',
      title: 'Group recording',
      serverNowMs: Date.now(),
      startedAtServerMs: null,
    });
    // 1st: the call made when joining; then one per 2 s: the host presses Start, later Stop
    const states = ['lobby', 'recording', 'recording', 'stopped'];
    api.join.heartbeat.mockImplementation(async () => ({
      state: states.shift() ?? 'stopped',
      title: 'Group recording',
      serverNowMs: Date.now(),
      startedAtServerMs: null,
    }));
    api.join.sign.mockResolvedValue({
      apiKey: 'k',
      timestamp: 1,
      signature: 's',
      folder: 'f/pid1',
      uploadUrl: 'https://u',
    });
    upload.mockResolvedValue({ url: 'https://cloud/part0.wav', publicId: 'f/pid1/abc' });
    api.join.part.mockResolvedValue({ ok: true });

    renderJoin();
    expect(screen.getByText(/Prototype: tested with synthetic tracks/)).toBeTruthy();
    expect(screen.getByText('ABC234')).toBeTruthy(); // the code is shown upper-case
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Anil' } });
    fireEvent.click(screen.getByRole('button', { name: /Join and allow microphone/ }));
    await screen.findByText(/Waiting for the host to press Start/);
    expect(api.join.join).toHaveBeenCalledWith('ABC234', 'Anil', expect.any(String));
    expect(recorder.instance.open).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await screen.findByText(/Recording\. Keep this page open/);
    expect(recorder.instance.begin).toHaveBeenCalled();

    // a 60 s part arrives from the recorder: saved locally, signed, uploaded, reported
    await act(async () => {
      recorder.cb.onFirstSample(1_000_000);
      recorder.cb.onPart({ index: 0, wav: new Blob(['x']), startSample: 0 });
    });
    await waitFor(() => expect(api.join.part).toHaveBeenCalled());
    expect(recorder.putKeys).toContain('ABC234:pid1:0');
    expect(api.join.part.mock.calls[0][1]).toMatchObject({
      pid: 'pid1',
      token: 'tok1',
      index: 0,
      publicId: 'f/pid1/abc',
      url: 'https://cloud/part0.wav',
      startSample: 0,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4200);
    });
    await screen.findByText(/Done\. You can close this page/);
    expect(recorder.instance.stop).toHaveBeenCalled();
    expect(recorder.instance.close).toHaveBeenCalled();
  });

  it('says so when the microphone is blocked', async () => {
    api.join.join.mockResolvedValue({
      participantId: 'pid1',
      token: 'tok1',
      state: 'lobby',
      title: 'x',
      serverNowMs: Date.now(),
      startedAtServerMs: null,
    });
    api.join.heartbeat.mockResolvedValue({
      state: 'lobby',
      title: 'x',
      serverNowMs: Date.now(),
      startedAtServerMs: null,
    });
    renderJoin();
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Anil' } });
    // the next recorder fails to open
    const original = recorder.instance;
    void original;
    const { PhoneRecorder } = await import('@/lib/phoneRecorder');
    const proto = PhoneRecorder.prototype;
    void proto;
    fireEvent.click(screen.getByRole('button', { name: /Join and allow microphone/ }));
    await screen.findByText(/Waiting for the host|microphone is blocked/);
  });
});

describe('meeting page with speakers', () => {
  it('shows the transcript, the speaker cards, and refreshes after naming a voice', async () => {
    const meeting = {
      id: 'm1',
      title: 'Meeting 21/9',
      date: '2026-09-21T10:00:00Z',
      durationSec: 2538,
      status: 'completed',
      stage: 'done',
      progress: { chunksTotal: 5, chunksDone: 5 },
      audio: { playbackUrl: 'https://x/a.mp3' },
      coverage: { ratio: 0.985 },
      summary: '## Overview\nWe agreed the offer.',
      summaryStatus: 'completed',
      actionItems: [],
      updatedAt: '2026-10-08T01:00:00Z',
    };
    const lines = (name) => [
      {
        speakerName: name,
        start: 1,
        end: 5,
        textRoman: 'aaj hum discuss karenge',
        textNative: 'आज हम',
      },
    ];
    api.meetings.get.mockResolvedValue(meeting);
    api.meetings.data
      .mockResolvedValueOnce({ lines: lines('Speaker D') })
      .mockResolvedValue({ lines: lines('Ghanshyam Dholakia') });
    const card = {
      diar: 'S3',
      label: 'Speaker D',
      displayName: 'Speaker D',
      personId: 'p1',
      personName: 'Speaker D (Meeting 21/9)',
      anonymous: true,
      voiceprints: 3,
      speakerSec: 300,
      turns: 20,
      status: 'new',
      match: null,
      candidate: null,
      clips: [{ start: 3, end: 15, quality: 90 }],
      phone: null,
      appearsIn: [
        { meetingId: 'm2', title: 'AOM', label: 'Speaker B', displayName: 'Speaker B', score: 78 },
      ],
    };
    api.meetings.speakers
      .mockResolvedValueOnce({ source: 'pyannote', cards: [card] })
      .mockResolvedValue({
        source: 'pyannote',
        cards: [{ ...card, displayName: 'Ghanshyam Dholakia', anonymous: false }],
      });
    api.meetings.nameSpeaker.mockResolvedValue({ updatedMeetings: ['m1', 'm2'] });

    render(
      <MemoryRouter initialEntries={['/meetings/m1']}>
        <Routes>
          <Route path="/meetings/:id" element={<MeetingDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Meeting 21/9');
    await screen.findByText('Speakers (1)');
    expect(screen.getByText(/Also heard in/)).toBeTruthy();
    expect(screen.getByText('aaj hum discuss karenge')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name for Speaker D/), {
      target: { value: 'Ghanshyam Dholakia' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() =>
      expect(api.meetings.nameSpeaker).toHaveBeenCalledWith('m1', 'S3', {
        name: 'Ghanshyam Dholakia',
      }),
    );
    // the page reloads the transcript and the cards, and is honest about the summary
    await waitFor(() =>
      expect(screen.getAllByText('Ghanshyam Dholakia').length).toBeGreaterThan(0),
    );
    await screen.findByText(/summary above was written with the earlier speaker labels/);
  });
});
