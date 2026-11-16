import { TASK_STATUSES, type TaskFilter, type TaskStatus } from "../../shared/types";
import { parseNewTask, parseTaskPatch } from "../../shared/validation";
import type { Route } from "../app";
import { HttpError, json, notFound, readJson } from "../http";
import type { NoteStore } from "../store/note-store";
import type { TaskStore } from "../store/task-store";

const DEFAULT_PAGE_SIZE = 50;

function parseFilter(url: URL): TaskFilter {
  const filter: TaskFilter = {};
  const status = url.searchParams.get("status");
  if (status !== null) filter.status = normalizeStatus(status);
  const tag = url.searchParams.get("tag");
  if (tag) filter.tag = tag.toLowerCase();
  return filter;
}

export function taskRoutes(tasks: TaskStore, notes: NoteStore): Route[] {
  return [
    {
      method: "GET",
      path: "/api/tasks",
      handler: (request) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        return json(tasks.list(parseFilter(url), cursor, DEFAULT_PAGE_SIZE));
      },
    },
    {
      method: "POST",
      path: "/api/tasks",
      limitGroup: "writes",
      handler: async (request) => {
        const task = tasks.create(parseNewTask(await readJson(request)));
        return json(task, 201, { location: `/api/tasks/${task.id}` });
      },
    },
    {
      method: "GET",
      path: "/api/tasks/:id",
      handler: (_request, params) => {
        const task = tasks.get(params.id!);
        if (!task) throw notFound(`Task ${params.id}`);
        return json(task);
      },
    },
    {
      method: "PATCH",
      path: "/api/tasks/:id",
      limitGroup: "writes",
      handler: async (request, params) => {
        const patch = parseTaskPatch(await readJson(request));
        const task = tasks.update(params.id!, patch);
        if (!task) throw notFound(`Task ${params.id}`);
        return json(task);
      },
    },
    {
      method: "DELETE",
      path: "/api/tasks/:id",
      limitGroup: "writes",
      handler: (_request, params) => {
        if (!tasks.remove(params.id!)) throw notFound(`Task ${params.id}`);
        const detachedNotes = notes.detachFromTask(params.id!);
        return json({ deleted: params.id, detachedNotes });
      },
    },
  ];
}

/**
 * Clients older than 0.2 sent `open` and `closed`. Keep accepting them until
 * orbitctl and the browser extension have both shipped the new names.
 */
const LEGACY_STATUS_ALIASES: Record<string, TaskStatus> = {
  open: "todo",
  closed: "done",
};

function normalizeStatus(value: string): TaskStatus {
  const status = LEGACY_STATUS_ALIASES[value] ?? value;
  if (!TASK_STATUSES.includes(status as TaskStatus)) {
    throw new HttpError(400, "invalid_filter", `Unknown status "${value}"`);
  }
  return status as TaskStatus;
}
