import type { AutomationRunRecord, AutomationRunTrigger } from "@forge/protocol";
import {
  AutomationScheduler,
  shouldCatchUpMissedRun,
  type AutomationStore,
} from "@forge/automation";

export class AutomationSchedulerHost {
  private readonly scheduler: AutomationScheduler;

  constructor(
    private readonly deps: {
      store: AutomationStore;
      executeAutomation: (
        id: string,
        trigger: AutomationRunTrigger,
      ) => Promise<AutomationRunRecord>;
    },
  ) {
    this.scheduler = new AutomationScheduler({
      listJobs: async () =>
        this.deps.store.listEnabledCron().map((a) => ({
          id: a.id,
          nextRunAt: a.nextRunAt,
        })),
      onFire: async (id) => {
        await this.deps.executeAutomation(id, "schedule");
      },
    });
  }

  async start(): Promise<void> {
    const crons = this.deps.store.listEnabledCron();
    for (const auto of crons) {
      if (shouldCatchUpMissedRun(auto.nextRunAt, auto.lastRunAt)) {
        void this.deps.executeAutomation(auto.id, "schedule");
      }
    }
    await this.scheduler.reload();
  }

  async reschedule(id: string): Promise<void> {
    await this.scheduler.reschedule(id);
  }

  stop(): void {
    this.scheduler.stop();
  }
}
