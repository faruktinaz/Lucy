import { useMemo, useState } from "react";
import type { Task, TaskStatus } from "../../shared/types";
import { TaskItem } from "./TaskItem";

interface TaskListProps {
  tasks: Task[];
  onStatusChange(id: string, status: TaskStatus): void;
}

type View = "open" | "done" | "all";

const VIEWS: { id: View; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

const PRIORITY_ORDER: Record<Task["priority"], number> = { high: 0, normal: 1, low: 2 };

export function TaskList({ tasks, onStatusChange }: TaskListProps) {
  const [view, setView] = useState<View>("open");

  const visible = useMemo(() => {
    const filtered = tasks.filter((task) => {
      if (view === "open") return task.status !== "done";
      if (view === "done") return task.status === "done";
      return true;
    });
    return filtered.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }, [tasks, view]);

  return (
    <section className="task-list" aria-label="Tasks">
      <header className="task-list__header">
        <h2>Tasks</h2>
        <div role="tablist">
          {VIEWS.map((option) => (
            <button
              key={option.id}
              role="tab"
              aria-selected={view === option.id}
              onClick={() => setView(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>
      <ul>
        {visible.map((task) => (
          <TaskItem key={task.id} task={task} onStatusChange={onStatusChange} />
        ))}
      </ul>
    </section>
  );
}
