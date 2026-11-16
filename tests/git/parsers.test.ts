import { describe, expect, test } from "bun:test";
import {
  parseDecorations,
  parseLog,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseStashList,
  parseTrack,
  redactRemoteUrl,
} from "@/adapters/git/parsers";

const Z = "\0";
const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parseLog", () => {
  test("fixed field count per NUL-terminated record; bodies may contain newlines", () => {
    const record = (oid: string, parents: string, refs: string, subject: string, body: string) =>
      [
        oid,
        oid.slice(0, 7),
        parents,
        "Ayşe Yılmaz",
        "ayse@example.invalid",
        "2026-01-01T12:00:00+03:00",
        refs,
        subject,
        body,
      ].join(Z) + Z;
    const out =
      record(
        B,
        A,
        "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1",
        "İkinci",
        "line 1\n\nline 3\n",
      ) + record(A, "", "", "first", "");
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      oid: B,
      shortOid: "bbbbbbb",
      parents: [A],
      authorName: "Ayşe Yılmaz",
      authorEmail: "ayse@example.invalid",
      authorDate: "2026-01-01T12:00:00+03:00",
      refs: [
        { name: "main", kind: "branch", isHead: true },
        { name: "origin/main", kind: "remote", isHead: false },
        { name: "v1", kind: "tag", isHead: false },
      ],
      subject: "İkinci",
      body: "line 1\n\nline 3",
    });
    expect(commits[1]?.parents).toEqual([]);
  });

  test("merge commits list both parents; empty output yields nothing", () => {
    const out = [B, "bbbbbbb", `${A} ${A}`, "n", "e", "d", "", "Merge", ""].join(Z) + Z;
    expect(parseLog(out)[0]?.parents).toEqual([A, A]);
    expect(parseLog("")).toEqual([]);
  });
});

describe("parseDecorations", () => {
  test("detached HEAD and other refs", () => {
    expect(parseDecorations("HEAD, refs/stash, refs/notes/x")).toEqual([
      { name: "HEAD", kind: "head", isHead: true },
      { name: "refs/stash", kind: "other", isHead: false },
      { name: "refs/notes/x", kind: "other", isHead: false },
    ]);
    expect(parseDecorations("")).toEqual([]);
  });
});

describe("parseRefs", () => {
  test("local and remote branches, upstream tracking, symbolic refs skipped", () => {
    const line = (...fields: string[]) => fields.join(Z);
    const out = [
      line("refs/heads/main", A, "refs/remotes/origin/main", "ahead 2, behind 1", "*", ""),
      line("refs/heads/old", B, "refs/remotes/origin/old", "gone", " ", ""),
      line("refs/heads/local-only", B, "", "", " ", ""),
      line("refs/remotes/origin/HEAD", A, "", "", " ", "refs/remotes/origin/main"),
      line("refs/remotes/origin/main", A, "", "", " ", ""),
      line("refs/remotes/my/fork/topic", B, "", "", " ", ""),
    ].join("\n");
    const refs = parseRefs(`${out}\n`, ["origin", "my/fork"]);
    expect(refs).toEqual([
      {
        name: "main",
        ref: "refs/heads/main",
        kind: "local",
        oid: A,
        isCurrent: true,
        upstream: "origin/main",
        ahead: 2,
        behind: 1,
      },
      {
        name: "old",
        ref: "refs/heads/old",
        kind: "local",
        oid: B,
        isCurrent: false,
        upstream: "origin/old",
        upstreamGone: true,
      },
      { name: "local-only", ref: "refs/heads/local-only", kind: "local", oid: B, isCurrent: false },
      {
        name: "origin/main",
        ref: "refs/remotes/origin/main",
        kind: "remote",
        oid: A,
        isCurrent: false,
        remote: "origin",
      },
      {
        name: "my/fork/topic",
        ref: "refs/remotes/my/fork/topic",
        kind: "remote",
        oid: B,
        isCurrent: false,
        remote: "my/fork",
      },
    ]);
  });

  test("parseTrack", () => {
    expect(parseTrack("")).toEqual({});
    expect(parseTrack("ahead 3")).toEqual({ ahead: 3, behind: 0 });
    expect(parseTrack("behind 4")).toEqual({ ahead: 0, behind: 4 });
    expect(parseTrack("gone")).toEqual({ gone: true });
  });
});

describe("parseStashList", () => {
  test("index is the position; branch comes from the reflog subject", () => {
    const out =
      [A, "On feature/x: my message", "2026-01-01T12:00:00Z"].join(Z) +
      Z +
      [B, "WIP on main: 1234567 subject", "2026-01-02T12:00:00Z"].join(Z) +
      Z +
      [A, "WIP on (no branch): 1234567 subject", "2026-01-03T12:00:00Z"].join(Z) +
      Z;
    expect(parseStashList(out)).toEqual([
      {
        index: 0,
        ref: "stash@{0}",
        oid: A,
        message: "On feature/x: my message",
        branch: "feature/x",
        date: "2026-01-01T12:00:00Z",
      },
      {
        index: 1,
        ref: "stash@{1}",
        oid: B,
        message: "WIP on main: 1234567 subject",
        branch: "main",
        date: "2026-01-02T12:00:00Z",
      },
      {
        index: 2,
        ref: "stash@{2}",
        oid: A,
        message: "WIP on (no branch): 1234567 subject",
        branch: null,
        date: "2026-01-03T12:00:00Z",
      },
    ]);
  });
});

describe("parseRemotes and redaction", () => {
  test("fetch/push URLs, paths with spaces", () => {
    const out = [
      "origin\t/Users/me/my repo.git (fetch)",
      "origin\t/Users/me/my repo.git (push)",
      "split\thttps://example.invalid/a.git (fetch)",
      "split\tgit@example.invalid:a.git (push)",
    ].join("\n");
    expect(parseRemotes(out)).toEqual([
      { name: "origin", fetchUrl: "/Users/me/my repo.git", pushUrl: "/Users/me/my repo.git" },
      { name: "split", fetchUrl: "https://example.invalid/a.git", pushUrl: "git@example.invalid:a.git" },
    ]);
  });

  test("credentials are masked", () => {
    expect(redactRemoteUrl("https://user:pa55@host.invalid/x.git")).toBe(
      "https://user:***@host.invalid/x.git",
    );
    expect(redactRemoteUrl("https://ghp_0123456789abcdefghijABCDEFGHIJ@host.invalid/x")).toBe(
      "https://***@host.invalid/x",
    );
    expect(redactRemoteUrl("https://alice@host.invalid/x")).toBe("https://alice@host.invalid/x");
    expect(redactRemoteUrl("git@github.com:owner/repo.git")).toBe("git@github.com:owner/repo.git");
  });
});

describe("parseNumstat", () => {
  test("text and binary entries, names with tabs", () => {
    expect(parseNumstat(`3\t1\ta.txt${Z}-\t-\timg.png${Z}0\t2\ttab\tname${Z}`)).toEqual([
      { path: "a.txt", added: 3, removed: 1 },
      { path: "img.png", added: null, removed: null },
      { path: "tab\tname", added: 0, removed: 2 },
    ]);
  });
});
