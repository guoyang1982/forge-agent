---
name: Greenfield app / demo
triggers: 开发, 新建, 游戏, 从零, demo, 做个, 实现一个, snake, 贪吃蛇
---

1. Prefer **write_file** for new files (single shot). Use write_patch only to edit existing files.
2. Do NOT call write_patch 3+ times for the same path — read tool error and fix format.
3. After creating runnable code, end with a **## 如何运行** section:
   - exact `cd` path
   - exact run command (python3 / npm run / etc.)
4. Optionally verify with run_command if command is allowed.
5. Keep first version minimal (one main file OK for demos).
