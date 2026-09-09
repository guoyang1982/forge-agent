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
