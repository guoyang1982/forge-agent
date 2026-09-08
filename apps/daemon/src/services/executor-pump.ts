export interface ExecutorPumpOptions {
  tick(limit?: number): Promise<number>;
  afterTick?(): Promise<void>;
  nextDueAt(): string | undefined;
  nowMs(): number;
  setTimer?(fn: () => void, delayMs: number): () => void;
  batchSize?: number;
  onError?(error: unknown): void;
}

export interface ExecutorPump {
  wake(): void;
  idle(): Promise<void>;
  stop(): void;
}

/** Drain ready work, then sleep until the next due retry. */
export function createExecutorPump(options: ExecutorPumpOptions): ExecutorPump {
  const batchSize = options.batchSize ?? 10;
  const setTimer =
    options.setTimer ??
    ((fn, delayMs) => {
      const handle = setTimeout(fn, delayMs);
      return () => clearTimeout(handle);
    });

  let running: Promise<void> | undefined;
  let wakeAgain = false;
  let stopped = false;
  let cancelTimer: (() => void) | undefined;

  const dueNow = (): boolean => {
    const dueAt = options.nextDueAt();
    return Boolean(dueAt) && Date.parse(dueAt!) <= options.nowMs();
  };

  const drain = async (): Promise<void> => {
    try {
      do {
        wakeAgain = false;
        let processed: number;
        do {
          if (stopped) return;
          processed = await options.tick(batchSize);
          await options.afterTick?.();
        } while (processed >= batchSize || (processed > 0 && dueNow()));
      } while (wakeAgain && !stopped);
      scheduleNext();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = undefined;
      if (wakeAgain && !stopped) {
        wake();
      }
    }
  };

  const scheduleNext = (): void => {
    cancelTimer?.();
    cancelTimer = undefined;
    if (stopped) return;
    const dueAt = options.nextDueAt();
    if (!dueAt) return;
    const delayMs = Math.max(0, Date.parse(dueAt) - options.nowMs());
    cancelTimer = setTimer(() => {
      cancelTimer = undefined;
      wake();
    }, delayMs);
  };

  const wake = (): void => {
    if (stopped) return;
    if (running) {
      wakeAgain = true;
      return;
    }
    running = drain();
  };

  return {
    wake,
    idle: async () => {
      while (running) {
        await running;
      }
    },
    stop: () => {
      stopped = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}
