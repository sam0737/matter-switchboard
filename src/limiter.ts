interface Bucket {
  timestamps: number[];
}

export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class SlidingWindowLimiter {
  readonly #buckets = new Map<string, Bucket>();

  constructor(
    readonly maximum: number,
    readonly windowMs: number,
    readonly now: () => number = Date.now,
  ) {}

  consume(key: string): LimitResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const bucket = this.#buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((time) => time > cutoff);
    if (bucket.timestamps.length >= this.maximum) {
      const retry = Math.max(1, Math.ceil((bucket.timestamps[0]! + this.windowMs - now) / 1000));
      this.#buckets.set(key, bucket);
      return { allowed: false, retryAfterSeconds: retry };
    }
    bucket.timestamps.push(now);
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > 10_000) this.#prune(cutoff);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  #prune(cutoff: number): void {
    for (const [key, bucket] of this.#buckets) {
      bucket.timestamps = bucket.timestamps.filter((time) => time > cutoff);
      if (bucket.timestamps.length === 0) this.#buckets.delete(key);
    }
  }
}
