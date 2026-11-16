export interface Command {
  id: string;
  title: string;
  /** Extra words that should match even though they do not appear in the title. */
  keywords: string[];
  shortcut?: string;
  run(): void | Promise<void>;
}

export interface CommandDependencies {
  reload(): Promise<void>;
  openNoteEditor(): void;
}

function toggleTheme(): void {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("orbit.theme", root.dataset.theme);
}

export function createCommands(deps: CommandDependencies): Command[] {
  return [
    {
      id: "note.new",
      title: "New note",
      keywords: ["write", "create", "markdown"],
      shortcut: "ctrl+n",
      run: deps.openNoteEditor,
    },
    {
      id: "tasks.reload",
      title: "Reload tasks",
      keywords: ["refresh", "sync"],
      run: deps.reload,
    },
    {
      id: "theme.toggle",
      title: "Toggle dark mode",
      keywords: ["theme", "appearance", "light"],
      run: toggleTheme,
    },
  ];
}

/** Case-insensitive substring match on titles and keywords, in registration order. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return commands;
  return commands.filter(
    (command) =>
      command.title.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.includes(needle)),
  );
}
