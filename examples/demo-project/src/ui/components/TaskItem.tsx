import type { Task, TaskStatus } from "../../shared/types";

interface TaskItemProps {
  task: Task;
  onStatusChange(id: string, status: TaskStatus): void;
}

const PRIORITY_LABELS: Record<Task["priority"], string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
};

function formatDueDate(dueDate: string): string {
  // Due dates are calendar dates; parse them as local noon so no time zone shifts the day.
  const date = new Date(`${dueDate}T12:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function TaskItem({ task, onStatusChange }: TaskItemProps) {
  const done = task.status === "done";

  return (
    <li className={`task-item task-item--${task.priority}`} data-done={done}>
      <label className="task-item__main">
        <input
          type="checkbox"
          checked={done}
          onChange={(event) => onStatusChange(task.id, event.target.checked ? "done" : "todo")}
        />
        <span className="task-item__title">{task.title}</span>
      </label>
      <div className="task-item__meta">
        <span className="task-item__priority">{PRIORITY_LABELS[task.priority]}</span>
        {task.dueDate && <time dateTime={task.dueDate}>{formatDueDate(task.dueDate)}</time>}
        {task.tags.map((tag) => (
          <span key={tag} className="tag">
            #{tag}
          </span>
        ))}
      </div>
    </li>
  );
}
