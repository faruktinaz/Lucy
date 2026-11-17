/**
 * Languages colored by tokenizers (spec-driven and dedicated) and composite files, through the
 * service exactly as the viewer and the diff view use it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  fallbackTokenizerFor,
  SyntaxService,
  type SyntaxTokenName,
  syntaxGroupToToken,
  tokenizeLines,
} from "../../src/adapters/syntax";
import { makeTempDir, probe, removeTempDirs } from "./helpers";

const service = new SyntaxService({ dataPath: join(makeTempDir("tokenizers"), "cache") });

afterAll(async () => {
  await service.disposeAsync();
  removeTempDirs();
});

type Expectation = readonly [needle: string, token: SyntaxTokenName | null, nth?: number];

interface Case {
  readonly language: string;
  readonly content: string;
  readonly expect: readonly Expectation[];
}

async function check({ language, content, expect: expectations }: Case): Promise<void> {
  const ranges = await service.highlight(content, language);
  // Every emitted group must be one the UI styles, or it would silently render uncolored.
  const unstyled = [...new Set(ranges.map((r) => r.group))].filter((g) => syntaxGroupToToken(g) === null);
  expect(`${language}: ${unstyled.join(", ")}`).toBe(`${language}: `);
  const lines = tokenizeLines(content, ranges);
  for (const [needle, token, nth] of expectations) {
    const found = probe(content, lines, needle, nth ?? 0);
    expect(`${language} ${needle} → ${found.token} (${found.group})`).toBe(
      `${language} ${needle} → ${token} (${found.group})`,
    );
  }
}

const TOKENIZER_CASES: readonly Case[] = [
  {
    language: "sql",
    content: `-- Active users
SELECT u.id, u.name AS "Full Name", COUNT(o.id) AS orders
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
WHERE u.created_at > NOW() - INTERVAL '30 days' AND u.status = 'it''s' AND u.age >= :min_age
GROUP BY u.id HAVING count(*) > 1;
/* block */ create table items (id serial primary key, price numeric(10, 2) not null default 0.0, tags jsonb);
`,
    expect: [
      ["-- Active", "comment"],
      ["SELECT", "keyword"],
      ["id,", "property"],
      ['"Full Name"', "property"],
      ["COUNT", "function"],
      ["FROM", "keyword"],
      ["users u", "type"],
      ["LEFT", "keyword"],
      ["NOW", "function"],
      ["INTERVAL", "type"],
      ["'30 days'", "string"],
      ["''s", "regexp"],
      [":min_age", "parameter"],
      ["count(*)", "function"],
      ["1;", "number"],
      ["/* block", "comment"],
      ["create table", "keyword"],
      ["items", "type"],
      ["serial", "type"],
      ["numeric", "type"],
      ["0.0", "number"],
      ["jsonb", "type"],
    ],
  },
  {
    language: "c",
    content: `#include <stdio.h>
#define MAX_ITEMS 64
/* Sum two numbers. */
static int add(int a, int b) {
    return a + b; // done
}
int main(void) {
    struct point p = {0};
    char *s = "hi\\n";
    printf("%d\\n", add(1, 0x1F));
    return p.x > MAX_ITEMS ? 1 : 0;
}
`,
    expect: [
      ["#include", "keyword"],
      ["<stdio.h>", "string"],
      ["#define", "keyword"],
      ["MAX_ITEMS", "constant"],
      ["/* Sum", "comment"],
      ["static", "keyword"],
      ["int", "type"],
      ["add", "function"],
      ["return", "keyword"],
      ["// done", "comment"],
      ["struct", "keyword"],
      ["point", "type"],
      ['"hi', "string"],
      ["\\n", "regexp"],
      ["printf", "function"],
      ["0x1F", "number"],
      ["x >", "property"],
    ],
  },
  {
    language: "cpp",
    content: `#include <vector>
namespace app {
template <typename T>
class Box final : public Base {
public:
  auto get() const noexcept -> T { return value_; }
  std::vector<int> items{1, 2};
  const char* raw = R"(a\\nb)";
};
}  // namespace app
`,
    expect: [
      ["namespace", "keyword"],
      ["app {", "type"],
      ["template", "keyword"],
      ["typename", "keyword"],
      ["class", "keyword"],
      ["Box", "type"],
      ["public:", "keyword"],
      ["auto", "keyword"],
      ["get", "function"],
      ["noexcept", "keyword"],
      ["vector<int>", "type"],
      ['R"(', "string"],
      ["// namespace", "comment"],
    ],
  },
  {
    language: "csharp",
    content: `using System;
namespace Demo;
public sealed class Greeter : IGreeter {
    public async Task<string> GreetAsync(string name) {
        var msg = $"Hello {name}!";
        return await Task.FromResult(msg ?? @"none"); // done
    }
}
`,
    expect: [
      ["using", "keyword"],
      ["namespace", "keyword"],
      ["sealed", "keyword"],
      ["Greeter", "type"],
      ["IGreeter", "type"],
      ["Task", "type"],
      ["string", "type"],
      ["GreetAsync", "function"],
      ["var", "keyword"],
      ['$"Hello', "string"],
      ["{name", "punctuation"],
      ["await", "keyword"],
      ["FromResult", "function"],
      ['@"none"', "string"],
      ["// done", "comment"],
    ],
  },
  {
    language: "java",
    content: `package demo;
import java.util.List;
@Override
public class Main {
    private static final int MAX_SIZE = 10;
    public static void main(String[] args) {
        String text = """
            block""";
        System.out.println("hi " + args.length + 'c');
    }
}
`,
    expect: [
      ["package", "keyword"],
      ["@Override", "attribute"],
      ["class", "keyword"],
      ["Main", "type"],
      ["MAX_SIZE", "constant"],
      ["void", "type"],
      ["String[]", "type"],
      ['"""', "string"],
      ["block", "string"],
      ["println", "function"],
      ["length", "property"],
      ["'c'", "string"],
    ],
  },
  {
    language: "kotlin",
    content: `package app
data class User(val name: String, val age: Int = 0)
fun greet(user: User?): String {
    val data = "x"
    return "Hello \${user?.name} and $data"
}
@JvmStatic fun main() = println(greet(null))
`,
    expect: [
      ["data class", "keyword"],
      ["class", "keyword"],
      ["User", "type"],
      ["val", "keyword"],
      ["String", "type"],
      ["fun", "keyword"],
      ["greet", "function"],
      ["data =", null],
      ["${", "punctuation"],
      ["name}", "property"],
      ["$data", "variable"],
      ["@JvmStatic", "attribute"],
      ["println", "function"],
      ["null", "constant"],
    ],
  },
  {
    language: "swift",
    content: `import SwiftUI
struct ContentView: View {
    @State private var count = 0
    var body: some View {
        Text("Count: \\(count)") // label
    }
    func increment() { count += 1 }
}
#if DEBUG
let x: Int? = nil
#endif
`,
    expect: [
      ["import", "keyword"],
      ["struct", "keyword"],
      ["ContentView", "type"],
      ["View", "type"],
      ["@State", "attribute"],
      ["private", "keyword"],
      ["some", "keyword"],
      ["Text", "function"],
      ['"Count', "string"],
      ["\\(", "punctuation"],
      ["// label", "comment"],
      ["func", "keyword"],
      ["increment", "function"],
      ["#if", "keyword"],
      ["nil", "constant"],
    ],
  },
  {
    language: "dart",
    content: `import 'package:flutter/material.dart';
class Counter extends StatelessWidget {
  final int count;
  const Counter({required this.count});
  @override
  Widget build(BuildContext context) => Text('Count: $count \${count + 1}');
}
`,
    expect: [
      ["import", "keyword"],
      ["'package", "string"],
      ["class", "keyword"],
      ["Counter", "type"],
      ["extends", "keyword"],
      ["final", "keyword"],
      ["int", "type"],
      ["required", "keyword"],
      ["@override", "attribute"],
      ["Widget", "type"],
      ["build", "function"],
      ["$count", "variable"],
      ["${", "punctuation"],
    ],
  },
  {
    language: "scala",
    content: `object Main extends App {
  case class Point(x: Int, y: Int)
  def norm(p: Point): Double = math.sqrt(p.x * p.x)
  val s = s"x=\${1 + 2}"
  println(s) // out
}
`,
    expect: [
      ["object", "keyword"],
      ["Main", "type"],
      ["case", "keyword"],
      ["Point", "type"],
      ["def", "keyword"],
      ["norm", "function"],
      ["Double", "type"],
      ["sqrt", "function"],
      ["${", "punctuation"],
      ["// out", "comment"],
    ],
  },
  {
    language: "groovy",
    content: `plugins { id 'java' }\ndef version = "1.\${minor}"\ndependencies {\n    implementation 'org:lib:1.0'\n}\n`,
    expect: [
      ["'java'", "string"],
      ["def", "keyword"],
      ['"1.', "string"],
      ["${", "punctuation"],
    ],
  },
  {
    language: "objective-c",
    content: `#import <Foundation/Foundation.h>
@interface Greeter : NSObject
@property (nonatomic, strong) NSString *name;
- (void)greet:(NSString *)who;
@end
@implementation Greeter
- (void)greet:(NSString *)who {
    NSLog(@"Hello %@", who);
    BOOL ok = YES; // done
}
@end
`,
    expect: [
      ["#import", "keyword"],
      ["<Foundation", "string"],
      ["@interface", "keyword"],
      ["Greeter", "type"],
      ["NSObject", "type"],
      ["@property", "keyword"],
      ["nonatomic", "keyword"],
      ["NSString", "type"],
      ["void", "type"],
      ["greet:", "function"],
      ["@end", "keyword"],
      ["NSLog", "function"],
      ['@"Hello', "string"],
      ["BOOL", "type"],
      ["YES", "constant"],
      ["// done", "comment"],
    ],
  },
  {
    language: "ruby",
    content: `# frozen_string_literal: true
require "json"
module Shop
  class Cart < Base
    attr_reader :items
    def total(tax: 0.2)
      @items.sum { |i| i.price } * (1 + tax) if valid?
    end
  end
end
puts "Total: #{Shop::Cart.new.total}"
`,
    expect: [
      ["# frozen", "comment"],
      ["require", "keyword"],
      ['"json"', "string"],
      ["module", "keyword"],
      ["Shop", "type"],
      ["class", "keyword"],
      ["Cart", "type"],
      ["attr_reader", "keyword"],
      [":items", "constant"],
      ["def", "keyword"],
      ["total", "function"],
      ["tax:", "property"],
      ["0.2", "number"],
      ["@items", "property"],
      ["if", "keyword"],
      ["puts", "function"],
      ["#{", "punctuation"],
      ["Cart.new", "type"],
    ],
  },
  {
    language: "lua",
    content: `-- config
local M = {}
--[[ block
comment ]]
function M.setup(opts)
  local name = opts.name or "world"
  print(("hi %s"):format(name), #opts, nil, true)
  return [[raw
string]]
end
return M
`,
    expect: [
      ["-- config", "comment"],
      ["local", "keyword"],
      ["--[[", "comment"],
      ["comment ]]", "comment"],
      ["function", "keyword"],
      ["setup", "function"],
      ["name or", "property"],
      ["or", "keyword"],
      ['"world"', "string"],
      ["print", "function"],
      ["nil", "constant"],
      ["true", "constant"],
      ["[[raw", "string"],
      ["string]]", "string"],
      ["end", "keyword"],
    ],
  },
  {
    language: "perl",
    content: `#!/usr/bin/perl
use strict;
my @items = (1, 2);
my %seen;
sub total {
    my ($self, $n) = @_;
    return scalar(@items) + $n; # sum
}
print "Total: $total\\n";
=pod
Docs here
=cut
`,
    expect: [
      ["#!/usr", "comment"],
      ["use", "keyword"],
      ["my", "keyword"],
      ["@items", "variable"],
      ["%seen", "variable"],
      ["sub", "keyword"],
      ["total", "function"],
      ["$self", "variable"],
      ["scalar", "keyword"],
      ["# sum", "comment"],
      ['"Total', "string"],
      ["$total", "variable"],
      ["=pod", "comment"],
      ["Docs here", "comment"],
    ],
  },
  {
    language: "r",
    content: `# analysis
library(dplyr)
df <- data.frame(x = c(1, 2.5), y = NA)
result <- df %>% filter(x > 1) %>% summarise(total = sum(x))
if (nrow(result) == 0L) print("empty") else TRUE
`,
    expect: [
      ["# analysis", "comment"],
      ["library", "function"],
      ["<-", "operator"],
      ["data.frame", "function"],
      ["NA", "constant"],
      ["%>%", "operator"],
      ["filter", "function"],
      ["if", "keyword"],
      ["0L", "number"],
      ['"empty"', "string"],
      ["TRUE", "constant"],
    ],
  },
  {
    language: "elixir",
    content: `defmodule Shop.Cart do
  @moduledoc "Cart"
  alias Shop.Item
  def total(%{items: items}, opts \\\\ []) do
    Enum.reduce(items, 0, fn item, acc -> acc + item.price end)
  end
  defp tag(name), do: :"#{name}" <> ~r/^\\w+$/i
end
`,
    expect: [
      ["defmodule", "keyword"],
      ["Shop", "type"],
      ["@moduledoc", "attribute"],
      ["alias", "keyword"],
      ["def", "keyword"],
      ["total", "function"],
      ["items:", "property"],
      ["Enum", "type"],
      ["reduce", "function"],
      ["fn", "keyword"],
      ["->", "operator"],
      ["price", "property"],
      ["defp", "keyword"],
      ["tag", "function"],
      [':"', "constant"],
      ["~r/", "regexp"],
    ],
  },
  {
    language: "haskell",
    content: `{-# LANGUAGE OverloadedStrings #-}
module Main where
import qualified Data.Map as M
-- | Entry point.
main :: IO ()
main = do
  let xs = [1, 2, 3] :: [Int]
  putStrLn ("sum: " ++ show (sum xs)) {- inline -}
data Shape = Circle Double | Square Double deriving (Show)
`,
    expect: [
      ["{-#", "keyword"],
      ["module", "keyword"],
      ["Main", "type"],
      ["where", "keyword"],
      ["qualified", "keyword"],
      ["Data", "type"],
      ["-- |", "comment"],
      ["main ::", "function"],
      ["IO", "type"],
      ["let", "keyword"],
      [":: [", "operator"],
      ['"sum: "', "string"],
      ["++", "operator"],
      ["{- inline", "comment"],
      ["data", "keyword"],
      ["Shape", "type"],
      ["Circle", "type"],
      ["deriving", "keyword"],
    ],
  },
  {
    language: "powershell",
    content: `# Deploy script
param([string]$Path = "C:\\temp", [switch]$Force)
function Invoke-Deploy {
    <# block #>
    $items = Get-ChildItem -Path $Path -Recurse
    if ($items.Count -gt 0 -and $Force) { Write-Host "Found $($items.Count) items" }
    return $true
}
`,
    expect: [
      ["# Deploy", "comment"],
      ["param", "keyword"],
      ["[string]", "type"],
      ["$Path", "variable"],
      ['"C:', "string"],
      ["function", "keyword"],
      ["Invoke-Deploy", "function"],
      ["<# block", "comment"],
      ["Get-ChildItem", "function"],
      ["-Path", "parameter"],
      ["-gt", "keyword"],
      ["-and", "keyword"],
      ["Write-Host", "function"],
      ["$(", "punctuation"],
      ["$true", "constant"],
    ],
  },
  {
    language: "graphql",
    content: `# Query users
query GetUsers($first: Int = 10) @cached {
  users(first: $first) {
    id
    name @deprecated(reason: "use fullName")
    ...UserFields
  }
}
type User implements Node { id: ID! email: String }
`,
    expect: [
      ["# Query", "comment"],
      ["query", "keyword"],
      ["GetUsers", "type"],
      ["$first", "parameter"],
      ["Int", "type"],
      ["10", "number"],
      ["@cached", "attribute"],
      ["users(", "function"],
      ["first: $", "property"],
      ["@deprecated", "attribute"],
      ['"use', "string"],
      ["...", "operator"],
      ["UserFields", "type"],
      ["type", "keyword"],
      ["implements", "keyword"],
      ["ID", "type"],
      ["email:", "property"],
    ],
  },
  {
    language: "protobuf",
    content: `syntax = "proto3";
package shop.v1;
// A cart.
message Cart {
  repeated Item items = 1;
  map<string, int32> counts = 2;
  optional bool paid = 3 [deprecated = true];
}
service CartService { rpc GetCart(GetCartRequest) returns (Cart); }
`,
    expect: [
      ["syntax", "keyword"],
      ['"proto3"', "string"],
      ["package", "keyword"],
      ["// A cart", "comment"],
      ["message", "keyword"],
      ["Cart", "type"],
      ["repeated", "keyword"],
      ["Item", "type"],
      ["1;", "number", 1],
      ["map", "keyword"],
      ["string", "type"],
      ["int32", "type"],
      ["bool", "type"],
      ["true", "constant"],
      ["service", "keyword"],
      ["CartService", "type"],
      ["rpc", "keyword"],
      ["GetCart", "function"],
      ["returns", "keyword"],
    ],
  },
  {
    language: "terraform",
    content: `# Web server
variable "region" {
  default = "eu-west-1"
}
resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = var.size == "large" ? "m5.large" : "t3.micro"
  tags = { Name = "web-\${var.env}" }
  count = length(var.zones) // per zone
  user_data = <<EOF
#!/bin/bash
EOF
}
`,
    expect: [
      ["# Web", "comment"],
      ["variable", "keyword"],
      ['"region"', "string"],
      ["default", "property"],
      ['"eu-west-1"', "string"],
      ["resource", "keyword"],
      ["ami", "property"],
      ["data.", "keyword"],
      ["instance_type", "property"],
      ["==", "operator"],
      ['"m5.large"', "string"],
      ["Name", "property"],
      ["${", "punctuation"],
      ["length", "function"],
      ["// per zone", "comment"],
      ["<<EOF", "string"],
      ["#!/bin/bash", "string"],
    ],
  },
  {
    language: "nginx",
    content: `# main config
worker_processes auto;
http {
    server {
        listen 80;
        server_name example.com;
        location /api {
            proxy_pass http://127.0.0.1:8080;
            proxy_set_header Host $host;
        }
    }
}
`,
    expect: [
      ["# main", "comment"],
      ["worker_processes", "property"],
      ["http {", "keyword"],
      ["server {", "keyword"],
      ["listen", "property"],
      ["80", "number"],
      ["server_name", "property"],
      ["location", "keyword"],
      ["proxy_pass", "property"],
      ["$host", "property"],
    ],
  },
  {
    language: "dockerfile",
    content: `# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
ARG VERSION=1.0
ENV APP_HOME=/app NODE_ENV=production
WORKDIR $APP_HOME
RUN npm ci --omit=dev \\
    && echo "built $VERSION"
COPY --from=build /app/dist ./dist
CMD ["node", "dist/main.js"]
`,
    expect: [
      ["# syntax", "comment"],
      ["FROM", "keyword"],
      ["AS", "keyword"],
      ["ARG", "keyword"],
      ["VERSION=", "property"],
      ["ENV", "keyword"],
      ["APP_HOME=", "property"],
      ["NODE_ENV", "property"],
      ["WORKDIR", "keyword"],
      ["$APP_HOME", "property"],
      ["RUN", "keyword"],
      ["--omit", "parameter"],
      ["\\\n", "punctuation"],
      ['"built', "string"],
      ["$VERSION", "property"],
      ["--from", "parameter"],
      ["CMD", "keyword"],
      ['"node"', "string"],
    ],
  },
  {
    language: "makefile",
    content: `# Build settings
CC := gcc
CFLAGS ?= -O2 -Wall
SRCS = $(wildcard src/*.c)
.PHONY: all clean
all: build/app
build/app: $(SRCS)
\t@mkdir -p build
\t$(CC) $(CFLAGS) -o $@ $^
ifeq ($(OS),Windows_NT)
\tRM = del
endif
`,
    expect: [
      ["# Build", "comment"],
      ["CC :=", "property"],
      [":=", "operator"],
      ["CFLAGS", "property"],
      ["SRCS", "property"],
      ["wildcard", "function"],
      [".PHONY", "function"],
      ["all: build", "function"],
      ["build/app: $", "function"],
      ["$(SRCS)", "property"],
      ["@mkdir", "operator"],
      ["$@", "property"],
      ["$^", "property"],
      ["ifeq", "keyword"],
      ["$(OS)", "property"],
      ["endif", "keyword"],
    ],
  },
  {
    language: "go-module",
    content: `module github.com/acme/app

go 1.22

require (
\tgithub.com/pkg/errors v0.9.1
\tgolang.org/x/sync v0.7.0 // indirect
)
replace example.com/old => ../new
`,
    expect: [
      ["module", "keyword"],
      ["go 1", "keyword"],
      ["1.22", "number"],
      ["require", "keyword"],
      ["v0.9.1", "number"],
      ["// indirect", "comment"],
      ["replace", "keyword"],
      ["=>", "operator"],
    ],
  },
  {
    language: "xml",
    content: `<?xml version="1.0" encoding="UTF-8"?>
<!-- config -->
<project xmlns:x="urn:x">
  <x:name attr='v'>Lucy &amp; co</x:name>
  <script><![CDATA[ if (a < b) {} ]]></script>
  <empty/>
</project>
`,
    expect: [
      ["<?xml", "keyword"],
      ["version", "attribute"],
      ['"1.0"', "string"],
      ["<!-- config", "comment"],
      ["project", "tag"],
      ["xmlns:x", "attribute"],
      ["x:name", "tag"],
      ["attr", "attribute"],
      ["'v'", "string"],
      ["&amp;", "regexp"],
      ["<![CDATA[", "punctuation"],
      ["if (a", "string"],
      ["empty", "tag"],
      ["/>", "punctuation"],
    ],
  },
  {
    language: "properties",
    content: `! Java properties\n# comment\napp.name = Lucy\napp.home=\${user.home}/lucy\nport: 8080\n`,
    expect: [
      ["! Java", "comment"],
      ["# comment", "comment"],
      ["app.name", "property"],
      ["Lucy", "string"],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal reference in the sample.
      ["${user.home}", "property"],
      ["/lucy", "string"],
      ["8080", "number"],
    ],
  },
  {
    language: "diff",
    content: `diff --git a/src/app.ts b/src/app.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
\\ No newline at end of file
`,
    expect: [
      ["diff --git", "function"],
      ["index 1a2b", "function"],
      ["--- a/", "deleted"],
      ["+++ b/", "inserted"],
      ["@@ -1,3", "type"],
      ["export function main", null],
      [" const a", null],
      ["-const b", "deleted"],
      ["+const b", "inserted"],
      ["\\ No newline", "comment"],
    ],
  },
  {
    language: "csv",
    content: `id,name,price,"notes, with comma"\n1,Widget,9.99,"say ""hi"""\n2,Gadget,19.50,\n`,
    expect: [
      ["id", "function"],
      ["name", "string"],
      ["price", "constant"],
      ['"notes', "type"],
      ["1,", "function"],
      ["Widget", "string"],
      ["9.99", "constant"],
      ['"say', "type"],
      [",name", "punctuation"],
    ],
  },
  {
    language: "tsv",
    content: "a\tb\tc\n1\t2\t3\n",
    expect: [
      ["a", "function"],
      ["b", "string"],
      ["3", "constant"],
    ],
  },
  {
    language: "log",
    content: `2024-05-01T12:00:00.123Z INFO  [main] Server started on http://localhost:8080 (pid=4242)
2024-05-01 12:00:01,456 WARN  Disk usage at 91%
May  1 12:00:02 host app[123]: ERROR Failed to open "config.yml": java.io.FileNotFoundException
[12:00:03] [error] request_id=abc-123 status=500
DEBUG cache miss for key 'user:42'
an error occurred in prose but no level marker
`,
    expect: [
      ["2024-05-01T12", "type"],
      ["INFO", "info"],
      ["http://localhost", "link"],
      ["pid=", "property"],
      ["4242", "number"],
      ["WARN", "warning"],
      ["91", "number"],
      ["May  1", "type"],
      ["ERROR", "error"],
      ['"config.yml"', "string"],
      ["java.io.FileNotFoundException", "error"],
      ["12:00:03", "type"],
      ["error]", "error"],
      ["request_id", "property"],
      ["500", "number"],
      ["DEBUG", "comment"],
      ["'user:42'", "string"],
      ["error occurred", null],
    ],
  },
  {
    language: "git-commit",
    content: `feat(parser)!: support SQL dialects

Explain the change in detail. See #42 and https://example.com/x
# Please enter the commit message for your changes.
# On branch main

Signed-off-by: Lucy <lucy@example.com>
Co-Authored-By: Bot <bot@example.com>
# ------------------------ >8 ------------------------
diff --git a/a.ts b/a.ts
+added
`,
    expect: [
      ["feat", "keyword"],
      ["(parser)", "type"],
      ["!:", "operator"],
      ["support SQL", "heading"],
      ["Explain", null],
      ["#42", "constant"],
      ["https://example.com/x", "link"],
      ["# Please", "comment"],
      ["Signed-off-by", "property"],
      ["Co-Authored-By", "property"],
      ["# -----", "comment"],
      ["diff --git", "function"],
      ["+added", "inserted"],
    ],
  },
  {
    language: "git-rebase",
    content: `pick 1a2b3c4 Add parser\nr 5d6e7f8 Fix typo\nexec bun test\n# Rebase 1a2b3c4..5d6e7f8 onto 0a0a0a0\n`,
    expect: [
      ["pick", "keyword"],
      ["1a2b3c4", "constant"],
      ["Add parser", null],
      ["r 5d", "keyword"],
      ["5d6e7f8", "constant"],
      ["exec", "keyword"],
      ["# Rebase", "comment"],
    ],
  },
  {
    language: "git-attributes",
    content: `# LFS\n*.png binary filter=lfs\n`,
    expect: [
      ["# LFS", "comment"],
      ["*", "operator"],
      ["binary", "attribute"],
    ],
  },
];

describe("tokenizer languages", () => {
  for (const testCase of TOKENIZER_CASES) {
    test(testCase.language, () => check(testCase));
  }
});

describe(".env files", () => {
  const content = `# Database settings
DATABASE_URL=postgres://user:pass@localhost:5432/app
DB_POOL=10
DEBUG=true
SECRET_KEY='s3cr3t $NOT_A_REF'
API_URL="https://api.example.com/v1"
export NODE_ENV=production   # trailing comment
GREETING="Hello \${USER}\\n"
PATH_EXT=$HOME/bin
EMPTY=
MULTI="line one
line two"
AFTER=1
`;

  test("keys, values, quoting, references and comments are colored", () =>
    check({
      language: "dotenv",
      content,
      expect: [
        ["# Database", "comment"],
        ["DATABASE_URL", "property"],
        ["=postgres", "operator"],
        ["postgres://", "string"],
        ["10", "number"],
        ["true", "constant"],
        ["SECRET_KEY", "property"],
        ["'s3cr3t", "string"],
        ["$NOT_A_REF", "string"],
        ['"https', "string"],
        ["export", "keyword"],
        ["NODE_ENV", "property"],
        ["production", "string"],
        ["# trailing", "comment"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal reference in the sample.
        ["${USER}", "property"],
        ["\\n", "regexp"],
        ["$HOME", "property"],
        ["/bin", "string"],
        ["EMPTY", "property"],
        ["line two", "string"],
        ["AFTER", "property"],
      ],
    }));

  test("every non-blank line has a colored key and value (the reported bug)", async () => {
    const lines = tokenizeLines(content, await service.highlight(content, "dotenv"));
    content.split("\n").forEach((line, row) => {
      if (!/^[A-Z_]+=./.test(line)) return;
      const groups = new Set((lines[row] ?? []).map((t) => t.group));
      expect(`${line} ${groups.has("property")}`).toBe(`${line} true`);
      expect((lines[row] ?? []).some((t) => t.start > line.indexOf("="))).toBe(true);
    });
  });

  test("detected for every common .env name", () => {
    for (const name of [".env", ".env.example", ".env.local", ".env.production", "prod.env", ".env.sample"]) {
      expect(`${name} ${service.filetypeFor(name)}`).toBe(`${name} dotenv`);
    }
  });
});

describe("files nobody recognizes", () => {
  const prose = `Release notes for version 2.4.1, see https://example.com/notes.
The "quick" fix landed on 2024-05-01; it's 3x faster and doesn't break users' files.
Rock 'n' roll, 'quoted text' and a stray ' quote. Call 555 or build v2.
`;

  test("only URLs, quoted strings and standalone numbers are colored", () =>
    check({
      language: "unknown",
      content: prose,
      expect: [
        ["Release", null],
        ["2.4.1", "number"],
        ["https://example.com/notes", "link"],
        ['"quick"', "string"],
        ["2024", "number"],
        ["it's", null],
        ["s 3x", null],
        ["3x", null],
        ["doesn't", null],
        ["users'", null],
        ["'quoted text'", "string"],
        ["' quote", null],
        ["555", "number"],
        ["v2", null],
      ],
    }));

  test("plain prose stays entirely plain", async () => {
    const text = "It's a long story, and we don't know where the users' notes went.\nNothing to see here.\n";
    expect(await service.highlight(text, "unknown")).toEqual([]);
  });

  test("declared plain text (.txt) stays plain", async () => {
    expect(service.filetypeFor("notes.txt")).toBeUndefined();
    expect(await service.highlight('say "hi" 42', "plaintext")).toEqual([]);
  });
});

describe("offsets with Turkish text and emoji", () => {
  test("SQL", () =>
    check({
      language: "sql",
      content: "SELECT ad, şehir FROM kullanıcılar WHERE ad = 'Çağrı 😀' -- yorum ğ\n",
      expect: [
        ["şehir", null],
        ["kullanıcılar", "type"],
        ["'Çağrı 😀'", "string"],
        ["-- yorum ğ", "comment"],
      ],
    }));

  test("exact UTF-16 columns for a Kotlin string, a .env value and unknown text", async () => {
    const kotlin = 'val şehir = "İstanbul 😀" // yorum\n';
    const kt = tokenizeLines(kotlin, await service.highlight(kotlin, "kotlin"));
    expect(kt[0]?.find((t) => t.group === "string")).toEqual({ start: 12, end: 25, group: "string" });
    expect(kt[0]?.find((t) => t.group === "comment")).toEqual({ start: 26, end: 34, group: "comment" });
    const env = 'CITY="İstanbul 😀" # yorum ğ\n';
    const ev = tokenizeLines(env, await service.highlight(env, "dotenv"));
    expect(probe(env, ev, '"İstanbul')).toMatchObject({ token: "string", text: '"İstanbul 😀"' });
    expect(probe(env, ev, "# yorum")).toMatchObject({ token: "comment", text: "# yorum ğ" });
    const text = '"Merhaba dünya 😀" ve 42';
    const tx = tokenizeLines(text, await service.highlight(text, "unknown"));
    expect(probe(text, tx, '"Merhaba')).toMatchObject({ token: "string", text: '"Merhaba dünya 😀"' });
    expect(probe(text, tx, "42")).toMatchObject({ token: "number", text: "42" });
  });
});

describe("composite files (HTML grammar plus embedded blocks)", () => {
  test("Vue single-file component", () =>
    check({
      language: "vue",
      content: `<template>
  <div :class="{ active }" @click="toggle">{{ count }}</div>
</template>
<script setup lang="ts">
import { ref } from "vue";
const count = ref<number>(0);
</script>
<style scoped lang="scss">
.active { color: red; }
</style>
`,
      expect: [
        ["template", "tag"],
        ["div", "tag"],
        [":class", "attribute"],
        ["{{", "punctuation"],
        ["import", "keyword"],
        ['"vue"', "string"],
        ["const", "keyword"],
        ["number", "type"],
        ["active {", "type"],
        ["color", "property"],
      ],
    }));

  test("Svelte component", () =>
    check({
      language: "svelte",
      content: `<script>
  export let name = "world";
</script>
{#if name}
  <h1>Hello {name}!</h1>
{:else}
  <button>Start</button>
{/if}
<style>h1 { color: purple; }</style>
`,
      expect: [
        ["export", "keyword"],
        ['"world"', "string"],
        ["{#if", "keyword"],
        ["h1", "tag"],
        ["{:else", "keyword"],
        ["button", "tag"],
        ["{/if", "keyword"],
        ["color", "property"],
      ],
    }));

  test("HTML colors <script> and <style>, JSON scripts, and leaves templates alone", () =>
    check({
      language: "html",
      content: `<!DOCTYPE html>
<html>
<head><style>body { margin: 0; }</style></head>
<body>
<script type="module">const x = 1; // js</script>
<script type="application/json">{"key": true}</script>
<script type="text/x-template"><div>raw</div></script>
</body>
</html>
`,
      expect: [
        ["margin", "property"],
        ["const", "keyword"],
        ["// js", "comment"],
        ['"key"', "property"],
        ["true}", "constant"],
        ["body>", "tag"],
        ["<div>raw", null],
      ],
    }));

  test("PHP template: HTML outside, PHP inside the tags", () =>
    check({
      language: "php",
      content: `<?php
declare(strict_types=1);
namespace App;
#[Route('/home')]
final class Home extends Controller {
    public function index(int $id): string {
        $name = "User {$id} $id";
        return $this->render('home', ['id' => $id]); // ok
    }
}
?>
<div class="x"><?= $name ?></div>
`,
      expect: [
        ["<?php", "keyword"],
        ["declare", "keyword"],
        ["namespace", "keyword"],
        ["#[Route", "attribute"],
        ["final", "keyword"],
        ["class", "keyword"],
        ["Home", "type"],
        ["Controller", "type"],
        ["function", "keyword"],
        ["index", "function"],
        ["int", "type"],
        ["$id", "variable"],
        ['"User', "string"],
        ["$this", "variable"],
        ["render", "function"],
        ["// ok", "comment"],
        ["div", "tag"],
        ["class", "attribute", 1],
        ["<?=", "keyword"],
      ],
    }));
});

describe("tokenizer timings", () => {
  test("5,000-line SQL and C files", () => {
    const sql = Array.from(
      { length: 5000 },
      (_, i) =>
        [
          `-- report ${i}`,
          `SELECT u.id, u.name, COUNT(o.id) AS orders_${i} FROM users u LEFT JOIN orders o ON o.user_id = u.id`,
          `WHERE u.created_at > NOW() - INTERVAL '${i} days' AND u.status = 'active' AND u.score >= ${i}.5`,
          `GROUP BY u.id, u.name HAVING COUNT(*) > ${i % 7} ORDER BY orders_${i} DESC LIMIT 10;`,
        ][i % 4],
    ).join("\n");
    const c = Array.from(
      { length: 5000 },
      (_, i) =>
        [
          `/* block ${i} */ static int compute_${i}(int value, const char *label) {`,
          `    int doubled = value * 2 + ${i}; // double it`,
          `    printf("%s: %d\\n", label, doubled > MAX_${i % 9} ? doubled : 0x${i.toString(16)});`,
          "    return doubled;",
          "}",
        ][i % 5],
    ).join("\n");
    for (const [name, content, filetype] of [
      ["SQL", sql, "sql"],
      ["C", c, "c"],
    ] as const) {
      const tokenizer = fallbackTokenizerFor(filetype);
      if (!tokenizer) throw new Error(filetype);
      tokenizer.tokenize(content.slice(0, 2000)); // compile the spec outside the measurement
      const t0 = performance.now();
      const ranges = tokenizer.tokenize(content);
      const t1 = performance.now();
      const lines = tokenizeLines(content, ranges);
      const t2 = performance.now();
      console.log(
        `[timing] ${name} 5,000 lines (${(content.length / 1024).toFixed(0)} KiB, ${ranges.length} ranges): ` +
          `tokenize ${(t1 - t0).toFixed(1)} ms; tokenizeLines ${(t2 - t1).toFixed(1)} ms`,
      );
      expect(lines.length).toBe(5000);
      expect(ranges.length).toBeGreaterThan(20_000);
      expect(t1 - t0).toBeLessThan(60);
    }
  });
});
