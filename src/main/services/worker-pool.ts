/**
 * Worker pool: chạy tối đa `concurrency` task cùng lúc.
 * Không dùng Promise.all(all) — worker lấy job tiếp theo khi xong.
 */

export type PoolTask<T> = () => Promise<T>;

export interface RunPoolOptions {
  concurrency: number;
  /** Gọi khi một task settle (ok hoặc lỗi) — index theo thứ tự input. */
  onSettled?: (index: number, result: PromiseSettledResult<unknown>) => void;
  /** true = tạm dừng nhận task mới (chờ resume). */
  isPaused?: () => boolean;
  /** true = dừng hẳn, bỏ task còn lại. */
  shouldStop?: () => boolean;
  /** Gọi khi task bị skip vì stop/pause-exit. */
  onSkip?: (index: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chạy `tasks` với giới hạn concurrency. Giữ thứ tự kết quả theo index.
 * Task lỗi → reject phần tử đó; các worker khác vẫn chạy.
 * Pause: worker chưa cầm task mới sẽ chờ. Stop: bỏ task chưa chạy.
 */
export async function runPool<T>(
  tasks: Array<PoolTask<T>>,
  options: RunPoolOptions
): Promise<Array<PromiseSettledResult<T>>> {
  const concurrency = Math.max(1, Math.min(options.concurrency, tasks.length || 1));
  const results: Array<PromiseSettledResult<T> | undefined> = new Array(tasks.length);
  let nextIndex = 0;

  async function waitIfPaused(): Promise<boolean> {
    while (options.isPaused?.() && !options.shouldStop?.()) {
      await sleep(250);
    }
    return Boolean(options.shouldStop?.());
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (await waitIfPaused()) break;

      const index = nextIndex++;
      if (index >= tasks.length) return;

      // Stop: không start Snapgen mới — bỏ task này và thoát (phần còn lại skip ở cuối).
      if (options.shouldStop?.()) {
        options.onSkip?.(index);
        results[index] = { status: 'rejected', reason: new Error('SKIPPED') };
        break;
      }

      try {
        const value = await tasks[index]();
        const settled: PromiseFulfilledResult<T> = { status: 'fulfilled', value };
        results[index] = settled;
        options.onSettled?.(index, settled);
      } catch (reason) {
        const settled: PromiseRejectedResult = { status: 'rejected', reason };
        results[index] = settled;
        options.onSettled?.(index, settled);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  // Task chưa được gán (stop giữa chừng) → skip.
  for (let i = 0; i < tasks.length; i++) {
    if (results[i] === undefined) {
      options.onSkip?.(i);
      results[i] = { status: 'rejected', reason: new Error('SKIPPED') };
    }
  }

  return results as Array<PromiseSettledResult<T>>;
}

export function isRetryableMediaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|timeout|etimedout|econnreset|enotfound|eai_again|503|502|504|524|temporar|try again|overloaded|too many requests|gateway|network|fetch failed|socket|thiếu video_url|thiếu image_url|file tải về rỗng|tải file thất bại|download/i.test(
    msg
  );
}

export async function withRetries<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  options?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
    shouldAbort?: () => boolean;
    /** Mặc định isRetryableMediaError; override để retry cả lỗi khác (vd. đã sửa prompt). */
    isRetryable?: (err: unknown, attempt: number) => boolean;
  }
): Promise<T> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const baseDelayMs = options?.baseDelayMs ?? 2000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options?.shouldAbort?.()) {
      throw new Error(`${label}: đã dừng bởi người dùng`);
    }
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (options?.shouldAbort?.()) {
        throw new Error(`${label}: đã dừng bởi người dùng`);
      }
      const retryable = options?.isRetryable
        ? options.isRetryable(err, attempt)
        : isRetryableMediaError(err);
      if (!retryable || attempt >= maxAttempts) break;
      const delayMs = Math.min(30_000, baseDelayMs * 2 ** (attempt - 1));
      options?.onRetry?.(attempt, err, delayMs);
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        if (options?.shouldAbort?.()) {
          throw new Error(`${label}: đã dừng bởi người dùng`);
        }
        await sleep(Math.min(250, until - Date.now()));
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label}: ${detail}`);
}
