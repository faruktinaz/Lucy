; Lucy highlight query for TOML (@tree-sitter-grammars/tree-sitter-toml 0.7.0),
; nvim-treesitter capture names. Generic patterns come first: OpenTUI lets the later capture win
; when specificity ties, which is how table headers override the plain key capture.
; Derived from @tree-sitter-grammars/tree-sitter-toml/queries/highlights.scm:
;   The MIT License (MIT), Copyright (c) Ika <ikatyang@gmail.com>. Full notice in ../README.md.

; Keys

[
  (bare_key)
  (quoted_key)
] @property

(table
  [
    (bare_key)
    (quoted_key)
  ] @type)

(table
  (dotted_key
    [
      (bare_key)
      (quoted_key)
    ] @type))

(table_array_element
  [
    (bare_key)
    (quoted_key)
  ] @type)

(table_array_element
  (dotted_key
    [
      (bare_key)
      (quoted_key)
    ] @type))

; Literals

(string) @string

(escape_sequence) @string.escape

(boolean) @boolean

[
  (integer)
  (float)
] @number

[
  (offset_date_time)
  (local_date_time)
  (local_date)
  (local_time)
] @string.special

(comment) @comment

; Punctuation

"=" @operator

[
  "."
  ","
] @punctuation.delimiter

[
  "["
  "]"
  "[["
  "]]"
  "{"
  "}"
] @punctuation.bracket
