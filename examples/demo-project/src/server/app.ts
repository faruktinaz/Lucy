import type { ServerConfig } from "./config";
import { HttpError, json, toErrorResponse } from "./http";
import { createRateLimiter } from "./middleware/rate-limit";
import { noteRoutes } from "./routes/notes";
import { taskRoutes } from "./routes/tasks";
import type { NoteStore } from "./store/note-store";
import type { TaskStore } from "./store/task-store";

export interface AppContext {
  config: ServerConfig;
  tasks: TaskStore;
  notes: NoteStore;
}

export type Handler = (request: Request, params: Record<string, string>) => Response | Promise<Response>;

export interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path pattern such as `/api/tasks/:id`. */
  path: string;
  /** Name of the rate-limit group in config/limits.toml, if any. */
  limitGroup?: string;
  handler: Handler;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split("/");
  const actual = pathname.replace(/\/+$/, "").split("/");
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const part = expected[i]!;
    const value = actual[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(value);
    else if (part !== value) return null;
  }
  return params;
}

export function createApp(context: AppContext): (request: Request) => Promise<Response> {
  const routes: Route[] = [
    { method: "GET", path: "/api/health", handler: () => json({ status: "ok" }) },
    ...taskRoutes(context.tasks, context.notes),
    ...noteRoutes(context.notes),
  ];
  const limiter = createRateLimiter(context.config.limits);

  return async (request) => {
    const url = new URL(request.url);
    try {
      for (const route of routes) {
        const params = matchPath(route.path, url.pathname);
        if (!params) continue;
        if (route.method !== request.method) continue;
        if (route.limitGroup) limiter.check(route.limitGroup, request);
        return await route.handler(request, params);
      }
      throw new HttpError(404, "not_found", `No route for ${request.method} ${url.pathname}`);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}
