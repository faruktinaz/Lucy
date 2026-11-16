"""Weekly throughput report for an Orbit task export.

Counts how many tasks were completed per ISO week and prints a small text chart,
so trends are visible without a notebook. Completion time is approximated by
``updatedAt`` of tasks whose status is ``done``.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path


@dataclass(frozen=True)
class WeekCount:
    year: int
    week: int
    completed: int

    @property
    def label(self) -> str:
        return f"{self.year}-W{self.week:02d}"


def load_tasks(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict):
        data = data.get("items", [])
    return [task for task in data if isinstance(task, dict)]


def completed_per_week(tasks: list[dict]) -> list[WeekCount]:
    counts: Counter[tuple[int, int]] = Counter()
    for task in tasks:
        if task.get("status") != "done" or not task.get("updatedAt"):
            continue
        finished = datetime.fromisoformat(task["updatedAt"].replace("Z", "+00:00"))
        year, week, _ = finished.isocalendar()
        counts[(year, week)] += 1
    return [WeekCount(year, week, count) for (year, week), count in sorted(counts.items())]


def render(weeks: list[WeekCount], width: int = 40) -> str:
    if not weeks:
        return "No completed tasks in this export."
    peak = max(week.completed for week in weeks)
    lines = []
    for week in weeks:
        bar = "#" * max(1, round(week.completed / peak * width))
        lines.append(f"{week.label}  {bar} {week.completed}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("export", type=Path, help="JSON export of tasks")
    parser.add_argument("--weeks", type=int, default=8, help="number of recent weeks to show")
    args = parser.parse_args()

    weeks = completed_per_week(load_tasks(args.export))[-args.weeks :]
    print(f"Throughput as of {date.today().isoformat()}")
    print(render(weeks))


if __name__ == "__main__":
    main()
