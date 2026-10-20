import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ addParts: vi.fn(), upload: vi.fn(), sign: vi.fn() }));
vi.mock('@/api/client', () => ({
  api: { meetings: { addParts: (...a) => h.addParts(...a), exportDocx: vi.fn() } },
}));
vi.mock('@/lib/cloudinaryUpload', async (orig) => ({
  ...(await orig()),
  getUploadSignature: (...a) => h.sign(...a),
  uploadToCloudinary: (...a) => h.upload(...a),
}));

import AddContinuation from '@/components/AddContinuation';
import { buildForClaude } from '@/components/MeetingExport';

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

describe('Copy for Claude', () => {
  it('gives the summary, action items, speakers and the timed transcript as Markdown', () => {
    const text = buildForClaude(
      {
        ...meeting,
        summary: '## Decisions\n- Launch in May',
        actionItems: [{ speakerName: 'Heet', text: 'Send the plan' }],
      },
      [
        { start: 0, speakerName: 'Heet', textRoman: 'Chalo shuru karte hain', textNative: 'ચાલો' },
        { start: 65, speakerName: 'Paresh', textRoman: 'Haan', textNative: 'હા' },
      ],
    );
    expect(text).toMatch(/^Below are the notes of a meeting \("Plan"/);
    expect(text).toContain('Speakers: Heet, Paresh');
    expect(text).toContain('## Summary\n\n## Decisions\n- Launch in May');
    expect(text).toContain('- **Heet**: Send the plan');
    expect(text).toContain('[0:00] **Heet**: Chalo shuru karte hain');
    expect(text).toContain('[1:05] **Paresh**: Haan');
  });
});
