; Lucy highlight query for Rust (tree-sitter-rust 0.24.0), nvim-treesitter capture names.
; Generic patterns come first: OpenTUI lets the later capture win when specificity ties.
; Keyword lists and naming heuristics derive from tree-sitter-rust/queries/highlights.scm:
;   The MIT License (MIT), Copyright (c) 2017 Maxim Sokolov. Full notice in ../README.md.

; Identifiers

(identifier) @variable

; Uppercase names are enum variants or tuple structs (`Some`, `Ok`, `Point`).
((identifier) @constructor
  (#match? @constructor "^[A-Z]"))

((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]+$"))

(type_identifier) @type

(primitive_type) @type.builtin

[
  (field_identifier)
  (shorthand_field_identifier)
] @variable.member

(self) @variable.builtin

(lifetime) @label

(lifetime
  (identifier) @label)

(label) @label

; Modules and paths

(mod_item
  name: (identifier) @module)

(scoped_identifier
  path: (identifier) @module)

(scoped_type_identifier
  path: (identifier) @module)

(scoped_use_list
  path: (identifier) @module)

(use_declaration
  argument: (identifier) @module)

((scoped_identifier
  path: (identifier) @type)
  (#match? @type "^[A-Z]"))

((scoped_type_identifier
  path: (identifier) @type)
  (#match? @type "^[A-Z]"))

; Parameters

(parameter
  pattern: (identifier) @variable.parameter)

(closure_parameters
  (identifier) @variable.parameter)

; Functions

(call_expression
  function: (identifier) @function.call)

(call_expression
  function: (field_expression
    field: (field_identifier) @function.method.call))

(call_expression
  function: (scoped_identifier
    name: (identifier) @function.call))

(generic_function
  function: (identifier) @function.call)

(generic_function
  function: (scoped_identifier
    name: (identifier) @function.call))

(generic_function
  function: (field_expression
    field: (field_identifier) @function.method.call))

(function_item
  name: (identifier) @function)

(function_signature_item
  name: (identifier) @function)

(macro_invocation
  macro: (identifier) @function.macro
  "!" @function.macro)

(macro_invocation
  macro: (scoped_identifier
    name: (identifier) @function.macro))

(macro_definition
  name: (identifier) @function.macro)

; Attributes

[
  (attribute_item)
  (inner_attribute_item)
] @attribute

(attribute
  (identifier) @attribute)

(attribute
  (scoped_identifier
    name: (identifier) @attribute))

; Literals

[
  (string_literal)
  (raw_string_literal)
] @string

(char_literal) @character

(escape_sequence) @string.escape

(integer_literal) @number

(float_literal) @number.float

(boolean_literal) @boolean

[
  (line_comment)
  (block_comment)
] @comment

[
  (line_comment
    (doc_comment))
  (block_comment
    (doc_comment))
] @comment.documentation

; Operators

[
  "="
  "=="
  "!="
  "<="
  ">="
  "+"
  "-"
  "*"
  "/"
  "%"
  "!"
  "&"
  "&&"
  "|"
  "||"
  "^"
  "<<"
  ">>"
  "+="
  "-="
  "*="
  "/="
  "%="
  "&="
  "|="
  "^="
  "<<="
  ">>="
  "->"
  "=>"
  ".."
  "..="
  "?"
  "<"
  ">"
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

(type_arguments
  [
    "<"
    ">"
  ] @punctuation.bracket)

(type_parameters
  [
    "<"
    ">"
  ] @punctuation.bracket)

[
  "::"
  ":"
  "."
  ","
  ";"
] @punctuation.delimiter

; Keywords

[
  "as"
  "default"
  "dyn"
  "in"
  "let"
  "where"
  "macro_rules!"
  "raw"
  (crate)
  (super)
] @keyword

"fn" @keyword.function

[
  "return"
  "yield"
] @keyword.return

[
  "async"
  "await"
  "gen"
] @keyword.coroutine

[
  "use"
  "mod"
  "extern"
] @keyword.import

[
  "if"
  "else"
  "match"
] @keyword.conditional

[
  "for"
  "while"
  "loop"
  "break"
  "continue"
] @keyword.repeat

[
  "struct"
  "enum"
  "union"
  "trait"
  "type"
  "impl"
] @keyword.type

[
  "pub"
  "const"
  "static"
  "unsafe"
  "ref"
  "move"
  (mutable_specifier)
] @keyword.modifier

(use_list
  (self) @keyword)

(scoped_use_list
  (self) @keyword)

(scoped_identifier
  (self) @keyword)
