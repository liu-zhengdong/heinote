import { escapeHtml } from "../../core/inline-content";

/* Code blocks, coloured by language, as Notion colours them.

   The grammars are a chunk of their own, fetched the first time a page draws
   a code block: most pages have none, and the app should not open slower for
   them. Until it arrives a block shows its code uncoloured; then every code
   block on screen is told once, and colours itself. */

export interface CodeLanguage {
  /** What a block stores. The first twelve are what Notes has always stored. */
  id: string;
  label: string;
  /** The highlight.js grammar, when there is one. */
  grammar?: string;
}

export const PLAIN_TEXT = "plain text";

export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  { id: PLAIN_TEXT, label: "Plain text" },
  { id: "bash", label: "Bash", grammar: "bash" },
  { id: "c", label: "C", grammar: "c" },
  { id: "cpp", label: "C++", grammar: "cpp" },
  { id: "csharp", label: "C#", grammar: "csharp" },
  { id: "css", label: "CSS", grammar: "css" },
  { id: "diff", label: "Diff", grammar: "diff" },
  { id: "go", label: "Go", grammar: "go" },
  { id: "html", label: "HTML", grammar: "xml" },
  { id: "java", label: "Java", grammar: "java" },
  { id: "javascript", label: "JavaScript", grammar: "javascript" },
  { id: "json", label: "JSON", grammar: "json" },
  { id: "kotlin", label: "Kotlin", grammar: "kotlin" },
  { id: "markdown", label: "Markdown", grammar: "markdown" },
  { id: "php", label: "PHP", grammar: "php" },
  { id: "python", label: "Python", grammar: "python" },
  { id: "ruby", label: "Ruby", grammar: "ruby" },
  { id: "rust", label: "Rust", grammar: "rust" },
  { id: "sql", label: "SQL", grammar: "sql" },
  { id: "swift", label: "Swift", grammar: "swift" },
  { id: "typescript", label: "TypeScript", grammar: "typescript" },
  { id: "xml", label: "XML", grammar: "xml" },
  { id: "yaml", label: "YAML", grammar: "yaml" },
];

const BY_ID = new Map(CODE_LANGUAGES.map((language) => [language.id, language]));

/* What a Markdown fence or a pasted block may call a language. */
const ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript",
  py: "python", python3: "python",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  rs: "rust", golang: "go", rb: "ruby", kt: "kotlin", cs: "csharp", "c#": "csharp",
  "c++": "cpp", cc: "cpp", hpp: "cpp", h: "c",
  yml: "yaml", md: "markdown", htm: "html", svg: "xml", patch: "diff",
  text: PLAIN_TEXT, txt: PLAIN_TEXT, plain: PLAIN_TEXT, plaintext: PLAIN_TEXT,
};

/** The language a block's stored value names — "js" and "JavaScript" alike
 *  are JavaScript — or plain text for anything unknown. */
export function codeLanguage(value: string | undefined): CodeLanguage {
  const key = (value ?? "").trim().toLowerCase();
  return BY_ID.get(key) ?? BY_ID.get(ALIASES[key] ?? "") ?? BY_ID.get(PLAIN_TEXT)!;
}

/* A new code block starts in the language the last one was set to, as in
   Notion — whoever writes Python writes it block after block. */
const LAST_LANGUAGE_KEY = "notes.code-language";

export function lastCodeLanguage(): string {
  try {
    return codeLanguage(window.localStorage.getItem(LAST_LANGUAGE_KEY) ?? undefined).id;
  } catch {
    return PLAIN_TEXT;
  }
}

export function rememberCodeLanguage(id: string): void {
  try {
    window.localStorage.setItem(LAST_LANGUAGE_KEY, codeLanguage(id).id);
  } catch {
    // Not remembered: the next block starts as plain text.
  }
}

type Highlight = (code: string, grammar: string) => string;

let highlight: Highlight | null = null;
let loading: Promise<void> | null = null;
const waiting = new Set<() => void>();

/** Fetches the grammars once; `ready` runs when they arrive. Returns a way to
 *  stop waiting, for a block that goes away first. */
export function whenHighlighterReady(ready: () => void): () => void {
  if (highlight) return () => undefined;
  waiting.add(ready);
  loading ??= import("./code-grammars")
    .then((module) => {
      highlight = module.highlight;
      const told = [...waiting];
      waiting.clear();
      for (const tell of told) tell();
    })
    .catch(() => {
      // Offline, or the chunk is gone after a deploy: code stays uncoloured,
      // and the next code block drawn tries again.
      loading = null;
    });
  return () => waiting.delete(ready);
}

export function highlighterReady(): boolean {
  return highlight !== null;
}

/** A code block's HTML. The text is exactly the block's — newlines are real
 *  newline characters, never `<br>` — so a caret offset counts the same in the
 *  model and in the DOM. A final newline gets a `<br>` after it, which no text
 *  offset sees, so the empty last line it starts is drawn and can take the
 *  caret. */
export function codeHtml(code: string, language: string | undefined): string {
  if (!code) return "";
  const grammar = codeLanguage(language).grammar;
  let html: string;
  try {
    html = grammar && highlight ? highlight(code, grammar) : escapeHtml(code);
  } catch {
    html = escapeHtml(code);
  }
  return code.endsWith("\n") ? `${html}<br>` : html;
}
