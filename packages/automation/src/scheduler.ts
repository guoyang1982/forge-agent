export interface ScheduledJob {
  id: string;
  nextRunAt?: string;
}

export interface AutomationSchedulerDeps {
  listJobs: () => Promise<ScheduledJob[]>;
  onFire: (id: string) => Promise<void>;
  reschedule?: (id: string) => Promise<void>;
}

const MAX_TIMEOUT_MS = 2_147_483_647;

export class AutomationScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly deps: AutomationSchedulerDeps) {}

  async reload(): Promise<void> {
    this.clearAll();
    this.stopped = false;
    const jobs = await this.deps.listJobs();
    for (const job of jobs) {
      this.scheduleJob(job);
    }
  }

  async reschedule(id: string): Promise<void> {
    this.cancelTimer(id);
    const jobs = await this.deps.listJobs();
    const job = jobs.find((j) => j.id === id);
    if (job) this.scheduleJob(job);
    await this.deps.reschedule?.(id);
  }

  stop(): void {
    this.stopped = true;
    this.clearAll();
  }

  private clearAll(): void {
    for (const id of this.timers.keys()) {
      this.cancelTimer(id);
    }
  }

  private cancelTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private scheduleJob(job: ScheduledJob): void {
    if (this.stopped || !job.nextRunAt) return;

    const delay = new Date(job.nextRunAt).getTime() - Date.now();
    if (delay <= 0) return;

    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      if (delay > MAX_TIMEOUT_MS) {
        this.scheduleJob(job);
      } else {
        void this.deps.onFire(job.id);
      }
    }, Math.min(delay, MAX_TIMEOUT_MS));

    this.timers.set(job.id, timer);
  }
}
