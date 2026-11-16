import { readFileSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  windowSeconds: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  seedFile: string | null;
  apiToken: string | null;
  limits: Record<string, RateLimit>;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`ORBIT_PORT must be a port number, got "${value}"`);
  }
  return port;
}

function readLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return "info";
  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new Error(`ORBIT_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }
  return value as LogLevel;
}

/** Reads rate limits from TOML. Missing files fall back to no limits at all. */
export function loadLimits(path = "config/limits.toml"): Record<string, RateLimit> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const parsed = Bun.TOML.parse(text) as { limits?: Record<string, RateLimit> };
  return parsed.limits ?? {};
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  return {
    host: env.ORBIT_HOST ?? "127.0.0.1",
    port: readPort(env.ORBIT_PORT, 4180),
    logLevel: readLogLevel(env.ORBIT_LOG_LEVEL),
    seedFile: env.ORBIT_SEED_FILE || null,
    apiToken: env.ORBIT_API_TOKEN || null,
    limits: loadLimits(),
  };
}
