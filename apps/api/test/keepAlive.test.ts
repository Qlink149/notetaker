import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKeepAlive } from '../src/lib/keepAlive.js';

describe('startKeepAlive', () => {
  afterEach(() => vi.useRealTimers());

  it('does nothing without addresses', () => {
    const f = vi.fn();
    startKeepAlive([], f as unknown as typeof fetch)();
    expect(f).not.toHaveBeenCalled();
  });

  it('pings at once and every 8 minutes until stopped, and survives a failing address', async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockRejectedValueOnce(new Error('asleep')).mockResolvedValue({ status: 200 });
    const stop = startKeepAlive(['https://w.example/health'], f as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(f).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
