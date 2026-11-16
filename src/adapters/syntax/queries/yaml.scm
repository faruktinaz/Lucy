; Lucy highlight query for YAML (@tree-sitter-grammars/tree-sitter-yaml 0.7.1),
; nvim-treesitter capture names. Generic patterns come first: OpenTUI lets the later capture win
; when specificity ties, which is how mapping keys override the plain string capture.
; Derived from @tree-sitter-grammars/tree-sitter-yaml/queries/highlights.scm:
;   The MIT License (MIT), Copyright (c) 2024 tree-sitter-grammars contributors,
;   Copyright (c) 2019-2021 Ika. Full notice in ../README.md.

[
  (double_quote_scalar)
  (single_quote_scalar)
  (block_scalar)
  (string_scalar)
] @string

(escape_sequence) @string.escape

(boolean_scalar) @boolean

(null_scalar) @constant.builtin

[
  (integer_scalar)
  (float_scalar)
  (timestamp_scalar)
] @number

(comment) @comment

[
  (anchor_name)
  (alias_name)
] @label

(tag) @type

[
  (yaml_directive)
  (tag_directive)
  (reserved_directive)
] @keyword.directive

; Mapping keys

(block_mapping_pair
  key: (flow_node
    [
      (double_quote_scalar)
      (single_quote_scalar)
    ] @property))

(block_mapping_pair
  key: (flow_node
    (plain_scalar
      (_) @property)))

(flow_mapping
  (_
    key: (flow_node
      [
        (double_quote_scalar)
        (single_quote_scalar)
      ] @property)))

(flow_mapping
  (_
    key: (flow_node
      (plain_scalar
        (_) @property))))

; Punctuation

[
  ","
  "-"
  ":"
  ">"
  "?"
  "|"
] @punctuation.delimiter

[
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  "*"
  "&"
  "---"
  "..."
] @punctuation.special
