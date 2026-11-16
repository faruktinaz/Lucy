; Lucy highlight query for CSS (tree-sitter-css 0.25.0), nvim-treesitter capture names.
; Generic patterns come first: OpenTUI lets the later capture win when specificity ties.
; Token lists derive from tree-sitter-css/queries/highlights.scm:
;   The MIT License (MIT), Copyright (c) 2018 Max Brunsfeld. Full notice in ../README.md.

[
  (comment)
  (js_comment)
] @comment

; Selectors

[
  (tag_name)
  (nesting_selector)
  (universal_selector)
] @tag

(class_name) @type

(id_name) @constant

(namespace_name) @module

(attribute_name) @tag.attribute

(attribute_selector
  (plain_value) @string)

(pseudo_class_selector
  (class_name) @attribute)

(pseudo_element_selector
  (tag_name) @attribute)

; Declarations

(property_name) @property

(feature_name) @property

(plain_value) @constant

((property_name) @variable
  (#match? @variable "^--"))

((plain_value) @variable
  (#match? @variable "^--"))

(keyframes_name) @variable

(function_name) @function

; Literals

(string_value) @string

(escape_sequence) @string.escape

[
  (integer_value)
  (float_value)
  (unit)
  (color_value)
] @number

; Keywords

[
  "@media"
  "@import"
  "@charset"
  "@namespace"
  "@supports"
  "@keyframes"
  (at_keyword)
  (to)
  (from)
  (important)
] @keyword

[
  "and"
  "or"
  "not"
  "only"
] @keyword.operator

; Operators and punctuation

[
  "~"
  ">"
  "+"
  "-"
  "*"
  "/"
  "="
  "^="
  "|="
  "~="
  "$="
  "*="
] @operator

(id_selector
  "#" @punctuation.delimiter)

[
  ","
  "."
  ":"
  "::"
  ";"
] @punctuation.delimiter

[
  "{"
  ")"
  "("
  "}"
] @punctuation.bracket
