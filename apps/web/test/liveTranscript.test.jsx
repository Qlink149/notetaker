import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TranscriptView from '@/components/TranscriptView';

const lines = [
  { start: 0, end: 10, speakerName: 'A', textRoman: 'one', textNative: 'one' },
  { start: 10, end: 20, speakerName: 'B', textRoman: 'two', textNative: 'two' },
  { start: 20, end: 30, speakerName: 'A', textRoman: 'three', textNative: 'three' },
];

let scrollSpy;
beforeEach(() => {
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy;
  // every line is far below the screen
  Element.prototype.getBoundingClientRect = () => ({ top: 5000, bottom: 5100 });
});
afterEach(() => cleanup());

const ui = (props) => <TranscriptView lines={lines} scriptMode="roman" {...props} />;

describe('transcript follow mode', () => {
  it('never scrolls the page while follow is off, but still highlights the active line', () => {
    const { rerender, container } = render(ui({ currentTime: 1 }));
    rerender(ui({ currentTime: 12 }));
    rerender(ui({ currentTime: 25 }));
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(container.querySelector('.border-primary\\/40')?.textContent).toContain('three');
  });

  it('jumps to the active line when follow is switched on', () => {
    const { rerender } = render(ui({ currentTime: 12 }));
    rerender(ui({ currentTime: 12, follow: true }));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('does not scroll on a new line when that line is already on screen', () => {
    const { rerender } = render(ui({ currentTime: 12, follow: true }));
    scrollSpy.mockClear();
    Element.prototype.getBoundingClientRect = () => ({ top: 200, bottom: 260 });
    rerender(ui({ currentTime: 25, follow: true }));
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('turns follow off on wheel, touch and navigation keys, but not on typing', () => {
    const onUserScroll = vi.fn();
    render(ui({ currentTime: 12, follow: true, onUserScroll }));
    fireEvent.keyDown(window, { key: 'a' });
    expect(onUserScroll).not.toHaveBeenCalled();
    fireEvent.wheel(window);
    fireEvent.touchMove(window);
    fireEvent.keyDown(window, { key: 'PageDown' });
    expect(onUserScroll).toHaveBeenCalledTimes(3);
  });

  it('ignores manual scrolling when follow is already off', () => {
    const onUserScroll = vi.fn();
    render(ui({ currentTime: 12, follow: false, onUserScroll }));
    fireEvent.wheel(window);
    expect(onUserScroll).not.toHaveBeenCalled();
  });

  it('reports whether the active line is on screen and lets the pill jump there once', () => {
    const onActiveVisible = vi.fn();
    const jumpRef = { current: null };
    render(ui({ currentTime: 12, onActiveVisible, jumpRef }));
    expect(onActiveVisible).toHaveBeenLastCalledWith(false);
    act(() => jumpRef.current());
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('seeks on a line click without touching follow', () => {
    const onSeek = vi.fn();
    const onUserScroll = vi.fn();
    const { getByText } = render(ui({ currentTime: 0, onSeek, onUserScroll }));
    fireEvent.click(getByText('two'));
    expect(onSeek).toHaveBeenCalledWith(10);
    expect(onUserScroll).not.toHaveBeenCalled();
  });
});

describe('a meeting uploaded in several files', () => {
  it('marks where each later file starts in the transcript', () => {
    const { getAllByTestId } = render(
      ui({
        parts: [
          { publicId: 'a', url: 'b2://a', fileName: 'a.m4a', durationSec: 10, offsetSec: 0 },
          { publicId: 'b', url: 'b2://b', fileName: 'b.m4a', durationSec: 10, offsetSec: 10 },
          { publicId: 'c', url: 'b2://c', fileName: null, durationSec: 10, offsetSec: 20 },
        ],
      }),
    );
    const dividers = getAllByTestId('part-divider');
    expect(dividers.map((d) => d.textContent)).toEqual(['Part 2 · b.m4a', 'Part 3']);
    // each divider sits right before the first line of its part
    expect(dividers[0].nextElementSibling.textContent).toContain('two');
    expect(dividers[1].nextElementSibling.textContent).toContain('three');
  });

  it('shows no divider for a meeting in one file', () => {
    const { queryByTestId } = render(ui({}));
    expect(queryByTestId('part-divider')).toBeNull();
  });
});
