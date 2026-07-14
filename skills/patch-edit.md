---
name: Reliable patches
triggers: write_patch, patch, 优化, 重构, refactor, 修改, edit
---

1. **read_file** the target path immediately before **write_patch**.
2. Copy context lines from read_file output exactly (` ` and `-` lines in diff).
3. Small edits only; if changing >30 lines or whole-file optimization → **write_file** with `overwrite: true`.
4. On dry-run failure: use returned `line`, `expected`, `actual` — fix hunk `@@` line number or switch to overwrite.
5. Never retry the same broken patch twice.
