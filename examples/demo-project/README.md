# Orbit

Orbit is a small, self-hosted service for tasks and the notes that go with them.
It runs as a single Bun process, keeps its data in memory, and ships with a
command-line client for scripting.

> Orbit is deliberately small. If a feature needs a database migration or a
> background worker, it probably belongs in a different tool.

## Features

- Tasks with status, priority, tags and an optional due date
- Notes that can stand alone or be attached to a task
- A JSON API with cursor-based pagination
- Rate limiting for write endpoints, configured in `config/limits.toml`
- `orbitctl`, a Go CLI for listing and completing tasks from a terminal
- A Python script that reports weekly throughput from an export

## Quick start

Install the dependencies and start the development server:

```bash
bun install
cp .env.example .env
bun run dev
```

The API listens on `http://127.0.0.1:4180` by default. Create a task:

```bash
curl -s -X POST http://127.0.0.1:4180/api/tasks \
  -H 'content-type: application/json' \
  -d '{"title": "Draft the release notes", "priority": "high"}'
```

## Using the API from TypeScript

```ts
import type { Task } from "./src/shared/types";

export async function openTasks(baseUrl: string): Promise<Task[]> {
  const response = await fetch(`${baseUrl}/api/tasks?status=todo`);
  if (!response.ok) throw new Error(`Orbit returned ${response.status}`);
  const page = (await response.json()) as { items: Task[] };
  return page.items;
}
```

## Command-line client

`orbitctl` lives in `tools/` and talks to the same API:

```go
client := orbit.NewClient("http://127.0.0.1:4180", os.Getenv("ORBIT_API_TOKEN"))
tasks, err := client.ListTasks(ctx, orbit.Filter{Status: "todo"})
```

Build it with `go build -o tools/bin/orbitctl ./tools`.

## Analysis

Export tasks to JSON and summarise how many were completed per week:

```python
python3 analysis/task_throughput.py data/sample-tasks.json --weeks 6
```

## Configuration

| File                 | Purpose                                  | Reloaded on change |
| -------------------- | ---------------------------------------- | ------------------ |
| `.env`               | Port, host, log level and API token      | No                 |
| `config/app.yaml`    | Server defaults and feature switches     | No                 |
| `config/limits.toml` | Rate limits per route group              | Yes                |

A minimal `config/app.yaml` looks like this:

```yaml
server:
  port: 4180
logging:
  level: info
```

## Project layout

1. `src/server/` holds the HTTP API, stores and middleware.
2. `src/ui/` holds the React components for the web client.
3. `src/shared/` holds types and validation used by both.
4. `tools/`, `analysis/` and `scripts/` hold the supporting tooling.

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together
and [docs/api.md](docs/api.md) for the full endpoint reference.

## Contributing

Run `bun test` and `bun run typecheck` before opening a pull request. Keep
changes focused; small pull requests are reviewed faster.

## License

Orbit is released under the [MIT License](LICENSE).
