/**
 * Pure parsers for the machine-readable Git outputs the adapter requests. Formats always use NUL
 * separators where free text (subjects, bodies, paths) can appear; line splitting is only used
 * for outputs whose fields cannot contain newlines (ref names, remote names).
 */
import { redact } from "@/core/log";
import type { GitBranch, GitCommit, GitCommitRef, GitRemote, GitStash } from "./types";

/** `git log -z --decorate=full --format=<LOG_FORMAT>`: fields separated and records terminated by NUL. */
export const LOG_FORMAT = "%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x00%b";
const LOG_FIELDS = 9;

function trimTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, "");
}

/** Parses `%D` produced with `--decorate=full` (full ref names make the kind unambiguous). */
export function parseDecorations(decorations: string): GitCommitRef[] {
  const refs: GitCommitRef[] = [];
  if (!decorations.trim()) return refs;
  for (const raw of decorations.split(", ")) {
    let item = raw.trim();
    if (!item) continue;
    let isHead = false;
    if (item.startsWith("HEAD -> ")) {
      isHead = true;
      item = item.slice("HEAD -> ".length);
    } else if (item === "HEAD") {
      refs.push({ name: "HEAD", kind: "head", isHead: true });
      continue;
    }
    if (item.startsWith("tag: ")) {
      refs.push({
        name: item.slice("tag: ".length).replace(/^refs\/tags\//, ""),
        kind: "tag",
        isHead: false,
      });
    } else if (item.startsWith("refs/heads/")) {
      refs.push({ name: item.slice("refs/heads/".length), kind: "branch", isHead });
    } else if (item.startsWith("refs/remotes/")) {
      refs.push({ name: item.slice("refs/remotes/".length), kind: "remote", isHead });
    } else {
      refs.push({ name: item, kind: "other", isHead });
    }
  }
  return refs;
}

export function parseLog(output: string): GitCommit[] {
  const tokens = output.split("\0");
  const commits: GitCommit[] = [];
  for (let i = 0; i + LOG_FIELDS <= tokens.length; i += LOG_FIELDS) {
    const [oid, shortOid, parents, authorName, authorEmail, authorDate, decorations, subject, body] =
      tokens.slice(i, i + LOG_FIELDS);
    // `-z` terminates each record with NUL; between records Git may leave a newline.
    const cleanOid = (oid ?? "").replace(/^\n+/, "");
    if (!/^[0-9a-f]{40,64}$/.test(cleanOid)) break;
    commits.push({
      oid: cleanOid,
      shortOid: shortOid ?? "",
      parents: (parents ?? "").split(" ").filter(Boolean),
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authorDate: authorDate ?? "",
      refs: parseDecorations(decorations ?? ""),
      subject: subject ?? "",
      body: trimTrailingNewlines(body ?? ""),
    });
  }
  return commits;
}

/** `git for-each-ref --format=<REF_FORMAT> refs/heads refs/remotes`, one ref per line. */
export const REF_FORMAT =
  "%(refname)%00%(objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)%00%(symref)";

export interface TrackInfo {
  ahead?: number;
  behind?: number;
  gone?: boolean;
}

export function parseTrack(track: string): TrackInfo {
  const info: TrackInfo = {};
  if (!track) return info;
  if (track.trim() === "gone") return { gone: true };
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  info.ahead = ahead ? Number(ahead[1]) : 0;
  info.behind = behind ? Number(behind[1]) : 0;
  return info;
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes)\//, "");
}

/** Remote name of a remote-tracking ref, preferring the longest known remote (names may contain `/`). */
function remoteOf(shortName: string, remoteNames: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const name of remoteNames) {
    if (shortName.startsWith(`${name}/`) && (!best || name.length > best.length)) best = name;
  }
  return best ?? shortName.split("/")[0];
}

export function parseRefs(output: string, remoteNames: readonly string[] = []): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [ref = "", oid = "", upstream = "", track = "", head = "", symref = ""] = line.split("\0");
    if (symref) continue; // refs/remotes/origin/HEAD and similar aliases.
    const kind = ref.startsWith("refs/heads/") ? "local" : ref.startsWith("refs/remotes/") ? "remote" : null;
    if (!kind) continue;
    const name = shortRef(ref);
    const branch: GitBranch = { name, ref, kind, oid: oid || null, isCurrent: head === "*" };
    if (kind === "remote") branch.remote = remoteOf(name, remoteNames);
    if (upstream) {
      branch.upstream = shortRef(upstream);
      const info = parseTrack(track);
      if (info.gone) branch.upstreamGone = true;
      if (info.ahead !== undefined) branch.ahead = info.ahead;
      if (info.behind !== undefined) branch.behind = info.behind;
    }
    branches.push(branch);
  }
  return branches;
}

/** `git stash list -z --format=<STASH_FORMAT>`. */
export const STASH_FORMAT = "%H%x00%gs%x00%cI";
const STASH_FIELDS = 3;

export function parseStashList(output: string): GitStash[] {
  const tokens = output.split("\0");
  const stashes: GitStash[] = [];
  for (let i = 0; i + STASH_FIELDS <= tokens.length; i += STASH_FIELDS) {
    const oid = (tokens[i] ?? "").replace(/^\n+/, "");
    if (!/^[0-9a-f]{40,64}$/.test(oid)) break;
    const message = tokens[i + 1] ?? "";
    const date = tokens[i + 2] ?? "";
    const index = stashes.length;
    const branch = /^(?:WIP on|On) (.+?): /.exec(message)?.[1];
    stashes.push({
      index,
      ref: `stash@{${index}}`,
      oid,
      message,
      branch: branch && branch !== "(no branch)" ? branch : null,
      date,
    });
  }
  return stashes;
}

function looksLikeToken(user: string): boolean {
  return user.length >= 20 && /^[A-Za-z0-9_-]+$/.test(user);
}

/** Masks credentials embedded in a remote URL (`https://user:token@host` → `https://user:***@host`). */
export function redactRemoteUrl(url: string): string {
  let out = url;
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^@/]*)@/i.exec(url);
  if (match) {
    const userinfo = match[2] ?? "";
    const colon = userinfo.indexOf(":");
    let safe: string;
    if (colon === -1) safe = looksLikeToken(userinfo) ? "***" : userinfo;
    else safe = `${userinfo.slice(0, colon)}:***`;
    out = `${match[1]}${safe}@${url.slice(match[0].length)}`;
  }
  const redacted = redact(out);
  return typeof redacted === "string" ? redacted : out;
}

/** `git remote -v`: `name<TAB>url (fetch|push)` per line. URLs may contain spaces. */
export function parseRemotes(output: string): GitRemote[] {
  const byName = new Map<string, GitRemote>();
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const name = line.slice(0, tab);
    const match = /^(.*) \((fetch|push)\)$/.exec(line.slice(tab + 1));
    if (!match) continue;
    const url = redactRemoteUrl(match[1] ?? "");
    const remote = byName.get(name) ?? { name, fetchUrl: null, pushUrl: null };
    if (match[2] === "fetch") remote.fetchUrl = url;
    else remote.pushUrl = url;
    byName.set(name, remote);
  }
  return [...byName.values()];
}

export interface NumstatEntry {
  path: string;
  /** `null` for binary files. */
  added: number | null;
  removed: number | null;
}

/** `git diff --numstat -z --no-renames`: `added<TAB>removed<TAB>path<NUL>` (`-` counts for binary). */
export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const record of output.split("\0")) {
    if (!record) continue;
    const first = record.indexOf("\t");
    const second = first === -1 ? -1 : record.indexOf("\t", first + 1);
    if (second === -1) continue;
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    entries.push({
      path: record.slice(second + 1),
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
    });
  }
  return entries;
}
