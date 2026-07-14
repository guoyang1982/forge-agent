import type { ThinkingDisplayMode } from "@forge/protocol";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function writeStatusLine(text: string): void {
  process.stderr.write(`\r\x1b[2K${text}`);
}

function clearStatusLine(): void {
  process.stderr.write("\r\x1b[2K");
}

function eraseLines(count: number): void {
  for (let i = 0; i < count; i++) {
    process.stderr.write("\x1b[1A\x1b[2K");
  }
}

/** Terminal UI for model reasoning_content (DeepSeek thinking mode). */
export class ThinkingDisplay {
  private active = false;
  private lineCount = 0;
  private charCount = 0;
  private startedAt = 0;
  /** Incomplete line from streamed deltas (no trailing newline yet). */
  private buffer = "";
  /** True when a partial line is shown with \\r (not yet committed). */
  private partialOnScreen = false;

  constructor(private readonly mode: ThinkingDisplayMode = "collapse") {}

  start(): void {
    if (this.mode === "hidden") {
      this.active = true;
      this.startedAt = Date.now();
      this.charCount = 0;
      writeStatusLine(dim("  ◐ 思考中…"));
      return;
    }
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this.charCount = 0;
    this.lineCount = 0;
    this.buffer = "";
    this.partialOnScreen = false;
    process.stderr.write(`\n${cyan("  ▼ Thinking")}\n`);
    this.lineCount = 1;
  }

  delta(text: string): void {
    if (!text) return;
    if (!this.active) this.start();
    this.charCount += text.length;

    if (this.mode === "hidden") {
      writeStatusLine(dim(`  ◐ 思考中… (${this.charCount} 字)`));
      return;
    }

    this.buffer += text;
    this.flushCompleteLines();
    this.refreshPartialLine();
  }

  end(durationMs?: number): void {
    if (!this.active) return;
    this.clearPartialLine();
    if (this.buffer.length > 0) {
      this.emitLine(this.buffer);
      this.buffer = "";
    }

    const sec =
      durationMs != null
        ? (durationMs / 1000).toFixed(1)
        : ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const summary = `思考完成 · ${this.charCount} 字 · ${sec}s`;

    if (this.mode === "hidden") {
      clearStatusLine();
      process.stderr.write(dim(`  ▸ ${summary}\n`));
    } else if (this.mode === "collapse" && this.lineCount > 0) {
      eraseLines(this.lineCount);
      process.stderr.write(dim(`  ▸ ${summary}\n`));
    } else {
      process.stderr.write(dim(`\n  ▸ ${summary}\n`));
    }

    this.active = false;
    this.lineCount = 0;
    this.charCount = 0;
    this.buffer = "";
    this.partialOnScreen = false;
  }

  reset(): void {
    if (this.mode === "hidden" && this.active) clearStatusLine();
    this.clearPartialLine();
    this.active = false;
    this.lineCount = 0;
    this.charCount = 0;
    this.buffer = "";
    this.partialOnScreen = false;
  }

  private flushCompleteLines(): void {
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.clearPartialLine();
      this.emitLine(line);
    }
  }

  /** Show in-progress line on one row (streamed token-by-token). */
  private refreshPartialLine(): void {
    if (!this.buffer) {
      this.clearPartialLine();
      return;
    }
    const max = Math.max(40, (process.stderr.columns || 80) - 6);
    const tail =
      this.buffer.length > max
        ? "…" + this.buffer.slice(-(max - 1))
        : this.buffer;
    process.stderr.write(`\r\x1b[2K${dim(`  │ ${tail}`)}`);
    this.partialOnScreen = true;
  }

  private clearPartialLine(): void {
    if (!this.partialOnScreen) return;
    process.stderr.write("\r\x1b[2K");
    this.partialOnScreen = false;
  }

  private emitLine(line: string): void {
    if (line.length === 0) {
      process.stderr.write(dim("  │\n"));
    } else {
      process.stderr.write(dim(`  │ ${line}\n`));
    }
    this.lineCount++;
  }
}
