# Run Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify multi-`@` talent dispatch behind a structured RunPlan (think → plan → execute), emit `dispatch_plan` to the UI, and execute by dependency waves before Coordinator followup.

**Architecture:** New `@forge/run-orchestrator` package holds RunPlan types and pure planning helpers. Daemon builds a heuristic plan from parsed `@` assignments, emits events, executes waves, then runs the existing Coordinator ReAct loop. No auto talent selection without `@`.

**Tech Stack:** TypeScript, vitest, existing daemon run-service talent subagent helpers.

**Specs:** [`../specs/2026-06-13-run-orchestrator-design.md`](../specs/2026-06-13-run-orchestrator-design.md), [`../specs/2026-06-13-talent-center-design.md`](../specs/2026-06-13-talent-center-design.md)

---

## Document map

| Doc | Role |
|-----|------|
| `docs/superpowers/specs/2026-06-13-run-orchestrator-design.md` | Unified Intake→Plan→Execute model |
| `docs/superpowers/specs/2026-06-13-talent-center-design.md` | Talent roster, modes A/B, no auto-pick |
| `docs/superpowers/plans/2026-06-13-run-orchestrator.md` | This implementation plan |
| `docs/agent-capabilities.md` | single-writer, spawn_agent, parallel tools |

---

### Task 1: `@forge/run-orchestrator` package

**Files:**
- Create: `packages/run-orchestrator/package.json`, `tsconfig.json`, `src/index.ts`, `src/index.test.ts`

- [ ] Define `RunPlan`, `RunPlanStep`, wave computation
- [ ] `buildTalentDispatchPlan(message, assignments, executionMode)`
- [ ] `planToDispatchPlanEvent`, `planToPlanUpdateItems`, `markStepStatus`
- [ ] Vitest: serial waves, parallel single wave, plan_update labels

### Task 2: Protocol + daemon

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/daemon/package.json`, `apps/daemon/src/services/run-service.ts`

- [ ] Add `dispatch_plan` to `AgentEvent`
- [ ] Multi-`@` path: build plan → emit events → execute by waves → update plan on progress
- [ ] Remove duplicate serial/parallel branching in favor of wave executor

### Task 3: Desktop timeline

**Files:**
- Modify: `apps/desktop/src/renderer/app.js`

- [ ] Handle `dispatch_plan` (store + `renderPlanCard` with「团队负责人计划」标题)
- [ ] Restore `dispatch_plan` from session events

### Task 4: Verify

- [ ] `pnpm --filter @forge/run-orchestrator test`
- [ ] `pnpm --filter @forge/daemon exec tsc --noEmit`
- [ ] `pnpm --filter @forge/protocol build`
