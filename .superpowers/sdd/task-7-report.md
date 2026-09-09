# Task 7 — `run.create` plan gate and run link

## Status

DONE

## TDD evidence

Two integration tests were added first using real company-domain services and
the fixture database. The RED run failed exactly as expected: an unplanned
company run resolved instead of rejecting, and an accepted-plan run created no
`company_run_links` row (2 failed, 8 passed).

## Implementation

- Wired `CompanyService`, `OrganizationService`, `WorkService`, and `WorkGates`
  into `executionRouterFixture` using its `ManualTestClock`.
- Gated `run.create` only when `companyWorkItemId` is a string.
- Mapped gate rejection to `POLICY_DENIED` / `plan not accepted`.
- Added `WorkGates.linkRun` and persisted the actual created run ID plus the
  accepted plan artifact ID.
- Preserved ordinary Workbench `run.create` behavior when the field is absent.

## Verification

- `pnpm --filter @forge/company-domain build`
- `pnpm --filter @forge/daemon test -- src/modules/execution-module.test.ts`
  — 10 passed.
- `pnpm --filter @forge/company-domain test` — 12 passed.
- `pnpm --filter @forge/daemon build` — passed.
- IDE lint diagnostics for all three changed source files — clean.

## Concerns

The isolated daemon test resolves `@forge/company-domain` through its built
package output, so the company-domain package must be built after source API
changes before running that daemon test in a stale workspace.

## Fix

### Covering files

- `packages/company-domain/src/work-gates.ts`
- `apps/daemon/src/modules/execution-module.ts`
- `apps/daemon/src/modules/execution-module.test.ts`

### Commands

- `pnpm --filter @forge/company-domain test`
- `pnpm --filter @forge/company-domain build`
- `pnpm --filter @forge/daemon test -- src/modules/execution-module.test.ts`

### RED

The daemon regression run failed for the intended reasons before the fix:

```text
src/modules/execution-module.test.ts (11 tests | 2 failed)
× links a company-gated run to its accepted plan
  expected 1 company_run_links row, received the empty placeholder plus a filled row
× maps unexpected company gate failures to INTERNAL_ERROR
  expected INTERNAL_ERROR, received POLICY_DENIED / plan not accepted
Tests  2 failed | 9 passed (11)
```

### GREEN

```text
@forge/company-domain
Test Files  4 passed (4)
Tests  12 passed (12)

@forge/daemon src/modules/execution-module.test.ts
Test Files  1 passed (1)
Tests  11 passed (11)
```

`WorkGates.linkRun` now updates the matching empty placeholder inside a
transaction and inserts only when none exists. `run.create` maps only errors
whose message matches `/plan not accepted/` to `POLICY_DENIED`; other failures
flow through the router's existing `INTERNAL_ERROR` normalization.
