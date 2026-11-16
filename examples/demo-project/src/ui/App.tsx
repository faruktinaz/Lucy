import { useEffect, useMemo, useState } from "react";
import { createCommands } from "../features/palette/commands";
import { CommandPalette } from "./components/CommandPalette";
import { NoteEditor } from "./components/NoteEditor";
import { TaskList } from "./components/TaskList";
import { useTasks } from "./hooks/use-tasks";

/** Every global shortcut lives in this table so conflicts are easy to spot in review. */
const SHORTCUTS: Record<string, string> = {
  "ctrl+n": "note.new",
  "ctrl+k": "palette.open",
};

function chordOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
}

export function App() {
  const { tasks, loading, error, setStatus, reload } = useTasks();
  const [editorOpen, setEditorOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const commands = useMemo(
    () => createCommands({ reload, openNoteEditor: () => setEditorOpen(true) }),
    [reload],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = SHORTCUTS[chordOf(event)];
      if (!action) return;
      event.preventDefault();
      if (action === "note.new") setEditorOpen(true);
      if (action === "palette.open") setPaletteOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reload]);

  return (
    <main className="app">
      <header className="app__header">
        <h1>Orbit</h1>
        {loading && <span className="app__status">Loading…</span>}
        {error && <span className="app__status app__status--error">{error}</span>}
      </header>
      <TaskList tasks={tasks} onStatusChange={setStatus} />
      {editorOpen && <NoteEditor onClose={() => setEditorOpen(false)} />}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </main>
  );
}
