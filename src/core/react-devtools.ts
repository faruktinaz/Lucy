/**
 * Keeps `@opentui/react` from connecting to React DevTools.
 *
 * `@opentui/react` 0.9.1 checks the environment once, while its module is evaluated (top-level
 * code in `node_modules/@opentui/react/chunk-xfw77prd.js`, right after the reconciler is created):
 * when `process.env.DEV === "true"` it imports `react-devtools-core` (installed as its
 * dependency) and calls `connectToDevTools()`, which opens `ws://localhost:8097`. Creating a root
 * or rendering checks nothing further, so hiding the variable while the module is first evaluated
 * is enough, and the module cache makes later imports harmless.
 *
 * The variable is restored right after the import: embedded terminals and other child processes
 * inherit `process.env`, and the user's own `DEV` must reach their shell unchanged.
 */

let depth = 0;
let hidden: string | undefined;

/**
 * Runs `load` (a dynamic `import()` of the module graph that contains `@opentui/react`) with
 * `DEV` hidden when it is `"true"`, then restores it, also when `load` fails. Must run before
 * anything else imports `@opentui/react`, and before any child process is started (children
 * started meanwhile would not see `DEV`).
 */
export async function importWithoutReactDevTools<T>(load: () => Promise<T>): Promise<T> {
  if (depth++ === 0) {
    hidden = process.env.DEV;
    if (hidden === "true") delete process.env.DEV;
  }
  try {
    return await load();
  } finally {
    if (--depth === 0 && hidden === "true") process.env.DEV = hidden;
  }
}
