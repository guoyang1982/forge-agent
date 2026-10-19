# Task 9 Report — Preload 白名单 + 工作链 UI

## Status

DONE

## TDD evidence

### RED

Extended `apps/company-desktop/src/security.test.ts` first:

- changed `fakeIpc().invoke` to `vi.fn(async () => ({ ok: true }))`
- added the expectation that `company.create` reaches `company:invoke`
- retained the assertion that unknown method `run` is rejected

Ran `pnpm --filter @forge/company-desktop test`.

Observed the expected failure:

```text
1 failed | 3 passed
company desktop security boundary > allows company.create via invoke
Error: blocked method: company.create
```

The failure was caused by the empty preload allowlist, proving the new test exercised the missing behavior.

### GREEN

Imported `DAEMON_COMPANY_METHODS` from `@forge/protocol` and built
`COMPANY_INVOKE_METHODS` from `Object.values(DAEMON_COMPANY_METHODS)`. Added
`@forge/protocol` as a workspace dependency and refreshed `pnpm-lock.yaml`.

Ran `pnpm --filter @forge/company-desktop test`.

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

## UI implementation

- Replaced the placeholder renderer with four `data-nav` pages: 总览、组织、工作中心、审批.
- Added company creation and persisted the returned company id locally for subsequent dashboard loads.
- Wired dashboard, WorkItem, employee, organization, and approval reads to live company RPC methods with graceful fallback for thin dashboard payloads.
- Added employee hiring with default autonomy level L2.
- Added the full work chain: verbatim demand registration, spec/plan upsert and acceptance, dispatch, run request, trace display, run deep link, and pause-for-fix.
- Added approval/rejection controls, mandatory rejection reason, own-submission approval disabling when actor identity is known, and server error surfacing when identity is unknown.
- Added a CEO slide-over that only drafts WorkItems and explicitly states it cannot skip spec, plan, or acceptance gates.
- Kept all writes behind `window.forgeCompany.invoke`, retained `sandbox: false`, used vanilla JavaScript, and did not expose `forgeCompany` in the workbench renderer.

## Verification

- `pnpm --filter @forge/company-desktop test` — PASS (4/4)
- `pnpm --filter @forge/company-desktop build` — PASS
- `pnpm --filter @forge/desktop exec vitest run src/product-shell-isolation.test.ts` — PASS (2/2)
- `node --check apps/company-desktop/src/renderer/app.js` — PASS
- IDE diagnostics for changed renderer/preload/test files — no errors

## Concerns

The current daemon `company.workItems.requestRun` response can omit a concrete
`runId`; the UI renders and deep-links a run whenever a run id is returned, and
otherwise preserves the returned WorkItem/plan trace without fabricating one.

## Fix — Important review findings

### Covering files

- `apps/company-desktop/src/renderer/index.html`
- `apps/company-desktop/src/renderer/app.js`
- `apps/company-desktop/src/renderer/styles.css`
- `apps/company-desktop/src/security.test.ts`

### RED

Added focused renderer guardrail tests, then ran
`pnpm --filter @forge/company-desktop test`.

Observed 3 expected failures:

- hire markup still offered autonomy L3/L4
- organization rendering did not reference `payload.departments`
- no `canApprove(actorId, assigneeId)` guard existed

### GREEN

- Rendered departments recursively by `parentId`, with positions grouped under
  each department and employees grouped under their positions.
- Replaced the hire autonomy selector with a fixed L2 field and hard-coded the
  RPC payload to L2.
- Disabled approval when the actor is blank or matches the assignee, and
  retained a click-path guard before invoking the RPC.

Verification:

- `pnpm --filter @forge/company-desktop test` — PASS (7/7)
- `pnpm --filter @forge/desktop exec vitest run src/product-shell-isolation.test.ts` — PASS (2/2)
- `node --check apps/company-desktop/src/renderer/app.js` — PASS
- IDE diagnostics for covering files — no errors

## Fix — Pipeline gates and linked runs

### Covering files

- `apps/daemon/src/modules/company-module.ts`
- `apps/daemon/src/modules/company-module.test.ts`
- `apps/company-desktop/src/renderer/app.js`
- `apps/company-desktop/src/security.test.ts`

### RED

Added the daemon assertion before implementation and ran
`pnpm --filter @forge/daemon test -- src/modules/company-module.test.ts`.
The new test failed because `company.workItems.get` omitted `specVersion` and
`currentGate`.

Added the renderer helper assertion before implementation and ran
`pnpm --filter @forge/company-desktop test`. The new test failed because no
linked-work-item run button helper existed.

### GREEN

- Enriched dashboard pipelines, work-item list entries, and
  `company.workItems.get` with accepted spec/plan versions and artifact-aware
  gates.
- Returned only non-empty linked Core run ids as `runIds`.
- Rendered persisted work items in the work center and added an
  `forge://workbench/run/<id>` button whenever `runIds[0]` exists.
- Kept `company.workItems.requestRun` as a placeholder-link operation; it does
  not create a Core run.
- Did not add Task 10's delivered-state lock.

Verification:

- `pnpm --filter @forge/daemon test -- src/modules/company-module.test.ts` — PASS (7/7)
- `pnpm --filter @forge/company-desktop test` — PASS (9/9)
- `pnpm --filter @forge/desktop exec vitest run src/product-shell-isolation.test.ts` — PASS (2/2)
- `node --check apps/company-desktop/src/renderer/app.js` — PASS
- IDE diagnostics for covering files — no errors
