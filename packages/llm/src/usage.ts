export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  source: "api" | "estimate";
}

/** USD per million tokens. Cached defaults to half of input when omitted. */
interface ModelPrice {
  match: string;
  input: number;
  output: number;
  cached?: number;
}

// More specific prefixes first. Prices are approximate list rates for relative cost.
const MODEL_PRICES: ModelPrice[] = [
  { match: "gpt-4o-mini", input: 0.15, output: 0.6 },
  { match: "gpt-4.1-nano", input: 0.1, output: 0.4 },
  { match: "gpt-4.1-mini", input: 0.4, output: 1.6 },
  { match: "gpt-4.1", input: 2, output: 8 },
  { match: "gpt-4o", input: 2.5, output: 10 },
  { match: "gpt-5-mini", input: 0.25, output: 2 },
  { match: "gpt-5-nano", input: 0.05, output: 0.4 },
  { match: "gpt-5", input: 1.25, output: 10 },
  { match: "o4-mini", input: 1.1, output: 4.4 },
  { match: "o3-mini", input: 1.1, output: 4.4 },
  { match: "o3", input: 2, output: 8 },
  { match: "o1-mini", input: 1.1, output: 4.4 },
  { match: "o1", input: 15, output: 60 },
  { match: "claude-opus", input: 15, output: 75 },
  { match: "claude-sonnet", input: 3, output: 15 },
  { match: "claude-haiku", input: 0.8, output: 4 },
  { match: "claude-3-5-sonnet", input: 3, output: 15 },
  { match: "claude-3-7-sonnet", input: 3, output: 15 },
  { match: "deepseek-reasoner", input: 0.55, output: 2.19 },
  { match: "deepseek-r1", input: 0.55, output: 2.19 },
  { match: "deepseek", input: 0.27, output: 1.1 },
  { match: "gemini-2.5-pro", input: 1.25, output: 10 },
  { match: "gemini-2.5-flash", input: 0.15, output: 0.6 },
  { match: "gemini-2.0-flash", input: 0.1, output: 0.4 },
  { match: "gemini-flash", input: 0.15, output: 0.6 },
  { match: "gemini-pro", input: 1.25, output: 10 },
  { match: "qwen-plus", input: 0.4, output: 1.2 },
  { match: "qwen-turbo", input: 0.05, output: 0.2 },
  { match: "qwen-max", input: 1.6, output: 6.4 },
  { match: "qwen", input: 0.4, output: 1.2 },
];

const CHARS_PER_TOKEN = 4;

export function parseLlmUsage(value: unknown): LlmUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const prompt = readCount(
    row.prompt_tokens ?? row.input_tokens ?? row.promptTokens ?? row.inputTokens,
  );
  const completion = readCount(
    row.completion_tokens ??
      row.output_tokens ??
      row.completionTokens ??
      row.outputTokens,
  );
  if (prompt == null && completion == null) return undefined;
  const details = asRecord(row.prompt_tokens_details) ?? asRecord(row.input_tokens_details);
  const completionDetails =
    asRecord(row.completion_tokens_details) ?? asRecord(row.output_tokens_details);
  const cached = readCount(
    details?.cached_tokens ?? details?.cachedTokens ?? row.cached_tokens,
  );
  const reasoning = readCount(
    completionDetails?.reasoning_tokens ??
      completionDetails?.reasoningTokens ??
      row.reasoning_tokens,
  );
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  const total =
    readCount(row.total_tokens ?? row.totalTokens) ?? promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens: total,
    cachedTokens: cached,
    reasoningTokens: reasoning,
    source: "api",
  };
}

export function estimateLlmUsage(
  promptChars: number,
  completionChars: number,
): LlmUsage {
  const promptTokens = Math.max(0, Math.ceil(promptChars / CHARS_PER_TOKEN));
  const completionTokens = Math.max(0, Math.ceil(completionChars / CHARS_PER_TOKEN));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    source: "estimate",
  };
}

/**
 * Approximate USD cost in microdollars (1 USD = 1_000_000).
 * Returns undefined when the model has no known list price.
 */
export function estimateLlmCostMicroUsd(
  model: string,
  usage: LlmUsage,
): number | undefined {
  const price = lookupPrice(model);
  if (!price) return undefined;
  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens);
  const billedPrompt = Math.max(0, usage.promptTokens - cached);
  const cachedRate = price.cached ?? price.input * 0.5;
  const micro =
    billedPrompt * price.input +
    cached * cachedRate +
    usage.completionTokens * price.output;
  return Math.max(0, Math.round(micro));
}

export function formatUsdFromMicro(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) {
    return `$${usd.toFixed(3)}`.replace(/0+$/, "").replace(/\.$/, "");
  }
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  if (usd > 0) {
    return `$${usd.toFixed(6)}`.replace(/0+$/, "").replace(/\.$/, "");
  }
  return "$0";
}

function lookupPrice(model: string): ModelPrice | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;
  return MODEL_PRICES.find((row) => normalized.includes(row.match));
}

function readCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
