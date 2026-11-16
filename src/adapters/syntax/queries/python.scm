; Lucy highlight query for Python (tree-sitter-python 0.25.0), nvim-treesitter capture names.
; Generic patterns come first: OpenTUI lets the later capture win when specificity ties.
; Keyword, operator and builtin lists derive from tree-sitter-python/queries/highlights.scm:
;   The MIT License (MIT), Copyright (c) 2016 Max Brunsfeld. Full notice in ../README.md.

; Identifiers

(identifier) @variable

((identifier) @type
  (#match? @type "^[A-Z].*[a-z]"))

((identifier) @constant
  (#match? @constant "^[A-Z][A-Z0-9_]*$"))

(attribute
  attribute: (identifier) @variable.member)

(keyword_argument
  name: (identifier) @variable.parameter)

; Imports

(import_statement
  name: (dotted_name
    (identifier) @module))

(import_from_statement
  module_name: (dotted_name
    (identifier) @module))

(aliased_import
  alias: (identifier) @module)

; Types

(type
  (identifier) @type)

(class_definition
  name: (identifier) @type)

(class_definition
  superclasses: (argument_list
    (identifier) @type))

; Parameters

(parameters
  (identifier) @variable.parameter)

(lambda_parameters
  (identifier) @variable.parameter)

(default_parameter
  name: (identifier) @variable.parameter)

(typed_parameter
  (identifier) @variable.parameter)

(typed_default_parameter
  name: (identifier) @variable.parameter)

(list_splat_pattern
  (identifier) @variable.parameter)

(dictionary_splat_pattern
  (identifier) @variable.parameter)

; `self` and `cls` stay builtins even where they are parameters.
((identifier) @variable.builtin
  (#any-of? @variable.builtin "self" "cls"))

; Functions

(call
  function: (identifier) @function.call)

(call
  function: (attribute
    attribute: (identifier) @function.method.call))

((call
  function: (identifier) @function.builtin)
  (#match? @function.builtin
    "^(abs|all|any|ascii|bin|bool|breakpoint|bytearray|bytes|callable|chr|classmethod|compile|complex|delattr|dict|dir|divmod|enumerate|eval|exec|filter|float|format|frozenset|getattr|globals|hasattr|hash|help|hex|id|input|int|isinstance|issubclass|iter|len|list|locals|map|max|memoryview|min|next|object|oct|open|ord|pow|print|property|range|repr|reversed|round|set|setattr|slice|sorted|staticmethod|str|sum|super|tuple|type|vars|zip|__import__)$"))

(function_definition
  name: (identifier) @function)

(decorator
  "@" @attribute)

(decorator
  (identifier) @attribute)

(decorator
  (attribute
    attribute: (identifier) @attribute))

(decorator
  (call
    function: (identifier) @attribute))

(decorator
  (call
    function: (attribute
      attribute: (identifier) @attribute)))

; Literals

[
  (true)
  (false)
] @boolean

[
  (none)
  (ellipsis)
] @constant.builtin

(integer) @number

(float) @number.float

(comment) @comment

(string) @string

[
  (escape_sequence)
  (escape_interpolation)
] @string.escape

; Operators

[
  "-"
  "-="
  "!="
  "*"
  "**"
  "**="
  "*="
  "/"
  "//"
  "//="
  "/="
  "&"
  "&="
  "%"
  "%="
  "^"
  "^="
  "+"
  "->"
  "+="
  "<"
  "<<"
  "<<="
  "<="
  "<>"
  "="
  ":="
  "=="
  ">"
  ">="
  ">>"
  ">>="
  "|"
  "|="
  "~"
  "@="
] @operator

[
  "and"
  "in"
  "is"
  "not"
  "or"
  "is not"
  "not in"
] @keyword.operator

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
  ":"
  ";"
] @punctuation.delimiter

; Placed after the brackets so it wins their tie.
(interpolation
  "{" @punctuation.special
  "}" @punctuation.special)

; Keywords

[
  "assert"
  "del"
  "exec"
  "global"
  "nonlocal"
  "pass"
  "print"
  "with"
  "as"
] @keyword

[
  "def"
  "lambda"
] @keyword.function

"class" @keyword.type

[
  "async"
  "await"
] @keyword.coroutine

[
  "return"
  "yield"
] @keyword.return

[
  "import"
  "from"
] @keyword.import

[
  "if"
  "elif"
  "else"
  "match"
  "case"
] @keyword.conditional

[
  "for"
  "while"
  "break"
  "continue"
] @keyword.repeat

[
  "try"
  "except"
  "finally"
  "raise"
] @keyword.exception

(for_statement
  "in" @keyword.repeat)

(for_in_clause
  "in" @keyword.repeat)
