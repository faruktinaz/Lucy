/**
 * `when` clauses: a tiny, safe expression language for "in which context does this binding
 * or command apply". It is parsed by hand into a tree and evaluated by walking it; there is
 * no `eval` and no access to anything but the context keys.
 *
 *   expr       := or
 *   or         := and ( "||" and )*
 *   and        := unary ( "&&" unary )*
 *   unary      := "!" unary | primary
 *   primary    := "(" expr ")" | "true" | "false" | comparison
 *   comparison := IDENT ( ( "==" | "!=" ) STRING )?
 *   IDENT      := [A-Za-z_][A-Za-z0-9_.-]*
 *   STRING     := '...' or "..." with \\ escapes
 *
 * A bare identifier is truthy when its value is `true`, a non-empty string or a non-zero
 * number. `key == 'value'` compares the value's string form.
 */
import { LucyError } from "../errors";

export type WhenExpr =
  | { readonly kind: "const"; readonly value: boolean }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "equals"; readonly key: string; readonly value: string; readonly negate: boolean }
  | { readonly kind: "not"; readonly expr: WhenExpr }
  | { readonly kind: "and" | "or"; readonly left: WhenExpr; readonly right: WhenExpr };

export class WhenParseError extends LucyError {
  readonly expression: string;
  /** 0-based offset of the problem in `expression`. */
  readonly position: number;

  constructor(expression: string, position: number, message: string) {
    super("INVALID_ARGUMENT", `${message} at position ${position + 1} in "${expression}"`, {
      details: { expression, position },
    });
    this.name = "WhenParseError";
    this.expression = expression;
    this.position = position;
  }
}

const MAX_LENGTH = 1000;
const MAX_DEPTH = 32;

type Token =
  | { type: "ident"; value: string; pos: number }
  | { type: "string"; value: string; pos: number }
  | { type: "op"; value: "(" | ")" | "!" | "&&" | "||" | "==" | "!="; pos: number }
  | { type: "end"; pos: number };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? "";
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=") {
      tokens.push({ type: "op", value: two, pos: i });
      i += 2;
      continue;
    }
    if (char === "(" || char === ")" || char === "!") {
      tokens.push({ type: "op", value: char, pos: i });
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      const start = i;
      let value = "";
      i++;
      while (i < source.length && source[i] !== char) {
        if (source[i] === "\\" && i + 1 < source.length) i++;
        value += source[i];
        i++;
      }
      if (i >= source.length) throw new WhenParseError(source, start, "Unterminated string");
      i++;
      tokens.push({ type: "string", value, pos: start });
      continue;
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(i));
    if (ident) {
      tokens.push({ type: "ident", value: ident[0], pos: i });
      i += ident[0].length;
      continue;
    }
    throw new WhenParseError(source, i, `Unexpected character "${char}"`);
  }
  tokens.push({ type: "end", pos: source.length });
  return tokens;
}

/** Parses a `when` expression. Throws `WhenParseError` with the offending position. */
export function parseWhen(source: string): WhenExpr {
  if (source.length > MAX_LENGTH) throw new WhenParseError(source, MAX_LENGTH, "Expression is too long");
  const tokens = tokenize(source);
  let index = 0;
  const peek = (): Token => tokens[index] ?? { type: "end", pos: source.length };
  const next = (): Token => {
    const token = peek();
    index++;
    return token;
  };
  const isOp = (token: Token, value: string): boolean => token.type === "op" && token.value === value;

  const parseOr = (depth: number): WhenExpr => {
    let left = parseAnd(depth);
    while (isOp(peek(), "||")) {
      next();
      left = { kind: "or", left, right: parseAnd(depth) };
    }
    return left;
  };
  const parseAnd = (depth: number): WhenExpr => {
    let left = parseUnary(depth);
    while (isOp(peek(), "&&")) {
      next();
      left = { kind: "and", left, right: parseUnary(depth) };
    }
    return left;
  };
  const parseUnary = (depth: number): WhenExpr => {
    if (depth > MAX_DEPTH) throw new WhenParseError(source, peek().pos, "Expression is nested too deeply");
    if (isOp(peek(), "!")) {
      next();
      return { kind: "not", expr: parseUnary(depth + 1) };
    }
    return parsePrimary(depth);
  };
  const parsePrimary = (depth: number): WhenExpr => {
    const token = next();
    if (isOp(token, "(")) {
      const inner = parseOr(depth + 1);
      const close = next();
      if (!isOp(close, ")")) throw new WhenParseError(source, close.pos, 'Expected ")"');
      return inner;
    }
    if (token.type !== "ident") {
      throw new WhenParseError(
        source,
        token.pos,
        token.type === "end" ? "Unexpected end" : "Expected a context key",
      );
    }
    if (token.value === "true" || token.value === "false")
      return { kind: "const", value: token.value === "true" };
    const op = peek();
    if (isOp(op, "==") || isOp(op, "!=")) {
      next();
      const value = next();
      if (value.type !== "string") throw new WhenParseError(source, value.pos, "Expected a quoted string");
      return {
        kind: "equals",
        key: token.value,
        value: value.value,
        negate: op.type === "op" && op.value === "!=",
      };
    }
    return { kind: "key", key: token.value };
  };

  const expr = parseOr(0);
  const rest = peek();
  if (rest.type !== "end") throw new WhenParseError(source, rest.pos, "Unexpected token");
  return expr;
}

export function isTruthy(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  return value === true;
}

function stringForm(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function evaluateWhen(expr: WhenExpr, lookup: (key: string) => unknown): boolean {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "key":
      return isTruthy(lookup(expr.key));
    case "equals": {
      const equal = stringForm(lookup(expr.key)) === expr.value;
      return expr.negate ? !equal : equal;
    }
    case "not":
      return !evaluateWhen(expr.expr, lookup);
    case "and":
      return evaluateWhen(expr.left, lookup) && evaluateWhen(expr.right, lookup);
    case "or":
      return evaluateWhen(expr.left, lookup) || evaluateWhen(expr.right, lookup);
  }
}

/** Every context key an expression reads, with the string values it is compared against. */
export function whenKeys(expr: WhenExpr, into = new Map<string, Set<string>>()): Map<string, Set<string>> {
  switch (expr.kind) {
    case "const":
      break;
    case "key":
      if (!into.has(expr.key)) into.set(expr.key, new Set());
      break;
    case "equals": {
      const values = into.get(expr.key) ?? new Set<string>();
      values.add(expr.value);
      into.set(expr.key, values);
      break;
    }
    case "not":
      whenKeys(expr.expr, into);
      break;
    case "and":
    case "or":
      whenKeys(expr.left, into);
      whenKeys(expr.right, into);
      break;
  }
  return into;
}

const OTHER_VALUE = "\u0000other";
const MAX_ASSIGNMENTS = 4096;

/**
 * Whether two `when` clauses can both be true in some context (undefined means "always").
 * Decided exactly by enumerating the relevant values of every key involved; expressions are
 * tiny, and if the space ever grows too large the answer is conservatively "yes".
 * `exclusiveGroups` lists keys of which at most one can be truthy at a time (focus zones);
 * contexts that violate a group are skipped because they never occur.
 */
export function whenOverlap(
  a: WhenExpr | undefined,
  b: WhenExpr | undefined,
  exclusiveGroups: readonly (readonly string[])[] = [],
): boolean {
  const keys = new Map<string, Set<string>>();
  if (a) whenKeys(a, keys);
  if (b) whenKeys(b, keys);
  const names = [...keys.keys()];
  const domains = names.map((name) => [undefined, true, ...(keys.get(name) ?? []), OTHER_VALUE] as unknown[]);
  const total = domains.reduce((n, d) => n * d.length, 1);
  if (total > MAX_ASSIGNMENTS) return true;
  for (let combo = 0; combo < total; combo++) {
    const values = new Map<string, unknown>();
    let rest = combo;
    names.forEach((name, i) => {
      const domain = domains[i] ?? [undefined];
      values.set(name, domain[rest % domain.length]);
      rest = Math.floor(rest / domain.length);
    });
    const lookup = (key: string) => values.get(key);
    const impossible = exclusiveGroups.some(
      (group) => group.filter((key) => isTruthy(values.get(key))).length > 1,
    );
    if (impossible) continue;
    if ((!a || evaluateWhen(a, lookup)) && (!b || evaluateWhen(b, lookup))) return true;
  }
  return false;
}
