import type { NewTask, Page, Task, TaskFilter, TaskPatch } from "../../shared/types";

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  private sequence = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  list(filter: TaskFilter = {}, cursor?: string, limit = 50): Page<Task> {
    const all = [...this.tasks.values()]
      .filter((task) => !filter.status || task.status === filter.status)
      .filter((task) => !filter.tag || task.tags.includes(filter.tag))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

    const start = cursor ? all.findIndex((task) => task.id === decodeCursor(cursor)) + 1 : 0;
    const items = all.slice(start, start + limit);
    const last = items.at(-1);
    const hasMore = start + limit < all.length;
    return { items: items.map((task) => ({ ...task })), nextCursor: hasMore && last ? encodeCursor(last.id) : null };
  }

  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task, tags: [...task.tags] } : undefined;
  }

  create(input: NewTask): Task {
    const now = this.clock().toISOString();
    this.sequence += 1;
    const task: Task = {
      id: `tsk_${String(this.sequence).padStart(4, "0")}`,
      title: input.title,
      status: "todo",
      priority: input.priority ?? "normal",
      tags: input.tags ?? [],
      dueDate: input.dueDate ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return { ...task };
  }

  update(id: string, patch: TaskPatch): Task | undefined {
    const existing = this.tasks.get(id);
    if (!existing) return undefined;
    const updated: Task = { ...existing, ...patch, updatedAt: this.clock().toISOString() };
    this.tasks.set(id, updated);
    return { ...updated };
  }

  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  /** Inserts a task exactly as given; used when seeding from an export. */
  restore(task: Task): void {
    this.tasks.set(task.id, { ...task });
    const numeric = Number.parseInt(task.id.replace(/^tsk_/, ""), 10);
    if (Number.isInteger(numeric)) this.sequence = Math.max(this.sequence, numeric);
  }
}
