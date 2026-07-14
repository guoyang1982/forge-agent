/** Parse a simple command line (supports "quoted args"). No shell metacharacters. */
export function parseCommandLine(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

const FORBIDDEN_CHAR = /[;&|`$<>\\]/;

const NPM_OK = new Set(["test", "run", "start", "install", "ci"]);
const PIP_OK = new Set(["install"]);
const GIT_FETCH_FLAGS = new Set(["--all", "--prune", "--tags"]);
const GIT_BRANCH_FLAGS = new Set(["-a", "-r", "--all", "--remotes", "--list", "-v", "-vv"]);
const GIT_LOG_FLAGS = new Set([
  "--all",
  "--decorate",
  "--graph",
  "--name-only",
  "--name-status",
  "--oneline",
  "--stat",
]);
const GIT_DIFF_FLAGS = new Set([
  "--cached",
  "--check",
  "--name-only",
  "--name-status",
  "--stat",
  "--summary",
]);
const GIT_FETCH_ARG = /^[A-Za-z0-9._/:+-]+$/;
const GIT_REF_ARG = /^[A-Za-z0-9._/:+-]+$/;

export interface SafeCommand {
  file: string;
  args: string[];
}

/** Metacharacters only matter outside quotes — spawn uses argv, not a shell. */
function hasForbiddenOutsideQuotes(command: string): string | null {
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (FORBIDDEN_CHAR.test(ch)) {
      return (
        "Forbidden shell metacharacters outside quotes (; | & ` $ < > \\). " +
        "For python -c with ';', wrap the script in single or double quotes."
      );
    }
    if (ch === "." && command[i + 1] === ".") {
      return "Path traversal (..) is not allowed in commands";
    }
  }
  return null;
}

const MAX_PYTHON_C_CHARS = 16_000;

function validatePythonArgs(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  if (args[0] !== "-c") return { ok: true };
  const code = args[1];
  if (!code) {
    return { ok: false, error: "python -c requires a code argument" };
  }
  if (code.length > MAX_PYTHON_C_CHARS) {
    return {
      ok: false,
      error: `python -c script too long (max ${MAX_PYTHON_C_CHARS} chars); use a .py file instead`,
    };
  }
  return { ok: true };
}

function normalizePythonArgs(args: string[]): string[] {
  if (args[0] !== "-c") return args;
  if (args.length <= 2) return args;
  // Models sometimes emit python -c without quoting the code.
  // Since we run with shell:false, join the remaining argv back into one code string.
  return ["-c", args.slice(1).join(" ")];
}

function isSafeGitRefArg(arg: string): boolean {
  return (
    GIT_REF_ARG.test(arg) &&
    !arg.includes("../") &&
    !arg.includes("/..") &&
    !arg.startsWith("..")
  );
}

function validateGitArgs(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  const subcommand = args[0];
  if (subcommand === "status") return { ok: true };
  if (subcommand === "diff") return validateGitDiffArgs(args.slice(1));
  if (subcommand === "branch") {
    return validateGitBranchArgs(args.slice(1));
  }
  if (subcommand === "log") {
    return validateGitLogArgs(args.slice(1));
  }
  if (subcommand === "fetch") {
    return validateGitFetchArgs(args.slice(1));
  }

  return {
    ok: false,
    error:
      "Only 'git status', 'git diff', 'git branch', 'git log', and safe 'git fetch' forms are allowed",
  };
}

function validateGitFetchArgs(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!GIT_FETCH_FLAGS.has(arg)) {
        return { ok: false, error: `git fetch option not allowed: ${arg}` };
      }
      continue;
    }
    if (!GIT_FETCH_ARG.test(arg)) {
      return { ok: false, error: `git fetch argument not allowed: ${arg}` };
    }
  }
  return { ok: true };
}

function validateGitBranchArgs(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  let allowListPattern = false;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!GIT_BRANCH_FLAGS.has(arg)) {
        return { ok: false, error: `git branch option not allowed: ${arg}` };
      }
      if (arg === "--list") allowListPattern = true;
      continue;
    }
    if (!allowListPattern) {
      return { ok: false, error: `git branch argument not allowed: ${arg}` };
    }
    if (!GIT_REF_ARG.test(arg)) {
      return { ok: false, error: `git branch pattern not allowed: ${arg}` };
    }
    if (!isSafeGitRefArg(arg)) {
      return { ok: false, error: `git branch pattern not allowed: ${arg}` };
    }
  }
  return { ok: true };
}

function validateGitDiffArgs(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  for (const arg of args) {
    if (/^-U\d+$/.test(arg)) continue;
    if (arg.startsWith("-")) {
      if (!GIT_DIFF_FLAGS.has(arg)) {
        return { ok: false, error: `git diff option not allowed: ${arg}` };
      }
      continue;
    }
    if (!isSafeGitRefArg(arg)) {
      return { ok: false, error: `git diff ref not allowed: ${arg}` };
    }
  }
  return { ok: true };
}

function validateGitLogArgs(
  args: string[],
): { ok: true } | { ok: false; error: string } {
  let expectCount = false;
  for (const arg of args) {
    if (expectCount) {
      expectCount = false;
      if (!/^\d+$/.test(arg)) {
        return { ok: false, error: `git log count not allowed: ${arg}` };
      }
      continue;
    }
    if (arg === "-n") {
      expectCount = true;
      continue;
    }
    if (/^-\d+$/.test(arg) || /^--max-count=\d+$/.test(arg)) continue;
    if (arg.startsWith("-")) {
      if (!GIT_LOG_FLAGS.has(arg)) {
        return { ok: false, error: `git log option not allowed: ${arg}` };
      }
      continue;
    }
    if (!isSafeGitRefArg(arg)) {
      return { ok: false, error: `git log ref not allowed: ${arg}` };
    }
  }
  if (expectCount) return { ok: false, error: "git log -n requires a count" };
  return { ok: true };
}

export function validateShellCommand(
  command: string,
): { ok: true; cmd: SafeCommand } | { ok: false; error: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, error: "Empty command" };
  }

  const parts = parseCommandLine(trimmed);
  if (!parts.length) {
    return { ok: false, error: "Could not parse command" };
  }

  const bin = parts[0];
  const restRaw = parts.slice(1);
  const rest =
    bin === "python3" || bin === "python"
      ? normalizePythonArgs(restRaw)
      : restRaw;
  const isPythonInlineCode =
    (bin === "python3" || bin === "python") && rest[0] === "-c";

  const unsafeErr = hasForbiddenOutsideQuotes(trimmed);
  const isGitRefRangeCommand =
    bin === "git" && (rest[0] === "diff" || rest[0] === "log");
  if (
    unsafeErr &&
    !isPythonInlineCode &&
    !(isGitRefRangeCommand && unsafeErr === "Path traversal (..) is not allowed in commands")
  ) {
    return { ok: false, error: unsafeErr };
  }

  if (bin === "./mvnw") {
    return { ok: true, cmd: { file: bin, args: rest } };
  }

  switch (bin) {
    case "python3":
    case "python": {
      const pyCheck = validatePythonArgs(rest);
      if (!pyCheck.ok) return pyCheck;
      return { ok: true, cmd: { file: bin, args: rest } };
    }
    case "node":
    case "pytest":
    case "gradle":
      return { ok: true, cmd: { file: bin, args: rest } };
    case "go":
      if (rest[0] !== "test") {
        return { ok: false, error: "Only 'go test' is allowed" };
      }
      return { ok: true, cmd: { file: bin, args: rest } };
    case "git":
      if (!rest[0]) return { ok: false, error: "Missing git subcommand" };
      {
        const gitCheck = validateGitArgs(rest);
        if (!gitCheck.ok) return gitCheck;
      }
      return { ok: true, cmd: { file: bin, args: rest } };
    case "npm":
    case "pnpm":
    case "yarn":
      if (!rest[0] || !NPM_OK.has(rest[0])) {
        return {
          ok: false,
          error: `Only ${bin} test|run|start|install|ci are allowed`,
        };
      }
      return { ok: true, cmd: { file: bin, args: rest } };
    case "mvn": {
      const sub = rest.join(" ");
      const okMvn =
        sub === "test" ||
        sub === "-q test" ||
        sub === "compile" ||
        sub === "-q compile";
      if (!okMvn) {
        return {
          ok: false,
          error: "Only mvn test|compile (optional -q prefix) allowed",
        };
      }
      return { ok: true, cmd: { file: bin, args: rest } };
    }
    case "pip":
    case "pip3":
      if (rest[0] !== "install") {
        return { ok: false, error: "Only pip install is allowed" };
      }
      return { ok: true, cmd: { file: bin, args: rest } };
    default:
      return {
        ok: false,
        error: `Command not allowed: ${bin}. Use documented test/run tools.`,
      };
  }
}
