/** Typed access to `Config` values by setting path, plus the structural helpers around it. */
import { type Config, type SettingPath, type SettingValue, settingsSchema } from "./schema";

/** Deep copy of JSON-like data (config values are only primitives, arrays and plain objects). */
export function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item);
    return out as T;
  }
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Structural equality for JSON-like data; object key order does not matter. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function splitPath(path: string): [string, string] {
  const dot = path.indexOf(".");
  return [path.slice(0, dot), path.slice(dot + 1)];
}

/** A fresh, fully defaulted config. */
export function defaultConfig(): Config {
  const out: Record<string, Record<string, unknown>> = {};
  for (const descriptor of settingsSchema) {
    const section = out[descriptor.section] ?? {};
    section[descriptor.key] = cloneValue(descriptor.default);
    out[descriptor.section] = section;
  }
  return out as Config;
}

export function getSetting<P extends SettingPath>(config: Config, path: P): SettingValue<P> {
  const [section, key] = splitPath(path);
  return (config as unknown as Record<string, Record<string, unknown>>)[section]?.[key] as SettingValue<P>;
}

/** Returns a new config with one setting replaced; untouched sections keep their identity. */
export function withSetting<P extends SettingPath>(config: Config, path: P, value: SettingValue<P>): Config {
  const [section, key] = splitPath(path);
  const sections = config as unknown as Record<string, Record<string, unknown>>;
  return { ...config, [section]: { ...sections[section], [key]: cloneValue(value) } } as Config;
}

/** Paths whose values differ between two configs, in schema order. */
export function changedPaths(previous: Config, next: Config): SettingPath[] {
  return settingsSchema
    .filter((d) => !deepEqual(getSetting(previous, d.path), getSetting(next, d.path)))
    .map((d) => d.path);
}
