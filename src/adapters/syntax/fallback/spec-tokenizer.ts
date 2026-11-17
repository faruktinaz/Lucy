/**
 * A small configurable tokenizer for languages without a Tree-sitter grammar in Lucy.
 *
 * One left-to-right pass, no backtracking, no parse tree: comments, strings (with their escape
 * and interpolation rules), numbers, identifiers classified by keyword lists and by simple
 * context (after `.`, before `(`, after `class`/`def`), operators and punctuation. Per-language
 * `extras` (sticky regexes) cover the rest: preprocessor lines, annotations, sigils, symbols.
 * It emits the same nvim-treesitter group names as the grammars, so styling and `tokenizeLines`
 * treat it exactly like Tree-sitter output.
 */
import type { HighlightRange } from "../types";

export type StringEscape = "backslash" | "backtick" | "doubled" | "none";

export interface StringRule {
  readonly open: string;
  /** Defaults to `open`. */
  readonly close?: string;
  /**
   * `backslash` (default): `\x` escapes. `backtick`: PowerShell's `` `n ``. `doubled`: the closer written
   * twice (SQL `''`). `none`: raw.
   */
  readonly escape?: StringEscape;
  readonly multiline?: boolean;
  /** Default `string`. */
  readonly group?: string;
  /** Expression interpolation openers, closed by the matching bracket: `${`, `#{`, `{`, `\(`. */
  readonly interpolation?: readonly string[];
  /** `$name` interpolation (Kotlin, Dart, PHP, Perl, Groovy, Scala). */
  readonly simpleInterpolation?: boolean;
  /** Group for interpolated expressions and `$name` references. Default `variable`. */
  readonly referenceGroup?: string;
  /** Not when the opener directly follows a letter or digit (apostrophes, `Foo'`, `x'`). */
  readonly notAfterWord?: boolean;
}

export interface ExtraRule {
  /** Sticky (`y`) regex tried at the current position. Add the `d` flag when using `captures`. */
  readonly pattern: RegExp;
  /** Group for the whole match; omitted with `captures`, or to consume silently. */
  readonly group?: string;
  /** Group per capture (index 0 is capture 1); only these ranges are emitted. */
  readonly captures?: readonly (string | null)[];
  /** Only as the first token of a line (after indentation). */
  readonly lineStart?: boolean;
  /** Characters the match can start with; rules without it are tried at every position. */
  readonly first?: string;
}

export interface LanguageSpec {
  /** Highlighter filetype, e.g. `sql`. */
  readonly filetype: string;
  /** Other names, including Markdown fence info strings. */
  readonly aliases?: readonly string[];
  /** Keywords, types, constants and builtins match regardless of case (SQL, PHP, PowerShell). */
  readonly caseInsensitive?: boolean;
  readonly lineComments?: readonly string[];
  readonly blockComments?: readonly (readonly [string, string])[];
  readonly nestedComments?: boolean;
  readonly strings?: readonly StringRule[];
  readonly keywords?: readonly string[];
  /** Built-in type names (`int`, `varchar`). */
  readonly types?: readonly string[];
  /** Literal constants (`true`, `null`, `nil`). */
  readonly constants?: readonly string[];
  /** Built-in functions; colored when called. */
  readonly builtins?: readonly string[];
  /** Builtins are colored without parentheses too (Ruby `puts "x"`). */
  readonly bareBuiltins?: boolean;
  /** The next identifier is a function definition (`def`, `fun`, `func`, `sub`). */
  readonly functionKeywords?: readonly string[];
  /** The next identifier is a type definition (`class`, `struct`, `message`). */
  readonly typeKeywords?: readonly string[];
  /** Sticky identifier regex. Default: Unicode letters, digits and `_`. */
  readonly identifier?: RegExp;
  /** Sticky number regex, or `null` for none. Default: decimal, hex, binary, octal, suffixes. */
  readonly number?: RegExp | null;
  /** Characters that form operators. Default `+-*\/%=<>!&|^~?:`. */
  readonly operators?: string;
  /** `Capitalized` identifiers are types (Java, C#, Swift, Haskell). */
  readonly capitalizedTypes?: boolean;
  /** `ALL_CAPS` identifiers are constants (C macros, Java constants). */
  readonly upperCaseConstants?: boolean;
  /** `name(` is a call. Default true. */
  readonly functionCalls?: boolean;
  /** `.name` and `->name` are members. Default true. */
  readonly memberAccess?: boolean;
  /** Group for an identifier directly followed by `:` (not `::`): Ruby and Elixir keys, GraphQL arguments. */
  readonly keyColon?: string;
  /** Group for an identifier followed by `=` (not `==`, `=>`): HCL attributes, Dockerfile `ENV KEY=`. */
  readonly keyEquals?: string;
  /** Identifiers matching this are command calls even without parentheses (PowerShell `Get-Item`). */
  readonly commandPattern?: RegExp;
  readonly extras?: readonly ExtraRule[];
}

export interface LanguageKeywords {
  readonly keywords: readonly string[];
  readonly types: readonly string[];
  readonly constants: readonly string[];
  readonly builtins: readonly string[];
  readonly caseInsensitive: boolean;
}

const DEFAULT_IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/uy;
const DEFAULT_NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[a-zA-Z]*/y;
const DEFAULT_OPERATORS = "+-*/%=<>!&|^~?:";
const ESCAPE = /\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|x[\da-fA-F]{2}|[0-7]{1,3}|[\s\S])/y;

const C_NEWLINE = 10;
const C_SPACE = 32;
const C_TAB = 9;
const C_CR = 13;

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Letters, digits, `_` and any non-ASCII code unit (Unicode letters, `ş`, `ğ`). */
function isWordCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || isDigit(code) || code === 95 || code > 127
  );
}

const BRACKETS = "()[]{}";
const DELIMITERS = ",;.";

interface CompiledSpec {
  readonly spec: LanguageSpec;
  readonly words: ReadonlyMap<string, string>;
  readonly builtins: ReadonlySet<string>;
  readonly functionKeywords: ReadonlySet<string>;
  readonly typeKeywords: ReadonlySet<string>;
  readonly lineComments: readonly string[];
  readonly blockComments: readonly (readonly [string, string])[];
  readonly strings: readonly StringRule[];
  readonly commentFirst: ReadonlySet<number>;
  readonly stringFirst: ReadonlySet<number>;
  readonly extrasByFirst: ReadonlyMap<number, readonly ExtraRule[]>;
  readonly extrasAnywhere: readonly ExtraRule[];
  readonly operators: ReadonlySet<number>;
  readonly identifier: RegExp;
  readonly number: RegExp | null;
}

function codes(text: string): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < text.length; i++) out.add(text.charCodeAt(i));
  return out;
}

function compile(spec: LanguageSpec): CompiledSpec {
  const norm = (word: string): string => (spec.caseInsensitive ? word.toLowerCase() : word);
  const words = new Map<string, string>();
  for (const word of spec.keywords ?? []) words.set(norm(word), "keyword");
  for (const word of spec.types ?? []) words.set(norm(word), "type.builtin");
  for (const word of spec.constants ?? []) words.set(norm(word), "constant.builtin");
  const strings = [...(spec.strings ?? [])].sort((a, b) => b.open.length - a.open.length);
  const blockComments = [...(spec.blockComments ?? [])].sort((a, b) => b[0].length - a[0].length);
  const lineComments = [...(spec.lineComments ?? [])].sort((a, b) => b.length - a.length);
  const extrasByFirst = new Map<number, ExtraRule[]>();
  const extrasAnywhere: ExtraRule[] = [];
  for (const rule of spec.extras ?? []) {
    if (!rule.pattern.sticky) throw new Error(`extra rule ${rule.pattern} must be sticky`);
    if (rule.first === undefined) {
      extrasAnywhere.push(rule);
      continue;
    }
    for (const code of codes(rule.first)) {
      const list = extrasByFirst.get(code) ?? [];
      list.push(rule);
      extrasByFirst.set(code, list);
    }
  }
  return {
    spec,
    words,
    builtins: new Set((spec.builtins ?? []).map(norm)),
    functionKeywords: new Set((spec.functionKeywords ?? []).map(norm)),
    typeKeywords: new Set((spec.typeKeywords ?? []).map(norm)),
    lineComments,
    blockComments,
    strings,
    commentFirst: codes([...lineComments, ...blockComments.map(([open]) => open)].map((s) => s[0]).join("")),
    stringFirst: codes(strings.map((rule) => rule.open[0]).join("")),
    extrasByFirst,
    extrasAnywhere,
    operators: codes(spec.operators ?? DEFAULT_OPERATORS),
    identifier: spec.identifier ?? DEFAULT_IDENTIFIER,
    number: spec.number === undefined ? DEFAULT_NUMBER : spec.number,
  };
}

/** Index of the matching closer for an interpolation that opened just before `from`. */
function matchingClose(text: string, from: number, closer: string, limit: number): number {
  const opener = closer === ")" ? "(" : closer === "]" ? "[" : "{";
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const char = text[i];
    if (char === "\n" && i - from > 2000) return -1;
    if (char === opener) depth++;
    else if (char === closer) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

class Run {
  readonly out: HighlightRange[] = [];
  private pending: "function" | "type" | null = null;

  constructor(
    private readonly c: CompiledSpec,
    private readonly text: string,
  ) {}

  tokenize(from: number, to: number): void {
    const { text, c, out } = this;
    let i = from;
    let lineStart = true;
    while (i < to) {
      const code = text.charCodeAt(i);
      if (code === C_NEWLINE) {
        lineStart = true;
        i++;
        continue;
      }
      if (code === C_SPACE || code === C_TAB || code === C_CR) {
        i++;
        continue;
      }

      const extra = this.extra(i, to, code, lineStart);
      if (extra > i) {
        i = extra;
        lineStart = false;
        this.pending = null;
        continue;
      }

      if (c.commentFirst.has(code)) {
        const end = this.comment(i, to);
        if (end > i) {
          i = end;
          continue;
        }
      }

      if (c.stringFirst.has(code)) {
        const end = this.string(i, to);
        if (end > i) {
          i = end;
          lineStart = false;
          this.pending = null;
          continue;
        }
      }

      lineStart = false;
      if (isDigit(code) || (code === 46 && isDigit(text.charCodeAt(i + 1)))) {
        const number = c.number;
        if (number) {
          number.lastIndex = i;
          const match = number.exec(text);
          if (match && match[0].length > 0) {
            const end = Math.min(i + match[0].length, to);
            out.push({ start: i, end, group: "number" });
            i = end;
            this.pending = null;
            continue;
          }
        }
      }

      if (isWordCode(code) && !isDigit(code)) {
        c.identifier.lastIndex = i;
        const match = c.identifier.exec(text);
        if (match && match[0].length > 0) {
          const end = Math.min(i + match[0].length, to);
          this.word(text.slice(i, end), i, end, to);
          i = end;
          continue;
        }
      }

      this.pending = null;
      const char = text[i] ?? "";
      if (c.operators.has(code)) {
        let end = i + 1;
        while (end < to && c.operators.has(text.charCodeAt(end))) end++;
        out.push({ start: i, end, group: "operator" });
        i = end;
      } else if (BRACKETS.includes(char)) {
        out.push({ start: i, end: i + 1, group: "punctuation.bracket" });
        i++;
      } else if (DELIMITERS.includes(char)) {
        if (char === "." && text[i + 1] === ".") {
          let end = i + 1;
          while (end < to && text[end] === ".") end++;
          out.push({ start: i, end, group: "operator" });
          i = end;
        } else {
          out.push({ start: i, end: i + 1, group: "punctuation.delimiter" });
          i++;
        }
      } else {
        i++;
      }
    }
  }

  private extra(i: number, to: number, code: number, lineStart: boolean): number {
    const { c } = this;
    const indexed = c.extrasByFirst.get(code);
    if (indexed) {
      const end = this.tryRules(indexed, i, to, lineStart);
      if (end > i) return end;
    }
    return c.extrasAnywhere.length > 0 ? this.tryRules(c.extrasAnywhere, i, to, lineStart) : i;
  }

  private tryRules(rules: readonly ExtraRule[], i: number, to: number, lineStart: boolean): number {
    const { text, out } = this;
    for (const rule of rules) {
      if (rule.lineStart && !lineStart) continue;
      rule.pattern.lastIndex = i;
      const match = rule.pattern.exec(text);
      if (!match || match[0].length === 0) continue;
      const end = Math.min(i + match[0].length, to);
      if (rule.captures) {
        const indices = match.indices;
        rule.captures.forEach((group, k) => {
          const span = indices?.[k + 1];
          if (group && span && span[0] < span[1])
            out.push({ start: span[0], end: Math.min(span[1], to), group });
        });
      } else if (rule.group) {
        out.push({ start: i, end, group: rule.group });
      }
      return end;
    }
    return i;
  }

  private comment(i: number, to: number): number {
    const { c, text, out } = this;
    for (const [open, close] of c.blockComments) {
      if (!text.startsWith(open, i)) continue;
      let depth = 1;
      let j = i + open.length;
      while (j < to && depth > 0) {
        if (text.startsWith(close, j)) {
          depth--;
          j += close.length;
        } else if (c.spec.nestedComments && text.startsWith(open, j)) {
          depth++;
          j += open.length;
        } else {
          j++;
        }
      }
      const end = Math.min(j, to);
      out.push({ start: i, end, group: "comment" });
      return end;
    }
    for (const open of c.lineComments) {
      if (!text.startsWith(open, i)) continue;
      const newline = text.indexOf("\n", i);
      const end = newline === -1 || newline > to ? to : newline;
      out.push({ start: i, end, group: "comment" });
      return end;
    }
    return i;
  }

  private string(i: number, to: number): number {
    const { c, text } = this;
    for (const rule of c.strings) {
      if (!text.startsWith(rule.open, i)) continue;
      if (rule.notAfterWord && i > 0 && isWordCode(text.charCodeAt(i - 1))) continue;
      return this.scanString(rule, i, to);
    }
    return i;
  }

  private scanString(rule: StringRule, i: number, to: number): number {
    const { text, out } = this;
    const close = rule.close ?? rule.open;
    const escapeKind = rule.escape ?? "backslash";
    const inner: HighlightRange[] = [];
    let j = i + rule.open.length;
    while (j < to) {
      const code = text.charCodeAt(j);
      if (code === C_NEWLINE && !rule.multiline) break;
      // Interpolation openers first: Swift's `\(` would otherwise read as an escape.
      const opener = rule.interpolation?.find((candidate) => text.startsWith(candidate, j));
      if (opener) {
        const closer = opener.endsWith("(") ? ")" : opener.endsWith("[") ? "]" : "}";
        const end = matchingClose(text, j + opener.length, closer, to);
        if (end !== -1) {
          inner.push({ start: j, end: j + opener.length, group: "punctuation.special" });
          if (end > j + opener.length) {
            inner.push({ start: j + opener.length, end, group: rule.referenceGroup ?? "variable" });
            const nested = new Run(this.c, text);
            nested.tokenize(j + opener.length, end);
            for (const range of nested.out) inner.push(range);
          }
          inner.push({ start: end, end: end + 1, group: "punctuation.special" });
          j = end + 1;
          continue;
        }
      }
      if ((escapeKind === "backslash" && code === 92) || (escapeKind === "backtick" && code === 96)) {
        ESCAPE.lastIndex = j;
        const match = code === 92 ? ESCAPE.exec(text) : null;
        const end = Math.min(j + (match?.[0].length ?? 2), to);
        inner.push({ start: j, end, group: "string.escape" });
        j = end;
        continue;
      }
      if (text.startsWith(close, j)) {
        if (escapeKind === "doubled" && text.startsWith(close, j + close.length)) {
          inner.push({ start: j, end: j + 2 * close.length, group: "string.escape" });
          j += 2 * close.length;
          continue;
        }
        j += close.length;
        break;
      }
      if (rule.simpleInterpolation && code === 36 && isWordCode(text.charCodeAt(j + 1))) {
        let end = j + 1;
        while (end < to && isWordCode(text.charCodeAt(end))) end++;
        inner.push({ start: j, end, group: rule.referenceGroup ?? "variable" });
        j = end;
        continue;
      }
      j++;
    }
    const end = Math.min(j, to);
    out.push({ start: i, end, group: rule.group ?? "string" });
    for (const range of inner) out.push(range);
    return end;
  }

  private word(word: string, start: number, end: number, to: number): void {
    const { c, text, out } = this;
    const key = c.spec.caseInsensitive ? word.toLowerCase() : word;
    const pending = this.pending;
    this.pending = null;
    const known = c.words.get(key);
    if (known) {
      out.push({ start, end, group: known });
      if (known === "keyword") {
        if (c.functionKeywords.has(key)) this.pending = "function";
        else if (c.typeKeywords.has(key)) this.pending = "type";
      }
      return;
    }
    if (pending) {
      out.push({ start, end, group: pending });
      return;
    }
    if (c.spec.keyColon && text.charCodeAt(end) === 58 && text.charCodeAt(end + 1) !== 58) {
      out.push({ start, end, group: c.spec.keyColon });
      return;
    }
    let next = end;
    while (next < to && (text.charCodeAt(next) === C_SPACE || text.charCodeAt(next) === C_TAB)) next++;
    if (c.spec.keyEquals && text.charCodeAt(next) === 61) {
      const after = text.charCodeAt(next + 1);
      if (after !== 61 && after !== 62 && after !== 126) {
        out.push({ start, end, group: c.spec.keyEquals });
        return;
      }
    }
    if (c.spec.commandPattern?.test(word)) {
      out.push({ start, end, group: "function.call" });
      return;
    }
    const called = c.spec.functionCalls !== false && text.charCodeAt(next) === 40;
    if (c.spec.memberAccess !== false && this.afterMemberOperator(start)) {
      out.push({ start, end, group: called ? "function.method.call" : "variable.member" });
      return;
    }
    if (called || (c.spec.bareBuiltins && c.builtins.has(key))) {
      out.push({ start, end, group: c.builtins.has(key) ? "function.builtin" : "function.call" });
      return;
    }
    if (c.spec.upperCaseConstants && word.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(word)) {
      out.push({ start, end, group: "constant" });
      return;
    }
    if (c.spec.capitalizedTypes && /^\p{Lu}/u.test(word)) {
      out.push({ start, end, group: "type" });
    }
  }

  /** `.name`, `?.name` or `->name`, but not `..name` (ranges). */
  private afterMemberOperator(start: number): boolean {
    const { text } = this;
    let k = start - 1;
    while (k >= 0 && (text.charCodeAt(k) === C_SPACE || text.charCodeAt(k) === C_TAB)) k--;
    const char = text[k];
    if (char === ".") return text[k - 1] !== ".";
    return char === ">" && text[k - 1] === "-";
  }
}

export interface SpecTokenizer {
  readonly spec: LanguageSpec;
  tokenize(content: string): HighlightRange[];
}

/** Compiles a spec once; the returned tokenizer is pure and reusable. */
export function createSpecTokenizer(spec: LanguageSpec): SpecTokenizer {
  let compiled: CompiledSpec | undefined;
  return {
    spec,
    tokenize(content: string): HighlightRange[] {
      compiled ??= compile(spec);
      const run = new Run(compiled, content);
      run.tokenize(0, content.length);
      return run.out;
    },
  };
}

/** The word lists a spec colors, for features such as completion. */
export function keywordsOf(spec: LanguageSpec): LanguageKeywords {
  return {
    keywords: spec.keywords ?? [],
    types: spec.types ?? [],
    constants: spec.constants ?? [],
    builtins: spec.builtins ?? [],
    caseInsensitive: spec.caseInsensitive === true,
  };
}
