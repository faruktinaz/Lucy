; Lucy highlight query for Bash, sh and zsh scripts (tree-sitter-bash 0.25.1),
; nvim-treesitter capture names. Generic patterns come first: OpenTUI lets the later capture win
; when specificity ties.
; Keyword and operator lists derive from tree-sitter-bash/queries/highlights.scm:
;   The MIT License (MIT), Copyright (c) 2017 Max Brunsfeld. Full notice in ../README.md.

; Literals

[
  (string)
  (raw_string)
  (ansi_c_string)
  (translated_string)
  (heredoc_body)
] @string

[
  (heredoc_start)
  (heredoc_end)
] @label

(regex) @string.regexp

[
  (number)
  (file_descriptor)
] @number

((word) @number
  (#match? @number "^[0-9]+$"))

(comment) @comment

; Variables

(variable_name) @variable

(special_variable_name) @constant

; Commands and functions

(command_name) @function.call

(function_definition
  name: (word) @function)

(command
  argument: (word) @variable.parameter
  (#match? @variable.parameter "^-"))

; Operators

[
  "&&"
  "||"
  "|"
  "|&"
  ">"
  ">>"
  "<"
  "&>"
  "&>>"
  ">&"
  "<&"
  "<<"
  "<<-"
  "<<<"
  "="
  "+="
  "=="
  "!="
  "=~"
  "!"
] @operator

(test_operator) @operator

; Punctuation

[
  "("
  ")"
  "{"
  "}"
  "["
  "]"
  "[["
  "]]"
  "(("
  "))"
] @punctuation.bracket

[
  ";"
  ";;"
  "&"
] @punctuation.delimiter

; Expansions (after the brackets so they win the tie)

(simple_expansion
  "$" @punctuation.special)

(expansion
  "${" @punctuation.special
  "}" @punctuation.special)

(command_substitution
  "$(" @punctuation.special
  ")" @punctuation.special)

; Keywords

[
  "declare"
  "typeset"
  "export"
  "readonly"
  "local"
  "unset"
  "unsetenv"
] @keyword

"function" @keyword.function

[
  "if"
  "then"
  "else"
  "elif"
  "fi"
  "case"
  "in"
  "esac"
] @keyword.conditional

[
  "for"
  "select"
  "while"
  "until"
  "do"
  "done"
] @keyword.repeat

(for_statement
  "in" @keyword.repeat)
