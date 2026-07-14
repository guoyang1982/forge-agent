/** Heuristic: user message likely expects tool use (read/edit/run), not chat-only. */
export function looksLikeCodingTask(message: string): boolean {
  const m = message.trim();
  if (!m) return false;
  if (/@[^\s@]+/.test(m)) return true;
  if (/\.(py|ts|tsx|js|jsx|go|rs|java|kt|md|json|yaml|yml|toml)\b/i.test(m)) {
    return true;
  }
  return /继续|完成|修复|实现|处理|优化|编写|修改|添加|删除|重构|调试|运行|测试|continue|fix|implement|refactor|debug|write|edit|process/i.test(
    m,
  );
}
