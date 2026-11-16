# API reference

All endpoints accept and return JSON. Timestamps are ISO 8601 strings in UTC.

## Tasks

| Method   | Path              | Description                          |
| -------- | ----------------- | ------------------------------------ |
| `GET`    | `/api/tasks`      | List tasks, newest first             |
| `POST`   | `/api/tasks`      | Create a task                        |
| `GET`    | `/api/tasks/:id`  | Fetch one task                       |
| `PATCH`  | `/api/tasks/:id`  | Update title, status, priority, tags |
| `DELETE` | `/api/tasks/:id`  | Delete a task and detach its notes   |

`GET /api/tasks` accepts `status`, `tag`, `cursor` and `limit` query parameters.

```json
{
  "items": [
    {
      "id": "tsk_0001",
      "title": "Draft the release notes",
      "status": "todo",
      "priority": "high",
      "tags": ["release"],
      "dueDate": "2026-03-20",
      "createdAt": "2026-03-16T08:30:00.000Z",
      "updatedAt": "2026-03-16T08:30:00.000Z"
    }
  ],
  "nextCursor": null
}
```

## Notes

| Method   | Path              | Description                    |
| -------- | ----------------- | ------------------------------ |
| `GET`    | `/api/notes`      | List notes, optionally by task |
| `POST`   | `/api/notes`      | Create a note                  |
| `DELETE` | `/api/notes/:id`  | Delete a note                  |

## Errors

Every error has the same shape, with a stable `code` that clients can match on:

```json
{ "error": { "code": "validation_failed", "message": "title must not be empty" } }
```

Requests rejected by the rate limiter return `429` with a `retry-after` header.
