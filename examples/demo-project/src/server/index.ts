import { readFileSync } from "node:fs";
import type { Task } from "../shared/types";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { NoteStore } from "./store/note-store";
import { TaskStore } from "./store/task-store";

const config = loadConfig();
const tasks = new TaskStore();
const notes = new NoteStore();

if (config.seedFile) {
  const seed = JSON.parse(readFileSync(config.seedFile, "utf8")) as Task[];
  for (const task of seed) tasks.restore(task);
  console.info(`Seeded ${seed.length} tasks from ${config.seedFile}`);
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: createApp({ config, tasks, notes }),
});

console.info(`Orbit listening on http://${server.hostname}:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`Received ${signal}, shutting down`);
    server.stop();
    process.exit(0);
  });
}
