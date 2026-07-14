/** Shown when a run hits maxSteps — guides the user to continue in the same session. */
export function buildMaxStepsContinueHint(userMessage?: string): string {
  const task = userMessage?.trim().slice(0, 100);
  const continueText = task
    ? `继续完成：${task}。先 read_file 确认当前文件状态，统一用一种写文件工具，完成后运行验证。`
    : "继续完成剩余工作。先 read_file 确认当前状态，统一用一种写文件工具，完成后运行验证。";
  return (
    `续聊：直接输入「${continueText}」即可在同一 session 继续；` +
    "或执行 forge config set limits.maxSteps 50 提高步数上限。"
  );
}
