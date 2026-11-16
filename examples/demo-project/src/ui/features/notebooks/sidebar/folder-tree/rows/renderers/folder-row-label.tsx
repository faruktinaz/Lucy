interface FolderRowLabelProps {
  name: string;
  noteCount: number;
  depth: number;
  expanded: boolean;
  /** Width available for the label, in characters, after indentation. */
  maxCharacters: number;
}

const INDENT_PER_LEVEL = 12;

/** Shortens long folder names in the middle so both the start and the end stay readable. */
export function truncateMiddle(name: string, maxCharacters: number): string {
  if (name.length <= maxCharacters) return name;
  if (maxCharacters <= 1) return "…";
  const keep = maxCharacters - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

export function FolderRowLabel({ name, noteCount, depth, expanded, maxCharacters }: FolderRowLabelProps) {
  const label = truncateMiddle(name, maxCharacters);

  return (
    <span
      className="folder-row-label"
      style={{ paddingInlineStart: depth * INDENT_PER_LEVEL }}
      title={label === name ? undefined : name}
    >
      <span aria-hidden="true" className="folder-row-label__chevron">
        {expanded ? "▾" : "▸"}
      </span>
      <span className="folder-row-label__name">{label}</span>
      {noteCount > 0 && (
        <span className="folder-row-label__count" aria-label={`${noteCount} notes`}>
          {noteCount}
        </span>
      )}
    </span>
  );
}
