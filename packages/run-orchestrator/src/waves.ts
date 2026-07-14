import type { RunPlanStep } from "./types.js";

export function assignWaves(steps: RunPlanStep[]): RunPlanStep[] {
  const byId = new Map(steps.map((s) => [s.id, { ...s }]));
  const visiting = new Set<string>();
  const done = new Set<string>();

  const waveOf = (id: string): number => {
    if (done.has(id)) return byId.get(id)!.wave;
    if (visiting.has(id)) {
      throw new Error(`RunPlan cycle detected at step ${id}`);
    }
    visiting.add(id);
    const step = byId.get(id);
    if (!step) throw new Error(`Unknown step ${id}`);
    const depWaves = step.after.map((dep) => waveOf(dep));
    const wave = depWaves.length ? Math.max(...depWaves) + 1 : 0;
    step.wave = wave;
    visiting.delete(id);
    done.add(id);
    return wave;
  };

  for (const step of steps) waveOf(step.id);
  return [...byId.values()].sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id));
}

export function talentExecutionWaves(plan: { steps: RunPlanStep[] }): RunPlanStep[][] {
  const talent = plan.steps.filter((s) => s.kind === "talent_background");
  const maxWave = talent.reduce((m, s) => Math.max(m, s.wave), 0);
  const waves: RunPlanStep[][] = [];
  for (let w = 0; w <= maxWave; w++) {
    const group = talent.filter((s) => s.wave === w);
    if (group.length) waves.push(group);
  }
  return waves;
}
