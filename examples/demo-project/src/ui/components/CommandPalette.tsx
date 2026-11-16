import { type KeyboardEvent, useMemo, useState } from "react";
import { type Command, filterCommands } from "../../features/palette/commands";

interface CommandPaletteProps {
  commands: Command[];
  onClose(): void;
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterCommands(commands, query), [commands, query]);

  function runCommand(command: Command | undefined) {
    if (!command) return;
    onClose();
    void command.run();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runCommand(matches[0]);
    }
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          className="palette__input"
          placeholder="Type a command…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="palette__results" role="listbox">
          {matches.map((command, index) => (
            <li
              key={command.id}
              role="option"
              aria-selected={index === 0}
              onClick={() => runCommand(command)}
            >
              <span>{command.title}</span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </li>
          ))}
          {matches.length === 0 && <li className="palette__empty">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
