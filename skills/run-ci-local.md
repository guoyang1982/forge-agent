---
name: Run CI locally
triggers: ci, pipeline, github actions, 流水线, workflow
---

1. Find .github/workflows or CI config with list_dir/read_file.
2. Map to local commands (test, lint, build).
3. run_command allowed tools only; report failures with logs.
