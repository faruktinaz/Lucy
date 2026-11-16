import { type FormEvent, useState } from "react";

interface NoteEditorProps {
  /** Attach the new note to this task; omit for a standalone note. */
  taskId?: string;
  onClose(): void;
}

export function NoteEditor({ taskId, onClose }: NoteEditorProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body, taskId: taskId ?? null }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error: { message: string } };
        throw new Error(payload.error.message);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the note");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="note-editor" onSubmit={save} aria-label="New note">
      <input
        autoFocus
        placeholder="Title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        required
      />
      <textarea
        placeholder="Write in Markdown…"
        rows={10}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      <footer>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" disabled={saving || title.trim() === ""}>
          {saving ? "Saving…" : "Save note"}
        </button>
      </footer>
    </form>
  );
}
