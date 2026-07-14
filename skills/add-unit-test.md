---
name: Add unit test
triggers: add test, unit test, 加测试, 单元测试, 测试类
---

1. Find existing test layout with list_dir/grep (*Test*, *test_*).
2. Match project test framework (JUnit5, vitest, pytest).
3. Add focused test via write_patch (create-file patch if needed).
4. Run tests to verify.
