/**
 * File logger.
 *
 * The TUI owns stdout/stderr, so logging there would corrupt the screen: the default logger
 * is a no-op until `configureLogger` points it at a file. Secrets are redacted before
 * anything is written, and PTY/terminal payloads must never be passed to the logger.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY =
  /(token|secret|passw(or)?d|api[-_]?key|authorization|cookie|credential|private[-_]?key|session[-_]?id)/i;

const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})\b/g;

const REDACTED = "[redacted]";

/** Returns a deep copy with secret-looking keys and values masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(SECRET_VALUE, REDACTED);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: redact(value.stack ?? "") };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  /**
   * Absolute path of the log file. Parent directories are created on first write (0700), and
   * the file itself is created 0600.
   */
  file?: string;
  level?: LogLevel;
  /** Alternative destination (tests). Receives one formatted line without a newline. */
  sink?: (line: string) => void;
}

let options: LoggerOptions = {};
let queue: Promise<void> = Promise.resolve();
let directoryReady = false;

/** Points the global logger at a destination. Call once during bootstrap. */
export function configureLogger(next: LoggerOptions): void {
  options = { ...next };
  directoryReady = false;
}

/** Resolves once every queued write reached the file. Used on shutdown and in tests. */
export function flushLogs(): Promise<void> {
  return queue;
}

function write(level: LogLevel, scope: string, message: string, data: unknown): void {
  const { file, sink } = options;
  if (!file && !sink) return;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level ?? "info"]) return;

  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ""}${redact(message)}`;
  if (data !== undefined) {
    try {
      line += ` ${JSON.stringify(redact(data))}`;
    } catch {
      line += " [unserializable]";
    }
  }

  if (sink) {
    sink(line);
    return;
  }
  if (!file) return;
  queue = queue
    .then(async () => {
      if (!directoryReady) {
        // Lucy's own directories are private (0700); existing ones are left as they are.
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        directoryReady = true;
      }
      // 0600 on creation: diagnostics are redacted, but still describe the user's work.
      await appendFile(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    })
    .catch(() => {
      // Logging must never take the app down.
    });
}

function createScoped(scope: string): Logger {
  return {
    debug: (message, data) => write("debug", scope, message, data),
    info: (message, data) => write("info", scope, message, data),
    warn: (message, data) => write("warn", scope, message, data),
    error: (message, data) => write("error", scope, message, data),
    child: (name) => createScoped(scope ? `${scope}:${name}` : name),
  };
}

/** Global logger. Prefer `log.child("git")` in modules so lines carry their origin. */
export const log: Logger = createScoped("");
