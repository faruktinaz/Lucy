export type TaskStatus = "todo" | "in_progress" | "done";
export type Priority = "low" | "normal" | "high";

export const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done"];
export const PRIORITIES: readonly Priority[] = ["low", "normal", "high"];

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: Priority;
  tags: string[];
  /** Calendar date (YYYY-MM-DD) without a time zone, or null when undated. */
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  /** The task this note belongs to, or null for a standalone note. */
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  title: string;
  priority?: Priority;
  tags?: string[];
  dueDate?: string | null;
}

export type TaskPatch = Partial<Pick<Task, "title" | "status" | "priority" | "tags" | "dueDate">>;

export interface NewNote {
  title: string;
  body: string;
  taskId?: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TaskFilter {
  status?: TaskStatus;
  tag?: string;
}
