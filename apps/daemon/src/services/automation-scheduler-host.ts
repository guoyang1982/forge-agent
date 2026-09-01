import type { AutomationRunRecord, AutomationRunTrigger } from "@forge/protocol";
import {
  AutomationScheduler,
  TriggerScheduleClaimStore,
  processScheduledAutomationCatchUp,
  type AutomationStore,
  type ScheduledRunClaimStore,
} from "@forge/automation";
import { TriggerStore } from "@forge/workflows";
import type Database from "better-sqlite3";

export class AutomationSchedulerHost {
  private readonly scheduler: AutomationScheduler;
  private readonly claimStore: ScheduledRunClaimStore;

  constructor(
    private readonly deps: {
      store: AutomationStore;
      db: Database.Database;
      executeAutomation: (
        id: string,
        trigger: AutomationRunTrigger,
      ) => Promise<AutomationRunRecord>;
      claimStore?: ScheduledRunClaimStore;
    },
  ) {
    this.claimStore =
      deps.claimStore ?? new TriggerScheduleClaimStore(new TriggerStore(deps.db));
    this.scheduler = new AutomationScheduler({
      listJobs: async () =>
        this.deps.store.listEnabledCron().map((a) => ({
          id: a.id,
          nextRunAt: a.nextRunAt,
        })),
      onFire: async (id) => {
        await this.executeScheduled(id);
      },
    });
  }

  async start(): Promise<void> {
    await processScheduledAutomationCatchUp(
      this.deps.store.listEnabledCron(),
      this.claimStore,
      async (id) => {
        await this.deps.executeAutomation(id, "schedule");
      },
    );
    await this.scheduler.reload();
  }

  async reschedule(id: string): Promise<void> {
    await this.scheduler.reschedule(id);
  }

  stop(): void {
    this.scheduler.stop();
  }

  private async executeScheduled(id: string): Promise<void> {
    const auto = this.deps.store.get(id);
    if (!auto?.nextRunAt) {
      return;
    }
    if (!this.claimStore.tryClaim(id, auto.nextRunAt)) {
      return;
    }
    await this.deps.executeAutomation(id, "schedule");
  }
}
