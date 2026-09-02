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

- Automation service now requires a production-injected durable automation facade and no longer calls `handleRun` directly. The facade creates and executes a durable run, while the existing automation record remains the projection for session/status/notification behavior. The workflow-instance projection and AgentProfile runtime-policy-to-agent-loop wiring remain outstanding follow-up work.
- The daemon socket integration test was rerun outside the sandbox and passed: `CI=true pnpm --filter @forge/daemon test -- production-events.e2e.test.ts` (4 tests).

---

## Final load-bearing remediation: Automation occurrences and AgentProfile runtime policy

### Production paths traced

- Scheduled catch-up and timer delivery enter `AutomationSchedulerHost`, whose persisted `TriggerStore` claim rejects a repeated `(automation, occurrenceAt)` after process restart. Manual delivery and accepted scheduled delivery both enter `executeAutomation`.
- `executeAutomation` now publishes/resolves the automation's durable workflow, creates one `core_workflow_instances` occurrence, compiles and persists one `core_runs` Run, writes both foreign-key links back to the existing `automation_runs` projection, and drives the injected production `DurableExecutor`. It has no `handleRun` or legacy run-service dependency.
- The production executor resolves the exact published AgentProfile version in `GovernedStepExecutor`, forwards its typed `RuntimePolicy` through `StepExecutionInput` and `LegacyForgeStepExecutor`, and supplies it to the daemon's real `runReActLoop` invocation.
- `runReActLoop` applies the published dynamic-status heartbeat/dedupe settings and context-compression trigger/budget before the actual LLM request. The existing model selection also uses the resolved profile runtime model.

### Root causes fixed

- The previous durable automation facade created only a standalone Run from the legacy request. There was no persisted workflow instance, no occurrence-to-instance/Run link, and no workflow occurrence uniqueness boundary.
- Automation projection rows had no durable identifiers. Migration `019_automation_durable_links.sql` adds the two links, the workflow occurrence uniqueness index, and the durable Run lookup index; store/protocol projections round-trip both identifiers.
- AgentProfile runtime policy previously stopped at governance resolution. `StepExecutionInput` did not carry it, the legacy adapter dropped it, and the real loop used hardcoded status intervals without invoking context compression.
- `RuntimePolicy` had no typed dynamic-status or context-compression fields. The new optional typed structures are persisted and published without an unsafe cast.

### RED evidence (recorded before production changes)

- `apps/daemon/src/services/automation-durable.integration.test.ts`: scheduled plus manual delivery initially produced zero workflow instances (`expected [] to have length 2`), proving the existing standalone durable facade did not satisfy workflow occurrence persistence/linkage.
- `apps/daemon/src/profile-runtime-policy.integration.test.ts`: the published 10 ms heartbeat produced zero `处理中…` events (`expected 0 to be greater than or equal to 2`), and the actual LLM input still contained `OLD-NOISE`, proving the real loop ignored both policy sections.
- `packages/execution/src/legacy-run-adapter.test.ts`: the resolved runtime policy arrived at the underlying runner as `undefined`, proving the production adapter propagation gap.
- The automation restart test now deliberately restores stale legacy `last_run_at`/`next_run_at` values after the first durable commit. A second scheduler host accepts no repeat side effect: the persisted occurrence claim leaves exactly two total instances/Runs for one scheduled plus one manual occurrence.

### Files changed in this final pass

- Automation integration/composition: `apps/daemon/src/services/automation-durable.integration.test.ts`, `apps/daemon/src/services/automation-service.ts`, `apps/daemon/src/services/run-service.ts`, `apps/daemon/src/main.ts`, and daemon automation/context modules.
- Durable workflow/projection: `migrations/019_automation_durable_links.sql`, `packages/workflows/src/v2/store.ts`, `packages/automation/src/{store.ts,store.test.ts}`, `packages/protocol/src/automation.ts`, and the legacy-upgrade migration test.
- Runtime policy integration: `apps/daemon/src/profile-runtime-policy.integration.test.ts`, `packages/agent-profile/src/{types.ts,store.test.ts}`, `packages/execution/src/{executor-types.ts,governed-executor.ts,governed-executor.test.ts,legacy-run-adapter.ts,legacy-run-adapter.test.ts}`, `packages/agent-core/src/loop.ts`, daemon run/governance composition, and protocol RPC types/tests.

### GREEN verification

```text
CI=true pnpm --filter @forge/daemon test
26 files passed, 98 tests passed

CI=true pnpm --filter @forge/agent-profile --filter @forge/protocol --filter @forge/execution --filter @forge/workflows --filter @forge/automation --filter @forge/store test
24 files passed, 136 tests passed

CI=true pnpm build
51 of 52 workspace projects built successfully

git diff --check
passed
```

### Self-review

- The integration tests use real migrated SQLite stores, real workflow compilation/persistence, the durable executor, a published versioned AgentProfile snapshot, and the real agent loop; neither requirement is asserted only through an isolated helper.
- Removing the workflow-instance path would restore the zero-instance RED failure. Dropping runtime-policy propagation, hardcoding the old status interval, or skipping compression would restore the three runtime RED failures.
- The existing `AutomationRunRecord` session/status/preview/notification projection is retained, with durable links added rather than replacing it.
- No `any`, `as any`, or `as unknown as` was added in the changed load-bearing paths.

### Commit

This final remediation commit; its immutable hash is returned to the task controller after commit creation.

### Concerns

- `CI=true pnpm test` progresses through the affected packages but stops in the pre-existing, unrelated CLI test `apps/cli/src/client-v2.test.ts` because its fake daemon client rejects the already-existing `events.read` call (`unexpected method: events.read`). No CLI or daemon-client file is changed by this remediation. The complete daemon suite and every affected package suite pass independently above.
