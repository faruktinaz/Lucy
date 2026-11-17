/**
 * Language registry and detection.
 *
 * Pure data plus lookups: no filesystem access, no OpenTUI imports. `filetype` is the name the
 * highlighter understands (a Tree-sitter filetype registered on Lucy's client, an OpenTUI bundled
 * one, or a fallback tokenizer); `undefined` means the language is recognised for the status bar
 * but rendered as plain text.
 */

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "jsonc"
  | "json5"
  | "yaml"
  | "toml"
  | "markdown"
  | "mdx"
  | "python"
  | "starlark"
  | "go"
  | "go-module"
  | "go-sum"
  | "shell"
  | "dotenv"
  | "rust"
  | "css"
  | "scss"
  | "less"
  | "html"
  | "xml"
  | "dockerfile"
  | "makefile"
  | "ini"
  | "properties"
  | "git-config"
  | "editorconfig"
  | "ignore"
  | "git-attributes"
  | "diff"
  | "sql"
  | "c"
  | "cpp"
  | "objective-c"
  | "objective-cpp"
  | "csharp"
  | "java"
  | "kotlin"
  | "swift"
  | "dart"
  | "scala"
  | "groovy"
  | "ruby"
  | "php"
  | "lua"
  | "perl"
  | "r"
  | "elixir"
  | "haskell"
  | "powershell"
  | "graphql"
  | "protobuf"
  | "terraform"
  | "hcl"
  | "nginx"
  | "vue"
  | "svelte"
  | "zig"
  | "csv"
  | "tsv"
  | "log"
  | "git-commit"
  | "git-rebase"
  | "plaintext"
  | "unknown";

export interface LanguageInfo {
  readonly id: LanguageId;
  /** Human name for the status bar, following VS Code's wording where one exists. */
  readonly displayName: string;
  /** Lowercase, without the dot. Matched against the last extension of the file name. */
  readonly extensions: readonly string[];
  /** Exact, case-sensitive base names (`Makefile` and `makefile` are listed separately). */
  readonly fileNames: readonly string[];
  /** Matched against the base name, for families such as `.env.local` or `Dockerfile.dev`. */
  readonly fileNamePatterns: readonly RegExp[];
  /** Matched against the whole path with forward slashes, for files known by location. */
  readonly pathPatterns: readonly RegExp[];
  /** Interpreter names accepted in a shebang line, version suffixes stripped (`python3.12` → `python`). */
  readonly interpreters: readonly string[];
  /** Highlighter filetype, or `undefined` for plain text. */
  readonly filetype: string | undefined;
}

type LanguageSpec = Partial<Omit<LanguageInfo, "id" | "displayName" | "filetype">> &
  Pick<LanguageInfo, "id" | "displayName" | "filetype">;

function define(spec: LanguageSpec): LanguageInfo {
  return Object.freeze({
    extensions: [],
    fileNames: [],
    fileNamePatterns: [],
    pathPatterns: [],
    interpreters: [],
    ...spec,
  });
}

/**
 * Files that are plain text by declaration (`.txt`). Not highlighted: the author said so.
 */
export const PLAIN_TEXT: LanguageInfo = define({
  id: "plaintext",
  displayName: "Plain Text",
  filetype: undefined,
  extensions: ["txt", "text"],
});

/**
 * Files nobody recognizes. Shown as plain text in the status bar, but colored by the
 * conservative fallback (URLs, quoted strings, numbers), which is designed to be safe on prose.
 */
export const UNKNOWN_TEXT: LanguageInfo = define({
  id: "unknown",
  displayName: "Plain Text",
  filetype: "fallback-text",
});

/**
 * Every language Lucy recognises. Order matters only for ambiguous entries: the first language
 * that claims an extension or file name wins.
 */
export const LANGUAGES: readonly LanguageInfo[] = Object.freeze([
  define({
    id: "typescript",
    displayName: "TypeScript",
    filetype: "typescript",
    extensions: ["ts", "mts", "cts"],
    // Bun and Deno run TypeScript directly; the TypeScript grammar also parses plain JavaScript.
    interpreters: ["bun", "deno", "ts-node", "tsx"],
  }),
  define({ id: "tsx", displayName: "TypeScript JSX", filetype: "typescriptreact", extensions: ["tsx"] }),
  define({
    id: "javascript",
    displayName: "JavaScript",
    filetype: "javascript",
    extensions: ["js", "mjs", "cjs"],
    interpreters: ["node", "nodejs"],
  }),
  define({ id: "jsx", displayName: "JavaScript JSX", filetype: "javascriptreact", extensions: ["jsx"] }),
  define({
    id: "jsonc",
    displayName: "JSON with Comments",
    filetype: "jsonc",
    extensions: ["jsonc"],
    fileNames: [
      "tsconfig.json",
      "jsconfig.json",
      "bun.lock",
      "devcontainer.json",
      ".devcontainer.json",
      "deno.json",
      "turbo.json",
      ".eslintrc",
      ".eslintrc.json",
      ".jshintrc",
    ],
    fileNamePatterns: [/^tsconfig\..+\.json$/, /^jsconfig\..+\.json$/],
    pathPatterns: [/(^|\/)\.vscode\/[^/]+\.json$/],
  }),
  define({
    id: "json",
    displayName: "JSON",
    filetype: "json",
    extensions: ["json", "jsonl", "ndjson", "webmanifest", "geojson", "har", "topojson"],
    fileNames: [
      ".babelrc",
      ".prettierrc",
      ".swcrc",
      ".nycrc",
      ".stylelintrc",
      ".lintstagedrc",
      ".releaserc",
      ".watchmanconfig",
      "composer.lock",
      "Pipfile.lock",
      "flake.lock",
    ],
  }),
  define({ id: "json5", displayName: "JSON5", filetype: "json5", extensions: ["json5"] }),
  define({
    id: "yaml",
    displayName: "YAML",
    filetype: "yaml",
    extensions: ["yaml", "yml", "cff"],
    fileNames: [".clang-format", ".clang-tidy", ".clangd", ".yamllint", ".condarc"],
  }),
  define({
    id: "toml",
    displayName: "TOML",
    filetype: "toml",
    extensions: ["toml"],
    fileNames: ["Cargo.lock", "Pipfile", "poetry.lock", "uv.lock", "pdm.lock", "Gopkg.lock"],
  }),
  define({
    id: "markdown",
    displayName: "Markdown",
    filetype: "markdown",
    extensions: ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"],
  }),
  define({ id: "mdx", displayName: "MDX", filetype: "markdown", extensions: ["mdx"] }),
  define({
    id: "python",
    displayName: "Python",
    filetype: "python",
    extensions: ["py", "pyi", "pyw", "gyp", "gypi"],
    fileNames: ["SConstruct", "SConscript", "wscript", ".pythonrc", ".pythonstartup"],
    interpreters: ["python", "pypy"],
  }),
  define({
    id: "starlark",
    displayName: "Starlark",
    // Starlark is a Python dialect; the Python grammar parses it.
    filetype: "python",
    extensions: ["bzl", "star", "bazel"],
    fileNames: ["BUILD", "WORKSPACE", "Tiltfile"],
  }),
  define({ id: "go", displayName: "Go", filetype: "go", extensions: ["go"] }),
  define({
    id: "go-module",
    displayName: "Go Module File",
    filetype: "gomod",
    fileNames: ["go.mod", "go.work"],
  }),
  define({
    id: "go-sum",
    displayName: "Go Checksum File",
    filetype: "fallback-text",
    fileNames: ["go.sum", "go.work.sum"],
  }),
  define({
    id: "shell",
    displayName: "Shell Script",
    filetype: "bash",
    extensions: ["sh", "bash", "zsh", "ksh", "command"],
    fileNames: [
      ".bashrc",
      ".bash_profile",
      ".bash_login",
      ".bash_logout",
      ".bash_aliases",
      ".profile",
      ".zshrc",
      ".zshenv",
      ".zprofile",
      ".zlogin",
      ".zlogout",
      ".kshrc",
      ".envrc",
      ".xinitrc",
      ".xprofile",
      "bashrc",
      "zshrc",
      "PKGBUILD",
      "APKBUILD",
    ],
    interpreters: ["sh", "bash", "zsh", "ksh", "dash", "ash", "mksh"],
  }),
  define({
    id: "dotenv",
    displayName: "Dotenv",
    // A dedicated tokenizer: the Bash grammar leaves keys and unquoted values uncolored.
    filetype: "dotenv",
    extensions: ["env"],
    fileNames: [".env"],
    fileNamePatterns: [/^\.env[._-].+$/, /^[\w.-]+\.env\.[\w-]+$/],
  }),
  define({ id: "rust", displayName: "Rust", filetype: "rust", extensions: ["rs"] }),
  define({ id: "css", displayName: "CSS", filetype: "css", extensions: ["css", "pcss", "postcss"] }),
  // Best effort: the CSS grammar covers the CSS-compatible part of SCSS and Less.
  define({ id: "scss", displayName: "SCSS", filetype: "css", extensions: ["scss"] }),
  define({ id: "less", displayName: "Less", filetype: "css", extensions: ["less"] }),
  define({
    id: "html",
    displayName: "HTML",
    filetype: "html",
    extensions: ["html", "htm", "xhtml", "shtml"],
  }),
  define({
    id: "xml",
    displayName: "XML",
    // A markup tokenizer: the HTML grammar misses declarations, CDATA and namespaced names.
    filetype: "xml",
    extensions: [
      "xml",
      "svg",
      "plist",
      "xsd",
      "xsl",
      "xslt",
      "rss",
      "atom",
      "csproj",
      "fsproj",
      "vbproj",
      "props",
      "targets",
      "xaml",
      "storyboard",
      "xib",
    ],
  }),
  define({
    id: "dockerfile",
    displayName: "Dockerfile",
    filetype: "dockerfile",
    extensions: ["dockerfile", "containerfile"],
    fileNames: ["Dockerfile", "dockerfile", "Containerfile", "containerfile"],
    fileNamePatterns: [/^(Dockerfile|dockerfile|Containerfile)\..+$/],
  }),
  define({
    id: "makefile",
    displayName: "Makefile",
    filetype: "make",
    extensions: ["mk", "mak"],
    fileNames: ["Makefile", "makefile", "GNUmakefile", "BSDmakefile", "Kbuild"],
    interpreters: ["make"],
  }),
  define({
    id: "ini",
    displayName: "INI",
    filetype: "ini",
    // Also systemd units and desktop entries, which are INI files.
    extensions: [
      "ini",
      "cfg",
      "conf",
      "service",
      "socket",
      "timer",
      "mount",
      "automount",
      "slice",
      "desktop",
    ],
    fileNames: [".npmrc", ".pypirc", ".flake8", ".pylintrc", ".coveragerc", ".yarnrc"],
  }),
  define({ id: "properties", displayName: "Properties", filetype: "ini", extensions: ["properties"] }),
  define({
    id: "git-config",
    displayName: "Git Config",
    filetype: "ini",
    fileNames: [".gitconfig", ".gitmodules"],
    pathPatterns: [/(^|\/)\.git\/config$/],
  }),
  define({ id: "editorconfig", displayName: "EditorConfig", filetype: "ini", fileNames: [".editorconfig"] }),
  define({
    id: "ignore",
    displayName: "Ignore",
    filetype: "gitignore",
    fileNames: [
      ".gitignore",
      ".dockerignore",
      ".npmignore",
      ".prettierignore",
      ".eslintignore",
      ".stylelintignore",
      ".vscodeignore",
      ".gcloudignore",
      ".ignore",
      ".rgignore",
      ".fdignore",
      ".hgignore",
    ],
    pathPatterns: [/(^|\/)\.git\/info\/exclude$/],
  }),
  define({
    id: "git-attributes",
    displayName: "Git Attributes",
    filetype: "gitignore",
    fileNames: [".gitattributes"],
  }),
  define({ id: "diff", displayName: "Diff", filetype: "diff", extensions: ["diff", "patch", "rej"] }),
  define({
    id: "sql",
    displayName: "SQL",
    filetype: "sql",
    extensions: ["sql", "psql", "pgsql", "mysql", "ddl", "dml", "hql", "cql"],
  }),
  define({ id: "c", displayName: "C", filetype: "c", extensions: ["c", "h"] }),
  define({
    id: "cpp",
    displayName: "C++",
    filetype: "cpp",
    extensions: [
      "cpp",
      "cc",
      "cxx",
      "c++",
      "hpp",
      "hh",
      "hxx",
      "h++",
      "ipp",
      "tpp",
      "inl",
      "ino",
      "cu",
      "cuh",
    ],
  }),
  define({ id: "objective-c", displayName: "Objective-C", filetype: "objc", extensions: ["m"] }),
  define({ id: "objective-cpp", displayName: "Objective-C++", filetype: "objc", extensions: ["mm"] }),
  define({ id: "csharp", displayName: "C#", filetype: "csharp", extensions: ["cs", "csx", "cake"] }),
  define({ id: "java", displayName: "Java", filetype: "java", extensions: ["java", "jav"] }),
  define({
    id: "kotlin",
    displayName: "Kotlin",
    filetype: "kotlin",
    extensions: ["kt", "kts", "ktm"],
    interpreters: ["kotlin", "kotlinc"],
  }),
  define({
    id: "swift",
    displayName: "Swift",
    filetype: "swift",
    extensions: ["swift"],
    interpreters: ["swift"],
  }),
  define({ id: "dart", displayName: "Dart", filetype: "dart", extensions: ["dart"], interpreters: ["dart"] }),
  define({
    id: "scala",
    displayName: "Scala",
    filetype: "scala",
    extensions: ["scala", "sc", "sbt"],
    interpreters: ["scala", "amm"],
  }),
  define({
    id: "groovy",
    displayName: "Groovy",
    filetype: "groovy",
    extensions: ["groovy", "gvy", "gy", "gradle"],
    fileNames: ["Jenkinsfile"],
    fileNamePatterns: [/^Jenkinsfile\..+$/],
    interpreters: ["groovy"],
  }),
  define({
    id: "ruby",
    displayName: "Ruby",
    filetype: "ruby",
    extensions: ["rb", "rake", "gemspec", "ru", "rbw", "podspec", "thor", "jbuilder"],
    fileNames: [
      "Gemfile",
      "Rakefile",
      "Guardfile",
      "Podfile",
      "Vagrantfile",
      "Brewfile",
      "Fastfile",
      "Appfile",
      "Capfile",
      "Berksfile",
      "Thorfile",
      "Dangerfile",
      ".irbrc",
      ".pryrc",
      ".gemrc",
    ],
    interpreters: ["ruby", "jruby", "macruby", "rake"],
  }),
  define({
    id: "php",
    displayName: "PHP",
    filetype: "php",
    extensions: ["php", "phtml", "php3", "php4", "php5", "php7", "php8", "phps"],
    interpreters: ["php"],
  }),
  define({
    id: "lua",
    displayName: "Lua",
    filetype: "lua",
    extensions: ["lua", "rockspec"],
    fileNames: [".luacheckrc", ".luarc"],
    interpreters: ["lua", "luajit"],
  }),
  define({
    id: "perl",
    displayName: "Perl",
    filetype: "perl",
    extensions: ["pl", "pm", "pod", "t", "psgi"],
    interpreters: ["perl"],
  }),
  define({
    id: "r",
    displayName: "R",
    filetype: "r",
    extensions: ["r", "rprofile"],
    fileNames: [".Rprofile", ".Renviron"],
    interpreters: ["Rscript", "R"],
  }),
  define({
    id: "elixir",
    displayName: "Elixir",
    filetype: "elixir",
    extensions: ["ex", "exs"],
    fileNames: ["mix.lock"],
    interpreters: ["elixir", "iex"],
  }),
  define({
    id: "haskell",
    displayName: "Haskell",
    filetype: "haskell",
    extensions: ["hs", "lhs", "hs-boot"],
    interpreters: ["runhaskell", "runghc", "stack"],
  }),
  define({
    id: "powershell",
    displayName: "PowerShell",
    filetype: "powershell",
    extensions: ["ps1", "psm1", "psd1", "pssc", "ps1xml"],
    interpreters: ["pwsh", "powershell"],
  }),
  define({
    id: "graphql",
    displayName: "GraphQL",
    filetype: "graphql",
    extensions: ["graphql", "gql", "graphqls"],
  }),
  define({ id: "protobuf", displayName: "Protocol Buffers", filetype: "proto", extensions: ["proto"] }),
  define({ id: "terraform", displayName: "Terraform", filetype: "hcl", extensions: ["tf", "tfvars"] }),
  define({
    id: "hcl",
    displayName: "HCL",
    filetype: "hcl",
    extensions: ["hcl", "nomad", "tfbackend"],
    fileNames: [".terraformrc", "terraform.rc"],
  }),
  define({
    id: "nginx",
    displayName: "Nginx",
    filetype: "nginx",
    extensions: ["nginx", "nginxconf"],
    fileNames: ["nginx.conf", "mime.types", "fastcgi_params", "uwsgi_params", "scgi_params", "proxy_params"],
    fileNamePatterns: [/^nginx.*\.conf$/],
    pathPatterns: [/(^|\/)nginx\/.+\.conf$/, /(^|\/)nginx\/(sites|conf)-(available|enabled)\/[^/]+$/],
  }),
  define({ id: "vue", displayName: "Vue", filetype: "vue", extensions: ["vue"] }),
  define({ id: "svelte", displayName: "Svelte", filetype: "svelte", extensions: ["svelte"] }),
  define({ id: "zig", displayName: "Zig", filetype: "zig", extensions: ["zig", "zon"] }),
  define({ id: "csv", displayName: "CSV", filetype: "csv", extensions: ["csv"] }),
  define({ id: "tsv", displayName: "TSV", filetype: "tsv", extensions: ["tsv", "tab"] }),
  define({
    id: "log",
    displayName: "Log",
    filetype: "log",
    extensions: ["log"],
    fileNamePatterns: [/\.log\.\d+$/, /\.(?:out|err)\.log$/],
  }),
  define({
    id: "git-commit",
    displayName: "Git Commit Message",
    filetype: "gitcommit",
    fileNames: ["COMMIT_EDITMSG", "MERGE_MSG", "TAG_EDITMSG", "SQUASH_MSG", "EDIT_DESCRIPTION"],
  }),
  define({
    id: "git-rebase",
    displayName: "Git Rebase",
    filetype: "gitrebase",
    fileNames: ["git-rebase-todo"],
  }),
  PLAIN_TEXT,
  UNKNOWN_TEXT,
]);

interface LanguageIndex {
  byId: Map<string, LanguageInfo>;
  byExtension: Map<string, LanguageInfo>;
  byFileName: Map<string, LanguageInfo>;
  byInterpreter: Map<string, LanguageInfo>;
}

let index: LanguageIndex | undefined;

/** Built on first lookup so importing the module does no work. */
function getIndex(): LanguageIndex {
  if (index) return index;
  const built: LanguageIndex = {
    byId: new Map(),
    byExtension: new Map(),
    byFileName: new Map(),
    byInterpreter: new Map(),
  };
  const claim = (map: Map<string, LanguageInfo>, key: string, language: LanguageInfo): void => {
    if (!map.has(key)) map.set(key, language);
  };
  for (const language of LANGUAGES) {
    claim(built.byId, language.id, language);
    for (const ext of language.extensions) claim(built.byExtension, ext, language);
    for (const name of language.fileNames) claim(built.byFileName, name, language);
    for (const name of language.interpreters) claim(built.byInterpreter, name, language);
  }
  index = built;
  return built;
}

export function languageById(id: string): LanguageInfo | undefined {
  return getIndex().byId.get(id);
}

/**
 * Extracts the interpreter from a shebang line: `#!/usr/bin/env -S python3.12 -u` → `python`.
 * Version suffixes are stripped so one entry covers `python3`, `python3.12` and `pypy3`.
 */
export function interpreterFromShebang(firstLine: string): string | undefined {
  if (!firstLine.startsWith("#!")) return undefined;
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  let program = words.shift();
  if (program === undefined) return undefined;
  if (basename(program) === "env") {
    // `env` takes flags (`-S`, `-i`, `-u NAME`) and VAR=value assignments before the program.
    while (words.length > 0) {
      const word = words[0] ?? "";
      if (word === "-u" || word === "--unset") {
        words.splice(0, 2);
      } else if (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        words.shift();
      } else {
        break;
      }
    }
    program = words.shift();
    if (program === undefined) return undefined;
  }
  const name = basename(program).replace(/[\d.]+$/, "");
  return name.length > 0 ? name : undefined;
}

function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/**
 * Detects the language of a file from its path and, for extension-less scripts, its first line.
 * Order: location (`.vscode/*.json`), exact file name, file name family, extension, shebang.
 * Never throws; unknown files get `UNKNOWN_TEXT`.
 */
export function detectLanguage(path: string, firstLine?: string): LanguageInfo {
  const { byExtension, byFileName, byInterpreter } = getIndex();
  const normalized = path.replaceAll("\\", "/");
  const name = basename(normalized);

  for (const language of LANGUAGES) {
    if (language.pathPatterns.some((pattern) => pattern.test(normalized))) return language;
  }
  const named = byFileName.get(name);
  if (named) return named;
  for (const language of LANGUAGES) {
    if (language.fileNamePatterns.some((pattern) => pattern.test(name))) return language;
  }

  const dot = name.lastIndexOf(".");
  // A leading dot marks a hidden file (`.foo`), not an extension.
  if (dot > 0 && dot < name.length - 1) {
    const language = byExtension.get(name.slice(dot + 1).toLowerCase());
    if (language) return language;
  }

  if (firstLine !== undefined) {
    const interpreter = interpreterFromShebang(firstLine);
    const language = interpreter === undefined ? undefined : byInterpreter.get(interpreter);
    if (language) return language;
  }
  return UNKNOWN_TEXT;
}
