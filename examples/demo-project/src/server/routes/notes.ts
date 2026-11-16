import { parseNewNote } from "../../shared/validation";
import type { Route } from "../app";
import { json, notFound, readJson } from "../http";
import type { NoteStore } from "../store/note-store";

export function noteRoutes(notes: NoteStore): Route[] {
  return [
    {
      method: "GET",
      path: "/api/notes",
      handler: (request) => {
        const taskId = new URL(request.url).searchParams.get("taskId") ?? undefined;
        return json({ items: notes.list(taskId), nextCursor: null });
      },
    },
    {
      method: "POST",
      path: "/api/notes",
      limitGroup: "writes",
      handler: async (request) => {
        const note = notes.create(parseNewNote(await readJson(request)));
        return json(note, 201);
      },
    },
    {
      method: "DELETE",
      path: "/api/notes/:id",
      limitGroup: "writes",
      handler: (_request, params) => {
        if (!notes.remove(params.id!)) throw notFound(`Note ${params.id}`);
        return json({ deleted: params.id });
      },
    },
  ];
}
