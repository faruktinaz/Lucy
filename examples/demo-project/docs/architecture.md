# Architecture

Orbit is one Bun process that serves a JSON API and the static web client.
There is no database: tasks and notes live in memory and can be seeded from a
JSON file on start.

## Request flow

1. `src/server/index.ts` loads the configuration and starts `Bun.serve`.
2. `src/server/app.ts` matches the method and path against a small route table.
3. Write requests pass through the rate limiter before reaching a handler.
4. Handlers validate input with `src/shared/validation.ts` and call a store.
5. Errors are thrown as `HttpError` and turned into JSON responses in one place.

## Stores

`TaskStore` and `NoteStore` are plain classes around a `Map`. They return copies
so callers cannot mutate stored records by accident. Listing is ordered by
creation time and paginated with an opaque cursor, which is the base64 encoding
of the last returned id.

## Web client

The client is a handful of React components without a router. State lives in the
`useTasks` hook, which talks to the API and keeps an optimistic copy of the list
so toggling a task feels instant.

## Why no database yet

Orbit started as a personal tool. Keeping everything in memory made the first
versions trivial to run and to test. The store interfaces are small on purpose,
so a SQLite-backed implementation can replace them without touching the routes.
