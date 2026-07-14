const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

/** Short hints under the welcome banner */
export function printWelcomeCommandHints(): void {
  console.log(dim("  ── 命令提示 ─────────────────────────────────────"));
  console.log(
    dim("  对话  ") +
      cyan("/help") +
      dim(" 帮助  ") +
      cyan("/exit") +
      dim(" 退出  ") +
      cyan("/clear") +
      dim(" 新对话  ") +
      cyan("/session") +
      dim(" 会话  ") +
      cyan("/sessions") +
      dim(" 历史  ") +
      cyan("/?") +
      dim(" 同帮助"),
  );
  console.log(
    dim("  工作区 ") +
      cyan("/cwd") +
      dim(" 查看  ") +
      cyan("/cwd <路径>") +
      dim(" 切换  ") +
      cyan("/run") +
      dim(" 运行建议命令  ") +
      cyan("/open <文件>") +
      dim(" 打开文件"),
  );
  console.log(
    dim("  上下文 ") +
      cyan("@src/foo.py") +
      dim(" 附带文件到本条消息"),
  );
  console.log(
    dim("  改代码 ") +
      yellow("v") +
      dim(" 展开  ") +
      yellow("y") +
      dim(" 应用（本轮结束后；多文件可 Y 全部应用）  ") +
      yellow("n") +
      dim(" 跳过"),
  );
  console.log(
    dim("  免确认 ") +
      cyan("forge chat -y") +
      dim("  或 ") +
      cyan('"ui":{"autoApplyPatches":true}'),
  );
  console.log(dim("  执行中 ") + yellow("Ctrl+C") + dim(" 取消当前任务"));
  console.log(dim("  输入 ") + cyan("/help") + dim(" 查看完整说明\n"));
}

/** Shown once before the first patch confirm in a run */
export function printPatchConfirmHints(): void {
  console.log(
    dim("\n  确认修改（本轮结束后，无法在中途逐条点选）：") +
      yellow("v") +
      dim(" 展开  ") +
      yellow("y") +
      dim(" 应用  ") +
      yellow("n") +
      dim(" 跳过；多个文件时 ") +
      yellow("Y") +
      dim(" 全部应用\n"),
  );
}

/** One line under folded patch summary */
export function patchFoldedHintLine(): string {
  return dim("  → 确认时按 v 展开查看，y 应用，n 跳过");
}

export function printHelp(): void {
  console.log(`
${bold("REPL 斜杠命令")}
  ${cyan("/help")}, ${cyan("/h")}              显示本帮助
  ${cyan("/exit")}, ${cyan("/quit")}, ${cyan("/q")}     退出 Forge
  ${cyan("/clear")}, ${cyan("/new")}           开始新对话（新 session）
  ${cyan("/cwd")}                   显示当前工作区目录
  ${cyan("/cwd")} <路径>              切换工作区（不存在会自动创建）
  ${cyan("/session")}               显示当前会话 ID
  ${cyan("/sessions")}              列出最近会话
  ${cyan("/resume")} <id前缀>          恢复历史会话并切换工作区
  ${cyan("/compact")} [id前缀]         压缩当前或指定会话历史
  ${cyan("/run")}                   运行「如何运行」里的建议命令（如 python3 game.py）
  ${cyan("/open")} <文件>             用系统默认程序打开文件（macOS）
  ${cyan("/model")}                   列出厂商与模型
  ${cyan("/model")} deepseek deepseek-v4-pro   切换厂商/模型

${bold("输入消息时")}
  ${cyan("@路径")}                   把文件内容附到本条消息（如 @TankBattle.py）
  普通文字                         交给 Agent 处理

${bold("代码修改确认")}（Agent 提出 patch 后）
  ${yellow("v")} 或 view / diff        展开彩色 diff 或新文件预览（可多次按 v）
  ${yellow("y")} 或 yes               应用修改
  ${yellow("n")} 或直接回车              不应用
  默认折叠为一行摘要，避免刷屏

${bold("命令行（非 REPL）")}
  forge run "任务描述" --cwd <目录>   单次执行任务
  forge run ... -y                  自动应用 patch（仍显示折叠摘要）
  forge ping                        检查 daemon 是否在线
  forge config show                 查看配置
  forge model list                    列出厂商与模型
  forge model use deepseek deepseek-v4-pro   切换厂商/模型
  forge config set model.apiKey <KEY>  设置 API Key
`);
}

const SLASH_ALIASES: Record<string, string[]> = {
  help: ["h", "?"],
  exit: ["quit", "q"],
  clear: ["new"],
  cwd: [],
  session: ["id"],
  sessions: ["ls"],
  resume: ["r"],
  compact: [],
  run: ["exec", "start"],
  open: ["o"],
  model: ["m"],
};

export function printUnknownSlash(cmd: string): void {
  const lower = cmd.toLowerCase();
  const known = Object.keys(SLASH_ALIASES);
  const near = known.filter(
    (k) => k.startsWith(lower) || lower.startsWith(k.slice(0, 2)),
  );
  console.log(`\x1b[33m未知命令: /${cmd}\x1b[0m`);
  if (near.length) {
    console.log(dim(`  你是否想输入: ${near.map((k) => "/" + k).join("  ")}`));
  }
  console.log(dim("  输入 /help 查看全部命令\n"));
}
