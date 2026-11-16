/**
 * Screenshot scenarios for the Search view and Quick Open, against the demo workspace (a Git
 * repository, so the search runs with git grep here; the machine has no real ripgrep).
 */
import { defineScenario, type ScenarioContext, SIZES } from "../screenshots";

const SUMMARY = /results? in /;

async function showSearch(app: ScenarioContext): Promise<void> {
  await app.tui.act(() => app.ctx.commands.execute("view.showSearch"));
}

/** Types a query into the focused pattern field and waits for the finished summary. */
async function search(app: ScenarioContext, text: string, done: string | RegExp = SUMMARY): Promise<void> {
  await showSearch(app);
  await app.tui.type(text);
  await app.tui.waitForText(done, { timeoutMs: 10_000 });
  // Let the delayed spinner and the last streamed batch settle.
  await app.tui.advance(400);
}

const BOTH = [SIZES.wide, SIZES.medium];

defineScenario(
  "search-results",
  async (app) => {
    await search(app, "TaskStore");
    for (let i = 0; i < 4; i++) await app.tui.press("down");
  },
  { description: "Search results grouped by file, a match selected in the focused list", sizes: BOTH },
);

defineScenario(
  "search-collapsed",
  async (app) => {
    await search(app, "task");
    await app.tui.press("down");
    await app.tui.press("left");
    await app.tui.act(() => app.ctx.focus.focus("editor"));
  },
  {
    description: "The first file collapsed; selection shown in the unfocused list style",
    sizes: BOTH,
  },
);

defineScenario(
  "search-details",
  async (app) => {
    await showSearch(app);
    await app.tui.act(() => app.ctx.commands.execute("search.toggleDetails"));
    await app.tui.press("tab");
    await app.tui.type("src/server");
    await app.tui.press("tab");
    await app.tui.type("*.test.ts");
    await app.tui.press("shift+tab");
    await app.tui.press("shift+tab");
    await app.tui.type("export");
    await app.tui.waitForText(SUMMARY, { timeoutMs: 10_000 });
    await app.tui.advance(400);
  },
  { description: "Files to include and exclude open, with globs, results narrowed", sizes: BOTH },
);

defineScenario(
  "search-no-results",
  async (app) => {
    await showSearch(app);
    await app.tui.act(() => app.ctx.commands.execute("search.toggleMatchCase"));
    await app.tui.act(() => app.ctx.commands.execute("search.toggleWholeWord"));
    await app.tui.type("taskstorage");
    await app.tui.waitForText("No results", { timeoutMs: 10_000 });
  },
  { description: "No results, with the filters that are on and a way to turn them off", sizes: BOTH },
);

defineScenario(
  "search-invalid-regex",
  async (app) => {
    await showSearch(app);
    await app.tui.act(() => app.ctx.commands.execute("search.toggleRegex"));
    await app.tui.type("route(");
    await app.tui.waitForText(/[Ii]nvalid/, { timeoutMs: 10_000 });
  },
  { description: "An invalid regular expression: the engine's message under the field", sizes: BOTH },
);

defineScenario(
  "search-idle",
  async (app) => {
    await showSearch(app);
    await app.tui.advance(300);
  },
  { description: "Before the first search: a sentence, the keys and the engine", sizes: BOTH },
);

defineScenario(
  "search-quick-open",
  async (app) => {
    await app.tui.act(() => app.ctx.commands.execute("file.quickOpen"));
    await app.tui.type("storets");
    await app.tui.waitForText("task-store.ts", { timeoutMs: 10_000 });
  },
  { description: "Quick Open: file names with folders dimmed, separate highlights", sizes: BOTH },
);

defineScenario(
  "search-quick-open-line",
  async (app) => {
    await app.tui.act(() => app.ctx.commands.execute("file.quickOpen"));
    await app.tui.type("routes:12:5");
    await app.tui.waitForText("line 12", { timeoutMs: 10_000 });
  },
  { description: "Quick Open with a :line:column suffix", sizes: BOTH },
);

defineScenario(
  "search-narrow",
  async (app) => {
    await search(app, "TaskStore");
    await app.tui.press("down");
    await app.tui.press("down");
  },
  { description: "Below 80 columns the Search view opens as a drawer", sizes: [SIZES.narrow] },
);
