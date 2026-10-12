import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextSpeakersNotice } from '../src/components/SpeakerReview';

afterEach(cleanup);

// A meeting whose speakers were guessed from the text says so, and offers to run the voice analysis again.
describe('speakers guessed from the text', () => {
  it('says so plainly and re-runs the voice analysis on request', () => {
    const onRerun = vi.fn();
    render(<TextSpeakersNotice busy={false} onRerun={onRerun} />);
    expect(screen.getByText(/guessed from the text, not from voices/i)).toBeTruthy();
    expect(screen.getByText(/number of speakers and who said what may be wrong/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /re-run voice analysis/i }));
    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  it('cannot be clicked twice while it is starting', () => {
    render(<TextSpeakersNotice busy onRerun={() => undefined} />);
    expect(screen.getByRole('button', { name: /re-run voice analysis/i }).disabled).toBe(true);
  });
});
