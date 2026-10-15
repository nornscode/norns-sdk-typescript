/**
 * A push-in, pull-out queue that is also an async iterable. Producers push
 * values (or close, or fail); a single consumer iterates. Used to turn a
 * channel's callbacks into `for await`.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  #done = false;
  #error: unknown = undefined;

  push(value: T): void {
    if (this.#done) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.#done) return;
    this.#done = true;
    this.#error = error;
    for (const w of this.#waiters.splice(0)) w.reject(error);
  }

  get closed(): boolean {
    return this.#done;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) {
      return Promise.resolve({ value: this.#values.shift() as T, done: false });
    }
    if (this.#done) {
      return this.#error !== undefined
        ? Promise.reject(this.#error)
        : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}
