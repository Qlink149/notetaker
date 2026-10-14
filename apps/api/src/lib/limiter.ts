/**
 * A counting semaphore: at most `max` tasks run at once, the rest wait their turn in arrival order.
 * Used to cap simultaneous Gemini requests across every stage of the worker.
 */
export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks running right now. */
  readonly active: number;
  /** Tasks waiting for a free slot. */
  readonly waiting: number;
}

export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: (() => void)[] = [];

  const release = (): void => {
    const next = queue.shift();
    if (next)
      next(); // hand the slot straight to the next waiter
    else active--;
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < limit) active++;
      else await new Promise<void>((resolve) => queue.push(resolve));
      try {
        return await task();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}
