import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  addParts: vi.fn(),
  upload: vi.fn(),
  sign: vi.fn(),
  docx: vi.fn(),
}));
vi.mock('@/api/client', () => ({
  api: { meetings: { addParts: (...a) => h.addParts(...a), exportDocx: (...a) => h.docx(...a) } },
}));
vi.mock('@/lib/cloudinaryUpload', async (orig) => ({
  ...(await orig()),
  getUploadSignature: (...a) => h.sign(...a),
  uploadToCloudinary: (...a) => h.upload(...a),
}));

import AddContinuation from '@/components/AddContinuation';
import MeetingExport from '@/components/MeetingExport';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const meeting = { id: 'm1', title: 'Plan', date: '2026-10-20T10:00:00Z', durationSec: 600 };
const at = (name, t) =>
  new File(['x'.repeat(2048)], name, { type: 'audio/x-m4a', lastModified: t });

describe('adding a continuation recording (client request, 20 Oct)', () => {
  it('explains what happens, uploads into the meeting and adds the files in recording order', async () => {
    h.sign.mockResolvedValue({ meetingId: 'm1' });
    h.upload.mockImplementation(async (f) => ({ publicId: `p/${f.name}`, url: `b2://${f.name}` }));
    h.addParts.mockResolvedValue({ id: 'm1', status: 'processing' });
    const onAdded = vi.fn();
    const { container } = render(<AddContinuation meeting={meeting} onAdded={onAdded} />);
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [at('later-2.m4a', 20), at('later-1.m4a', 10)] },
    });
    const box = await screen.findByTestId('continuation-confirm');
    expect(box.textContent).toMatch(/to the end of “Plan”/);
    expect(box.textContent).toMatch(/Names you gave to speakers are kept/);
    expect([...box.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual([
      'later-1.m4a',
      'later-2.m4a',
    ]);
    // nothing is uploaded before the person confirms
    expect(h.upload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add and process' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: 'm1', status: 'processing' }));
    expect(h.sign).toHaveBeenCalledWith('m1');
    expect(h.addParts).toHaveBeenCalledWith('m1', [
      { publicId: 'p/later-1.m4a', url: 'b2://later-1.m4a', fileName: 'later-1.m4a' },
      { publicId: 'p/later-2.m4a', url: 'b2://later-2.m4a', fileName: 'later-2.m4a' },
    ]);
  });

  it('lets the order be corrected before uploading', async () => {
    h.sign.mockResolvedValue({ meetingId: 'm1' });
    h.upload.mockImplementation(async (f) => ({
      publicId: `p/${f.name}`,
      url: `b2://p/${f.name}`,
    }));
    h.addParts.mockResolvedValue({ id: 'm1' });
    const { container } = render(<AddContinuation meeting={meeting} />);
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [at('a.m4a', 1), at('b.m4a', 2)] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Move b.m4a up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add and process' }));
    await waitFor(() => expect(h.addParts).toHaveBeenCalled());
    expect(h.addParts.mock.calls[0][1].map((p) => p.fileName)).toEqual(['b.m4a', 'a.m4a']);
  });

  it('cancelling uploads nothing', async () => {
    const { container } = render(<AddContinuation meeting={meeting} />);
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [at('later.m4a', 1)] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('continuation-confirm')).toBeNull();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.addParts).not.toHaveBeenCalled();
  });

  it('shows the server refusal (meeting still processing)', async () => {
    h.sign.mockResolvedValue({ meetingId: 'm1' });
    h.upload.mockResolvedValue({ publicId: 'p', url: 'b2://p' });
    h.addParts.mockRejectedValue(new Error('meeting_is_processing'));
    const { container } = render(<AddContinuation meeting={meeting} />);
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [at('later.m4a', 1)] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Add and process' }));
    expect(await screen.findByText('meeting_is_processing')).toBeTruthy();
  });
});

describe('Share… (the browser opens the share menu only straight from a click)', () => {
  const lines = [{ start: 0, speakerName: 'Heet', textRoman: 'Hello', textNative: '' }];
  let share;
  beforeEach(() => {
    share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share, canShare: () => true });
    h.docx.mockResolvedValue(new Blob(['docx']));
  });
  afterEach(() => {
    delete navigator.share;
    delete navigator.canShare;
  });

  it('shares the Word file at once when it was prepared before the click', async () => {
    render(<MeetingExport meeting={meeting} lines={lines} />);
    const button = screen.getByRole('button', { name: /Share/ });
    fireEvent.pointerEnter(button);
    await waitFor(() => expect(h.docx).toHaveBeenCalledTimes(1));
    await act(async () => {});
    fireEvent.click(button);
    expect(share).toHaveBeenCalledTimes(1);
    const [arg] = share.mock.calls[0];
    expect(arg.files[0].name).toBe('Plan.docx');
  });

  it('a click before the file is ready asks for a second click instead of failing', async () => {
    render(<MeetingExport meeting={meeting} lines={lines} />);
    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    expect(share).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /Tap to share/ }));
    expect(share).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /^\s*Share…/ })).toBeTruthy();
  });
});

describe('Share… where the browser refuses the Word file (Chrome on a computer: "Permission denied")', () => {
  const lines = [{ start: 0, speakerName: 'Heet', textRoman: 'Hello', textNative: '' }];
  afterEach(() => {
    delete navigator.share;
    delete navigator.canShare;
    delete window.matchMedia;
  });

  it('is not offered on a computer (mouse pointer)', () => {
    Object.assign(navigator, { share: vi.fn(), canShare: () => true });
    window.matchMedia = () => ({ matches: false });
    render(<MeetingExport meeting={meeting} lines={lines} />);
    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
    // the downloads are still there
    expect(screen.getByRole('button', { name: /Word/ })).toBeTruthy();
  });

  it('on a phone, offers the text instead after the file is refused', async () => {
    const refused = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    const share = vi.fn().mockRejectedValueOnce(refused).mockResolvedValue(undefined);
    Object.assign(navigator, { share, canShare: () => true });
    window.matchMedia = () => ({ matches: true });
    h.docx.mockResolvedValue(new Blob(['docx']));
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<MeetingExport meeting={meeting} lines={lines} />);
    const button = screen.getByRole('button', { name: /Share/ });
    fireEvent.pointerEnter(button);
    await waitFor(() => expect(h.docx).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: /Share as text/ }));
    expect(share).toHaveBeenCalledTimes(2);
    expect(share.mock.calls[1][0].text).toContain('Hello');
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });
});

describe('what a copy or export includes', () => {
  const lines = [
    { start: 0, speakerName: 'Heet', textRoman: 'hello roman', textNative: 'hello native' },
  ];
  const rich = {
    ...meeting,
    summary: 'Festival overview',
    actionItems: [{ speakerName: 'A', text: 'Send the plan' }],
  };

  beforeEach(() => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(() => {
    delete navigator.share;
    delete navigator.canShare;
    vi.restoreAllMocks();
  });

  const copiedText = () => navigator.clipboard.writeText.mock.calls.at(-1)[0];
  // The button reads "Copied" for two seconds after a copy, so match either label.
  const clickCopy = () =>
    fireEvent.click(
      screen.getByRole('button', { name: (name) => name === 'Copy' || name === 'Copied' }),
    );

  it('copies notes and the transcript in the same script as the page', async () => {
    const view = render(<MeetingExport meeting={rich} lines={lines} scriptMode="roman" />);
    clickCopy();
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(copiedText()).toContain('Festival overview');
    expect(copiedText()).toContain('Send the plan');
    expect(copiedText()).toContain('hello roman');
    expect(copiedText()).not.toContain('hello native');
    expect(screen.queryByRole('radio', { name: 'Roman' })).toBeNull();

    view.rerender(<MeetingExport meeting={rich} lines={lines} scriptMode="native" />);
    clickCopy();
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2));
    expect(copiedText()).toContain('hello native');
    expect(copiedText()).not.toContain('hello roman');

    view.rerender(<MeetingExport meeting={rich} lines={lines} scriptMode="both" />);
    clickCopy();
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(3));
    expect(copiedText()).toContain('hello roman');
    expect(copiedText()).toContain('hello native');
  });

  it('keeps at least one of Notes and Transcript, and leaves the unticked part out', async () => {
    render(<MeetingExport meeting={rich} lines={lines} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Notes/ }));
    const transcript = screen.getByRole('checkbox', { name: 'Transcript' });
    expect(transcript.getAttribute('aria-checked')).toBe('true');
    expect(transcript.disabled).toBe(true);
    fireEvent.click(transcript);
    expect(transcript.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /^Copy/ }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(copiedText()).toContain('hello roman');
    expect(copiedText()).not.toContain('Festival overview');
    expect(copiedText()).not.toContain('Send the plan');
  });

  it('sends the ticked parts to Word and prints only those', async () => {
    h.docx.mockResolvedValue(new Blob(['docx']));
    const write = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({ document: { write, close: vi.fn() } });
    render(<MeetingExport meeting={rich} lines={lines} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Transcript' }));
    fireEvent.click(screen.getByRole('button', { name: /Word/ }));
    await waitFor(() =>
      expect(h.docx).toHaveBeenCalledWith('m1', 'roman', { notes: true, transcript: false }),
    );
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    expect(write.mock.calls[0][0]).toContain('Festival overview');
    expect(write.mock.calls[0][0]).toContain('Send the plan');
    expect(write.mock.calls[0][0]).not.toContain('hello roman');
    window.open.mockRestore();
  });

  it('fetches a new Word file for Share after a tick changes', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share, canShare: () => true });
    h.docx.mockResolvedValue(new Blob(['docx']));
    render(<MeetingExport meeting={meeting} lines={lines} />);
    const button = screen.getByRole('button', { name: /Share/ });
    fireEvent.pointerEnter(button);
    await waitFor(() => expect(h.docx).toHaveBeenCalledTimes(1));
    expect(h.docx).toHaveBeenLastCalledWith('m1', 'roman', { notes: true, transcript: true });
    fireEvent.click(screen.getByRole('checkbox', { name: /^Notes/ }));
    fireEvent.pointerEnter(button);
    await waitFor(() => expect(h.docx).toHaveBeenCalledTimes(2));
    expect(h.docx).toHaveBeenLastCalledWith('m1', 'roman', {
      notes: false,
      transcript: true,
    });
    delete navigator.share;
    delete navigator.canShare;
  });
});
