---
name: Fix failing tests
triggers: fix test, failing test, 修测试, 测试失败, test failed
---

1. Run tests with run_command (pnpm test / mvn test / pytest).
2. Read failure output; locate files with read_file/grep.
3. Apply minimal fix with write_patch.
4. Re-run tests until pass or explain blocker.
