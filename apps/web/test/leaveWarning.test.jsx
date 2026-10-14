import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useLeaveWarning } from '../src/lib/useLeaveWarning';

function Probe({ active }) {
  useLeaveWarning(active);
  return null;
}
const closeTab = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

afterEach(cleanup);

describe('leave warning', () => {
  it('asks before the page closes only while active, and stops asking afterwards', () => {
    const { rerender, unmount } = render(<Probe active={false} />);
    expect(closeTab()).toBe(false);
    rerender(<Probe active />);
    expect(closeTab()).toBe(true);
    rerender(<Probe active={false} />);
    expect(closeTab()).toBe(false);
    rerender(<Probe active />);
    unmount();
    expect(closeTab()).toBe(false);
  });
});
