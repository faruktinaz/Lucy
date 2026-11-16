import { useCallback, useEffect, useState } from "react";
import type { Page, Task, TaskStatus } from "../../shared/types";

export interface UseTasks {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  setStatus(id: string, status: TaskStatus): Promise<void>;
  reload(): Promise<void>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export function useTasks(): UseTasks {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const page = await request<Page<Task>>("/api/tasks");
      setTasks(page.items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const setStatus = useCallback(async (id: string, status: TaskStatus) => {
    // Update the list first so the checkbox responds immediately; roll back on failure.
    const previous = tasks;
    setTasks((current) => current.map((task) => (task.id === id ? { ...task, status } : task)));
    try {
      await request<Task>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
    } catch (cause) {
      setTasks(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [tasks]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { tasks, loading, error, setStatus, reload };
}
