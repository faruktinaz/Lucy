; Lucy highlight query for HTML (tree-sitter-html 0.23.2), nvim-treesitter capture names.
; Also used, best effort, for XML files.
; Derived from tree-sitter-html/queries/highlights.scm:
;   The MIT License (MIT), Copyright (c) 2014 Max Brunsfeld. Full notice in ../README.md.

(tag_name) @tag

(erroneous_end_tag_name) @tag

(doctype) @constant

(attribute_name) @tag.attribute

[
  (attribute_value)
  (quoted_attribute_value)
] @string

(entity) @character.special

(comment) @comment

"=" @operator

[
  "<"
  ">"
  "</"
  "/>"
  "<!"
] @tag.delimiter
