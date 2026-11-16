/**
 * Redirects OpenTUI's GLOBAL tree-sitter data directory.
 *
 * Widgets that are not handed Lucy's client (a `<markdown>` without `treeSitterClient`, or any
 * `<code>` someone forgets to wire) use OpenTUI's global client, whose worker creates
 * `<globalDataPath>/tree-sitter/{languages,queries}`. By default that is
 * `$XDG_DATA_HOME/opentui` or `~/.local/share/opentui`, which Lucy must never write to.
 *
 * Why this mechanism: `DataPathsManager` (from `getDataPaths()`) only lets callers change
 * `appName`, which still lands under `~/.local/share`. Steering it through `XDG_DATA_HOME` would
 * leak into every child process (the embedded terminal, Git). So the singleton's
 * `globalDataPath` getter is shadowed by an own property, and the manager's own
 * `paths:changed` event is emitted: the global client created by `getTreeSitterClient()`
 * listens to it and calls `setDataPath()`, and a client created later reads the new value.
 */
import { isAbsolute, resolve } from "node:path";
import { getDataPaths } from "@opentui/core";
import { LucyError } from "@/core/errors";
import type { Disposable } from "@/core/events";

/**
 * Points OpenTUI's global data path at `dir` (absolute). Call it during bootstrap, before the
 * first renderer is created; calling it later still moves a live global client. The returned
 * disposable only removes the override for clients created afterwards: it deliberately does not
 * notify a live client, so disposing can never move writes back to the home directory.
 */
export function configureOpenTuiDataPath(dir: string): Disposable {
  if (!isAbsolute(dir)) {
    throw new LucyError("INVALID_ARGUMENT", `OpenTUI data path must be absolute: ${dir}`, {
      details: { dir },
    });
  }
  const target = resolve(dir);
  const paths = getDataPaths();
  const getter = (): string => target;
  Object.defineProperty(paths, "globalDataPath", { configurable: true, enumerable: true, get: getter });
  paths.emit("paths:changed", paths.toObject());

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = Object.getOwnPropertyDescriptor(paths, "globalDataPath");
      // Only remove our own override, never a newer one installed after us.
      if (current?.get === getter) Reflect.deleteProperty(paths, "globalDataPath");
    },
  };
}
