# Task 3 — Governance and Terminal Execution Remediation

## Production paths traced

- `apps/daemon/src/main.ts` creates the durable production composition, now with real profile, approval, budget, workspace-lease, policy, and validation services.
- `apps/daemon/src/services/production-execution-composition.ts` registers the legacy Forge step only as the underlying step port of `GovernedStepExecutor`; governed composition requires validated `policyContext.governance` data and fails closed before invoking a step when absent.
- `packages/execution/src/executor.ts` owns active cancellation controllers, guards late completion, and claims idempotency for non-governed steps; governed side effects claim only after the approval/policy gates.
- `packages/execution/src/governed-executor.ts` verifies a persisted approved approval that matches subject, action, resource, policy version, run, and step before it resumes, rather than creating another approval wait.
- `apps/daemon/src/services/core-event-sink.ts` resolves `agent.event.subject` from the durable run rather than hardcoding the default profile.

## Root causes and fixes

- Production composition was a plain `DurableExecutor`; it now supplies a `GovernedStepExecutor` plus concrete durable service ports.
- Empty validation coverage implicitly accepted delivery; `ValidationService` now fails closed.
- Failed prerequisite dependents remained pending; store propagation recursively writes `skipped`, emits `step.skipped`, and reaches terminal `failed`.
- The idempotency table was never claimed at a side-effect boundary; execution now claims atomically, reuses completed outputs, and denies an in-progress duplicate.
- Cancellation marked durable state but did not abort active execution; controllers are tracked per run and late outcomes are ignored after cancellation.
- Resumed approvals could re-enter approval waits; matching durable approval records now permit continuation.
- Legacy event bridging hardcoded its event subject; it now preserves the durable run acting subject.

## RED evidence

- `packages/execution/src/executor.test.ts`: duplicate `publish-once` keys initially invoked the underlying executor twice.
- `packages/execution/src/governed-executor.test.ts`: an approved resume initially returned another approval wait.
- Existing focused RED tests added with the worktree changes covered missing validator coverage, recursive skipped dependents, and cancellation late results.
- The daemon socket integration RED command is sandbox-limited (`listen EPERM` for a temporary Unix socket); its non-socket unit/build coverage remains green.

## GREEN verification

```text
CI=true pnpm --filter @forge/execution test -- executor.test.ts governed-executor.test.ts store.test.ts
3 files passed, 21 tests passed

CI=true pnpm --filter @forge/evidence test -- validation.test.ts
1 file passed, 8 tests passed

CI=true pnpm --filter @forge/execution build
passed

CI=true pnpm --filter @forge/daemon build
passed
```

## Files changed

- `packages/execution/src/{executor,governed-executor,store}.{ts,test.ts}`
- `packages/evidence/src/{validation,validation.test}.ts`
- `packages/protocol/src/v2/rpc.ts`
- `apps/daemon/src/{main.ts,governed-run.e2e.test.ts,production-events.e2e.test.ts}`
- `apps/daemon/src/services/{core-event-sink.ts,production-execution-composition.ts}`

## Self-review

- No `any`, unsafe type assertions, synthetic approvals, or synthetic passing validators were introduced for the new governed approval test; it uses `ApprovalService` and a persisted policy version.
- The idempotency claim is delayed until after governance gates in governed execution, so an approval wait does not consume the side-effect key.
- The production governance metadata parser is intentionally strict: malformed or absent core profile/action/resource/risk values prevent the underlying call.

## Commit

`048e75e55734dfdf311fc35609d8e0ff8c295b7d` (`fix(core): enforce governed durable execution`)

## Concerns

- Automation still uses its legacy `handleRun` path and AgentProfile runtime policy is not yet wired to dynamic status/context compression. Those two required Task 3 paths remain outstanding and need a follow-up; this commit does not claim them complete.
- Full daemon socket integration tests need an environment that permits binding temporary Unix-domain sockets.
