import { describe, expect, test } from "bun:test";
import { type CommitBoxInput, computeCommitBox } from "@/features/source-control/model";

const base: CommitBoxInput = {
  message: "feat: add things",
  amend: false,
  canAmend: true,
  repositoryReady: true,
  staged: 2,
  unstaged: 0,
  conflicts: 0,
  operation: null,
  committing: false,
  busy: false,
};

const box = (overrides: Partial<CommitBoxInput>) => computeCommitBox({ ...base, ...overrides });

describe("computeCommitBox", () => {
  test("staged changes and a message: Commit is enabled", () => {
    expect(box({}).button).toEqual({ label: "Commit", enabled: true, action: "commit", reason: null });
  });

  test("an empty or whitespace-only message disables committing", () => {
    for (const message of ["", "   ", "\n\n"]) {
      expect(box({ message }).button).toMatchObject({ enabled: false, reason: "Enter a commit message." });
    }
  });

  test("a subject over 72 characters is a hint, not an error", () => {
    const long = box({ message: `${"x".repeat(73)}\n\nbody` });
    expect(long.subjectLength).toBe(73);
    expect(long.hint).toContain("73 characters");
    expect(long.button.enabled).toBe(true);
    expect(box({ message: "x".repeat(72) }).hint).toBeNull();
    // Characters, not UTF-16 units: 72 emoji are 72 characters.
    expect(box({ message: "🚀".repeat(72) }).hint).toBeNull();
  });

  test("amend", () => {
    expect(box({ amend: true }).button).toMatchObject({
      label: "Commit (amend)",
      enabled: true,
      action: "commit",
    });
    expect(box({ amend: true, staged: 0 }).button).toMatchObject({ label: "Commit (amend)", enabled: true });
    expect(box({ amend: true, canAmend: false }).button).toMatchObject({
      enabled: false,
      reason: "There is no commit to amend yet.",
    });
    expect(box({ amend: true, message: "" }).button.enabled).toBe(false);
  });

  test("nothing staged: Commit asks to stage everything first (VS Code-like)", () => {
    const result = box({ staged: 0, unstaged: 3 });
    expect(result.button).toEqual({
      label: "Commit",
      enabled: true,
      action: "stage-all-and-commit",
      reason: null,
    });
    expect(result.hint).toContain("Nothing is staged");
    expect(box({ staged: 0, unstaged: 3, message: "" }).button.enabled).toBe(false);
  });

  test("no changes at all", () => {
    expect(box({ staged: 0, unstaged: 0 }).button).toMatchObject({
      label: "Nothing to commit",
      enabled: false,
      action: "none",
    });
  });

  test("a merge can be concluded with nothing staged", () => {
    expect(box({ staged: 0, unstaged: 0, operation: "merge" }).button).toMatchObject({
      enabled: true,
      action: "commit",
    });
  });

  test("conflicts, busy, committing and no repository disable the button", () => {
    expect(box({ conflicts: 1 }).button).toMatchObject({
      enabled: false,
      reason: "Resolve all merge conflicts before committing.",
    });
    expect(box({ busy: true })).toMatchObject({ busy: true, button: { enabled: false } });
    expect(box({ committing: true })).toMatchObject({
      busy: true,
      button: { label: "Committing…", enabled: false },
    });
    expect(box({ repositoryReady: false }).button).toMatchObject({
      enabled: false,
      reason: "There is no Git repository.",
    });
  });
});
