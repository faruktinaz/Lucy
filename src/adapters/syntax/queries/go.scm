; Lucy highlight query for Go (tree-sitter-go 0.25.0), nvim-treesitter capture names.
; Generic patterns come first: OpenTUI lets the later capture win when specificity ties.
; Keyword, operator and builtin lists derive from tree-sitter-go/queries/highlights.scm:
;   The MIT License (MIT), Copyright (c) 2014 Max Brunsfeld. Full notice in ../README.md.

; Identifiers

(identifier) @variable

(package_identifier) @module

(type_identifier) @type

((type_identifier) @type.builtin
  (#any-of? @type.builtin
    "any" "bool" "byte" "comparable" "complex128" "complex64" "error" "float32" "float64" "int" "int16"
    "int32" "int64" "int8" "rune" "string" "uint" "uint16" "uint32" "uint64" "uint8" "uintptr"))

(field_identifier) @variable.member

(label_name) @label

(const_spec
  name: (identifier) @constant)

; Parameters

(parameter_declaration
  name: (identifier) @variable.parameter)

(variadic_parameter_declaration
  name: (identifier) @variable.parameter)

; Functions

(call_expression
  function: (identifier) @function.call)

(call_expression
  function: (selector_expression
    field: (field_identifier) @function.method.call))

((call_expression
  function: (identifier) @function.builtin)
  (#match? @function.builtin
    "^(append|cap|clear|close|complex|copy|delete|imag|len|make|max|min|new|panic|print|println|real|recover)$"))

(function_declaration
  name: (identifier) @function)

(method_declaration
  name: (field_identifier) @function.method)

(method_elem
  name: (field_identifier) @function.method)

; Literals

[
  (interpreted_string_literal)
  (raw_string_literal)
] @string

(rune_literal) @character

(escape_sequence) @string.escape

[
  (int_literal)
  (imaginary_literal)
] @number

(float_literal) @number.float

[
  (true)
  (false)
] @boolean

[
  (nil)
  (iota)
] @constant.builtin

(comment) @comment

; Operators

[
  "--"
  "-"
  "-="
  ":="
  "!"
  "!="
  "..."
  "*"
  "*="
  "/"
  "/="
  "&"
  "&&"
  "&="
  "&^"
  "&^="
  "%"
  "%="
  "^"
  "^="
  "+"
  "++"
  "+="
  "<-"
  "<"
  "<<"
  "<<="
  "<="
  "="
  "=="
  ">"
  ">="
  ">>"
  ">>="
  "|"
  "|="
  "||"
  "~"
] @operator

; Punctuation

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ","
  "."
  ";"
  ":"
] @punctuation.delimiter

; Keywords

[
  "const"
  "var"
  "goto"
  "fallthrough"
] @keyword

"func" @keyword.function

"return" @keyword.return

[
  "go"
  "defer"
] @keyword.coroutine

[
  "import"
  "package"
] @keyword.import

[
  "if"
  "else"
  "switch"
  "select"
  "case"
  "default"
] @keyword.conditional

[
  "for"
  "range"
  "break"
  "continue"
] @keyword.repeat

[
  "type"
  "struct"
  "interface"
  "map"
  "chan"
] @keyword.type
