import type { ChatMessage } from "@forge/protocol";

export class RunCancelledError extends Error {
  readonly messages: ChatMessage[];

  constructor(messages: ChatMessage[]) {
    super("任务已取消");
    this.name = "RunCancelledError";
    this.messages = messages;
  }
}

export class AgentMaxStepsError extends Error {
  readonly messages: ChatMessage[];

  constructor(messages: ChatMessage[]) {
    super("已达最大步数限制");
    this.name = "AgentMaxStepsError";
    this.messages = messages;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof DOMException && e.name === "AbortError" ||
    (e instanceof Error && e.name === "AbortError")
  );
}
