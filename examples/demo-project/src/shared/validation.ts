import { PRIORITIES, TASK_STATUSES, type NewNote, type NewTask, type TaskPatch } from "./types";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const MAX_TITLE_LENGTH = 200;
const MAX_TAGS = 8;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTitle(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("title must be a string");
  const title = value.trim();
  if (title.length === 0) throw new ValidationError("title must not be empty");
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  return title;
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ValidationError("tags must be an array");
  if (value.length > MAX_TAGS) throw new ValidationError(`at most ${MAX_TAGS} tags are allowed`);
  const tags = value.map((tag) => {
    if (typeof tag !== "string" || tag.trim() === "") {
      throw new ValidationError("tags must be non-empty strings");
    }
    return tag.trim().toLowerCase();
  });
  return [...new Set(tags)];
}

function parseDueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new ValidationError("dueDate must be a YYYY-MM-DD string or null");
  }
  return value;
}

export function parseNewTask(input: unknown): NewTask {
  if (!isRecord(input)) throw new ValidationError("expected a JSON object");
  const task: NewTask = { title: parseTitle(input.title) };
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority as never)) {
      throw new ValidationError(`priority must be one of ${PRIORITIES.join(", ")}`);
    }
    task.priority = input.priority as NewTask["priority"];
  }
  if (input.tags !== undefined) task.tags = parseTags(input.tags);
  if (input.dueDate !== undefined) task.dueDate = parseDueDate(input.dueDate);
  return task;
}

export function parseTaskPatch(input: unknown): TaskPatch {
  if (!isRecord(input)) throw new ValidationError("expected a JSON object");
  const patch: TaskPatch = {};
  if (input.title !== undefined) patch.title = parseTitle(input.title);
  if (input.status !== undefined) {
    if (!TASK_STATUSES.includes(input.status as never)) {
      throw new ValidationError(`status must be one of ${TASK_STATUSES.join(", ")}`);
    }
    patch.status = input.status as TaskPatch["status"];
  }
  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority as never)) {
      throw new ValidationError(`priority must be one of ${PRIORITIES.join(", ")}`);
    }
    patch.priority = input.priority as TaskPatch["priority"];
  }
  if (input.tags !== undefined) patch.tags = parseTags(input.tags);
  if (input.dueDate !== undefined) patch.dueDate = parseDueDate(input.dueDate);
  return patch;
}

export function parseNewNote(input: unknown): NewNote {
  if (!isRecord(input)) throw new ValidationError("expected a JSON object");
  if (typeof input.body !== "string") throw new ValidationError("body must be a string");
  const taskId = input.taskId;
  if (taskId !== undefined && taskId !== null && typeof taskId !== "string") {
    throw new ValidationError("taskId must be a string or null");
  }
  return { title: parseTitle(input.title), body: input.body, taskId: taskId ?? null };
}
