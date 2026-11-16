import { describe, expect, test } from "bun:test";
import {
  buildPrompt,
  formatFileMention,
  isPromptTemplateApplicable,
  PROMPT_TEMPLATES,
} from "@/adapters/agents";
import { isLucyError } from "@/core/errors";

describe("prompt templates", () => {
  test("the four templates exist", () => {
    expect(PROMPT_TEMPLATES.map((template) => template.id)).toEqual([
      "explain",
      "review-diff",
      "write-tests",
      "fix-diagnostics",
    ]);
  });

  test("@mentions: plain, quoted for spaces, with line ranges", () => {
    expect(formatFileMention("src/app.ts")).toBe("@src/app.ts");
    expect(formatFileMention("docs/my notes.md")).toBe('@"docs/my notes.md"');
    expect(formatFileMention("src/app.ts", { startLine: 3, endLine: 9 })).toBe("@src/app.ts#L3-9");
    expect(formatFileMention("src/app.ts", { startLine: 4, endLine: 4 })).toBe("@src/app.ts#L4");
    expect(formatFileMention("a\u001b[31m.ts")).toBe("@a�[31m.ts");
  });

  test("explain: whole file, or a selection with a fenced snippet", () => {
    expect(buildPrompt("explain", { filePath: "src/app.ts" })).toBe(
      "Explain what @src/app.ts does: its purpose, its main parts and how they fit together.",
    );
    const prompt = buildPrompt("explain", {
      filePath: "src/app.ts",
      language: "ts",
      selection: { startLine: 10, endLine: 12, text: "const a = `x`;\r\nconst b = ```y```;\n" },
    });
    expect(prompt).toBe(
      "Explain what the code in @src/app.ts#L10-12 (lines 10-12) does, step by step. Point out anything surprising or risky.\n\n" +
        "````ts\nconst a = `x`;\nconst b = ```y```;\n````",
    );
  });

  test("review diff: uncommitted or staged, optionally for one file", () => {
    expect(buildPrompt("review-diff", {})).toStartWith(
      "Review my uncommitted changes (run `git diff` to see them).",
    );
    expect(buildPrompt("review-diff", { filePath: "my dir/a.ts", staged: true })).toStartWith(
      "Review my staged changes to @\"my dir/a.ts\" (run `git diff --staged -- 'my dir/a.ts'` to see them).",
    );
  });

  test("write tests", () => {
    expect(
      buildPrompt("write-tests", { filePath: "src/x.ts", selection: { startLine: 5, endLine: 20 } }),
    ).toStartWith("Write tests for @src/x.ts#L5-20 (focus on lines 5-20).");
  });

  test("fix diagnostics lists each one on its own line and caps the list", () => {
    const prompt = buildPrompt("fix-diagnostics", {
      filePath: "src/x.ts",
      diagnostics: [
        {
          message: "Type 'string' is not assignable\n  to type 'number'.",
          line: 12,
          column: 5,
          severity: "error",
          source: "ts",
          code: 2322,
        },
        { message: "Unused variable", line: 3, severity: "warning" },
      ],
    });
    expect(prompt).toBe(
      "Fix these diagnostics in @src/x.ts:\n" +
        "- L12:5 error [ts 2322]: Type 'string' is not assignable to type 'number'.\n" +
        "- L3 warning: Unused variable\n\nKeep the changes minimal and explain each fix.",
    );
    const many = buildPrompt("fix-diagnostics", {
      filePath: "a.ts",
      diagnostics: Array.from({ length: 60 }, (_, i) => ({ message: `m${i}` })),
    });
    expect(many).toContain("- … and 10 more");
  });

  test("prompts never end with a newline (they are pasted, never submitted)", () => {
    const context = {
      filePath: "a.ts",
      selection: { startLine: 1, endLine: 2, text: "x\n\n" },
      diagnostics: [{ message: "m" }],
    };
    for (const template of PROMPT_TEMPLATES) {
      const text = buildPrompt(template.id, context);
      expect(text.endsWith("\n")).toBe(false);
      expect(text.endsWith("\r")).toBe(false);
    }
  });

  test("missing context is an INVALID_ARGUMENT LucyError; applicability mirrors it", () => {
    let caught: unknown;
    try {
      buildPrompt("fix-diagnostics", { filePath: "a.ts", diagnostics: [] });
    } catch (error) {
      caught = error;
    }
    expect(isLucyError(caught, "INVALID_ARGUMENT")).toBe(true);
    expect(isPromptTemplateApplicable("explain", {})).toBe(false);
    expect(isPromptTemplateApplicable("review-diff", {})).toBe(true);
    expect(
      isPromptTemplateApplicable("fix-diagnostics", { filePath: "a.ts", diagnostics: [{ message: "m" }] }),
    ).toBe(true);
  });
});
