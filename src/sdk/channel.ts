/**
 * Channel primitives for the SDK transport.
 *
 * One consumer, many producers. `next()` takes a deadline because every wait in
 * this transport is bounded: a silent Claude Code process must fail the turn
 * instead of hanging Pi.
 */

import { timeoutError } from "../errors.js";

export class Channel<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: T | null) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  /** Close after draining buffered values, or fail immediately. */
  close(failure?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = failure ?? null;
    for (const waiter of this.waiters.splice(0)) {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve(null);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Next value, `null` when closed and drained. Throws on failure, or when
   * `timeoutMs` elapses first. Omit `timeoutMs` for a wait with no deadline.
   */
  next(timeoutMs?: number): Promise<T | null> {
    const buffered = this.values.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    if (this.closed) {
      return this.failure ? Promise.reject(this.failure) : Promise.resolve(null);
    }
    return new Promise<T | null>((resolve, reject) => {
      const waiter = {
        resolve: (value: T | null): void => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error): void => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      };
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(timeoutError(`no output from Claude Code within ${timeoutMs}ms`));
      }, timeoutMs);
      timer?.unref();
      this.waiters.push(waiter);
    });
  }
}
