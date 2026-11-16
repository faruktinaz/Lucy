# Local setup

## Requirements

- Bun 1.2 or newer
- Go 1.22 or newer, for `orbitctl`
- Python 3.11 or newer, for the analysis script

## First run

```bash
bun install
cp .env.example .env
bun run dev
```

Open `http://127.0.0.1:4180` in a browser. The server restarts when a file in
`src/` changes.

## Seeding data

Set `ORBIT_SEED_FILE` in `.env` to load tasks on start. The repository ships with
`data/sample-tasks.json`, which contains a dozen realistic tasks.

## Running the checks

```bash
bun test
bun run typecheck
```

## Troubleshooting

- **Port already in use:** change `ORBIT_PORT` in `.env`.
- **429 responses while scripting:** raise the limits in `config/limits.toml`;
  the file is reloaded without a restart.
