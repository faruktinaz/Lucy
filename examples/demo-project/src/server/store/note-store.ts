import type { NewNote, Note } from "../../shared/types";

export class NoteStore {
  private readonly notes = new Map<string, Note>();
  private sequence = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  list(taskId?: string): Note[] {
    return [...this.notes.values()]
      .filter((note) => taskId === undefined || note.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((note) => ({ ...note }));
  }

  create(input: NewNote): Note {
    const now = this.clock().toISOString();
    this.sequence += 1;
    const note: Note = {
      id: `not_${String(this.sequence).padStart(4, "0")}`,
      title: input.title,
      body: input.body,
      taskId: input.taskId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.notes.set(note.id, note);
    return { ...note };
  }

  remove(id: string): boolean {
    return this.notes.delete(id);
  }

  /** Keeps notes when their task is deleted, but turns them into standalone notes. */
  detachFromTask(taskId: string): number {
    let detached = 0;
    for (const note of this.notes.values()) {
      if (note.taskId === taskId) {
        note.taskId = null;
        detached += 1;
      }
    }
    return detached;
  }
}
