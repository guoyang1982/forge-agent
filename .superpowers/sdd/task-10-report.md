# Task 10 TDD Report

## Status

DONE

## Scope delivered

- Added `buildDeliveryTrace(db, workItemId)` with the protocol `DeliveryTrace` shape.
- Added `canMarkDelivered(trace)` with the exact P0 gate: accepted spec, accepted plan, and at least one non-empty linked run.
- Exported both functions from `@forge/company-domain`.
- Added `trace` to enriched work-item responses and derived legacy `specVersion`, `planVersion`, and `runIds` from that same trace.
- Added the work-center delivery chain: work item → spec → plan → run/artifact.
- The renderer only shows `已交付` for a complete trace.
- Existing `pauseForFix` renderer action remains wired to `company.workItems.pauseForFix`.

## RED evidence

1. Wrote `packages/company-domain/src/delivery-trace.test.ts` before production code.
2. Ran `pnpm --filter @forge/company-domain exec vitest run src/delivery-trace.test.ts`.
   - Failed because `./delivery-trace.js` did not exist.
3. Added the daemon response assertion before integrating the trace.
   - `company-module.test.ts` failed because `trace` was absent.
4. Added the renderer guardrail assertion before adding renderer helpers.
   - `security.test.ts` failed because `canMarkDelivered`/`deliveryTraceHtml` were absent.

## GREEN implementation

- Queried only `status = 'accepted'` spec and plan versions.
- Filtered linked runs with `TRIM(run_id) <> ''`.
- Included all intent/spec/plan artifact IDs for the work item.
- Returned `validationIds: []` for P0.
- Reused the built trace in daemon enrichment to prevent field divergence.

## Verification

- Store migration: 4/4 passed.
- Company domain: 15/15 passed.
- Daemon company + execution modules: 18/18 passed.
- Company desktop: 10/10 passed.
- Main desktop: 206/206 passed.
- TypeScript build for `@forge/company-domain`: passed.
- Changed-file IDE diagnostics: none.
- `git diff --check`: passed.

## Note

The brief's daemon `pnpm ... exec vitest` form cannot resolve `vitest` because the daemon package has no direct Vitest dependency. Verification used its repository test script, which invokes the pinned workspace Vitest binary.

## Fix: validation evidence

### Covering files

- `packages/company-domain/src/delivery-trace.ts`
- `packages/company-domain/src/delivery-trace.test.ts`
- `apps/company-desktop/src/renderer/app.js`
- `apps/company-desktop/src/security.test.ts`

### RED

- `pnpm --filter @forge/company-domain exec vitest run src/delivery-trace.test.ts`
  - Failed 1/3 tests: the linked validation was expected but `validationIds` remained empty.
- `pnpm --filter @forge/company-desktop test`
  - Failed 1/10 tests: the rendered delivery chain omitted `验证证据`.

### GREEN

- `pnpm --filter @forge/company-domain exec vitest run src/delivery-trace.test.ts`
  - Passed: 1 file, 3 tests.
- `pnpm --filter @forge/company-desktop test`
  - Passed: 1 file, 10 tests.
- Changed-file IDE diagnostics: none.
