import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  truncateHead,
  highlightCode,
  getLanguageFromPath,
  createReadTool,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  matchesKey,
  Key,
  decodeKittyPrintable,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────
// Mentor Mode Types & Constants
// ─────────────────────────────────────────────────────────

type Mode = "learn" | "search" | "index" | "unstuck" | "do";

interface MentorState {
  enabled: boolean;
  mode: Mode;
  lastIndexedAt: string | undefined;
  fileHashes: Record<string, string>;
}

const STATE_TYPE = "mentor-mode-state";
const MODE_TEXT: Record<Mode, { icon: string; desc: string }> = {
  learn: { icon: "🎓", desc: "Guide in small steps; user writes most code." },
  search: { icon: "🔍", desc: "Research with web_search and apply findings." },
  index: { icon: "🗂️", desc: "Build/update .pi/wiki knowledge base." },
  unstuck: { icon: "🧭", desc: "Diagnose blockers and give targeted hints." },
  do: { icon: "🛠️", desc: "Directly implement requested changes." },
};

function slugify(input: string) {
  return input.replace(/[^a-zA-Z0-9]+/g, "-").replace(/(^-|-$)/g, "").toLowerCase() || "root";
}

async function safeRead(p: string) {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "";
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEARCH_SCRIPT = path.resolve(__dirname, "../../scripts/search.sh");
const GLOBAL_WIKI_ROOT = path.join(os.homedir(), ".pi", "wiki");

async function resolveProjectName(cwd: string, pi: ExtensionAPI): Promise<string> {
  const gitRoot = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  const root = (gitRoot.stdout || "").trim();
  if (gitRoot.code === 0 && root) return path.basename(root);
  return path.basename(cwd);
}

function buildCodePanel(
  code: string,
  filePath: string,
  theme: any,
  expanded: boolean,
  maxCollapsedLines: number = 12,
): Text {
  const language = getLanguageFromPath(filePath) ?? "text";
  const lines = code.split("\n");
  const gutterWidth = String(lines.length).length;
  const parts: string[] = [];

  parts.push(
    theme.fg("accent", theme.bold(filePath)) +
      " " +
      theme.fg("dim", `(${language}, ${lines.length} lines)`),
  );
  parts.push(theme.fg("borderMuted", "─".repeat(60)));

  const showLines = expanded ? lines : lines.slice(0, maxCollapsedLines);

  for (let i = 0; i < showLines.length; i++) {
    const num = String(i + 1).padStart(gutterWidth);
    const hl = highlightCode(showLines[i]!, language)[0] ?? "";
    parts.push(
      theme.fg("dim", num) +
        " " +
        theme.fg("borderMuted", "│") +
        " " +
        hl,
    );
  }

  parts.push(theme.fg("borderMuted", "─".repeat(60)));

  if (!expanded && lines.length > maxCollapsedLines) {
    const remaining = lines.length - maxCollapsedLines;
    parts.push(
      theme.fg("dim", `  … ${remaining} more lines `) +
        theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`),
    );
  } else {
    parts.push(
      theme.fg("muted", "  Ctrl+Shift+V to select lines for follow-up"),
    );
  }

  return new Text(parts.join("\n"), 0, 0);
}

class CodeViewerComponent implements Component {
  private lines: string[];
  private highlightedLines: string[];
  private fileName: string;
  private language: string;
  private cursorLine: number = 0;
  private anchorLine: number = 0;
  private scrollOffset: number = 0;
  private viewportHeight: number;
  private theme: any;
  private cachedWidth: number | undefined;
  private cachedOutput: string[] | undefined;

  public onSelect: ((selectedCode: string, startLine: number, endLine: number) => void) | undefined;
  public onCancel: (() => void) | undefined;

  constructor(code: string, fileName: string, language: string, theme: any, viewportHeight: number = 20) {
    this.lines = code.split("\n");
    this.fileName = fileName;
    this.language = language;
    this.theme = theme;
    this.viewportHeight = viewportHeight;
    this.highlightedLines = highlightCode(code, language);
  }

  handleInput(data: string): void {
    const prev = this.cursorLine;

    if (matchesKey(data, Key.up)) {
      if (this.cursorLine > 0) this.cursorLine--;
      this.anchorLine = this.cursorLine;
    } else if (matchesKey(data, Key.down)) {
      if (this.cursorLine < this.lines.length - 1) this.cursorLine++;
      this.anchorLine = this.cursorLine;
    } else if (matchesKey(data, Key.shift("up"))) {
      if (this.cursorLine > 0) this.cursorLine--;
    } else if (matchesKey(data, Key.shift("down"))) {
      if (this.cursorLine < this.lines.length - 1) this.cursorLine++;
    } else if (matchesKey(data, Key.home)) {
      this.cursorLine = 0;
      this.anchorLine = 0;
    } else if (matchesKey(data, Key.end)) {
      this.cursorLine = this.lines.length - 1;
      this.anchorLine = this.cursorLine;
    } else if (data === "\x1b[5~") {
      this.cursorLine = Math.max(0, this.cursorLine - Math.floor(this.viewportHeight / 2));
      this.anchorLine = this.cursorLine;
    } else if (data === "\x1b[6~") {
      this.cursorLine = Math.min(this.lines.length - 1, this.cursorLine + Math.floor(this.viewportHeight / 2));
      this.anchorLine = this.cursorLine;
    } else if (matchesKey(data, Key.enter)) {
      const s = Math.min(this.anchorLine, this.cursorLine);
      const e = Math.max(this.anchorLine, this.cursorLine);
      this.onSelect?.(this.lines.slice(s, e + 1).join("\n"), s + 1, e + 1);
      return;
    } else if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }

    if (prev !== this.cursorLine) {
      this.ensureVisible();
      this.invalidate();
    }
  }

  private ensureVisible(): void {
    if (this.cursorLine < this.scrollOffset) this.scrollOffset = this.cursorLine;
    else if (this.cursorLine >= this.scrollOffset + this.viewportHeight)
      this.scrollOffset = this.cursorLine - this.viewportHeight + 1;
  }

  setCursor(cursor: number, anchor?: number): void {
    this.cursorLine = Math.max(0, Math.min(cursor, this.lines.length - 1));
    this.anchorLine = anchor !== undefined
      ? Math.max(0, Math.min(anchor, this.lines.length - 1))
      : this.cursorLine;
    this.ensureVisible();
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedOutput && this.cachedWidth === width) return this.cachedOutput;

    this.ensureVisible();

    const gutterWidth = String(this.lines.length).length + 1;
    const codeWidth = width - gutterWidth - 3;
    const output: string[] = [];
    const selStart = Math.min(this.anchorLine, this.cursorLine);
    const selEnd = Math.max(this.anchorLine, this.cursorLine);

    output.push(truncateToWidth(
      ` ${this.theme.fg("accent", this.theme.bold(this.fileName))} ${this.theme.fg("dim", `(${this.language})`)}`,
      width,
    ));
    output.push(this.theme.fg("borderMuted", "─".repeat(width)));

    const visEnd = Math.min(this.scrollOffset + this.viewportHeight, this.lines.length);
    for (let i = this.scrollOffset; i < visEnd; i++) {
      const num = String(i + 1).padStart(gutterWidth);
      const inSel = i >= selStart && i <= selEnd;
      const isCur = i === this.cursorLine;

      const gutter = isCur
        ? this.theme.fg("accent", num)
        : inSel
          ? this.theme.fg("warning", num)
          : this.theme.fg("dim", num);

      const sep = this.theme.fg("borderMuted", "│");
      const code = truncateToWidth(this.highlightedLines[i] ?? "", codeWidth);

      const pfx = isCur && inSel && selStart !== selEnd
        ? this.theme.fg("accent", "▌")
        : isCur
          ? this.theme.fg("accent", "▸")
          : inSel
            ? this.theme.fg("warning", "▌")
            : " ";

      output.push(truncateToWidth(`${gutter} ${sep}${pfx}${code}`, width));
    }

    output.push(this.theme.fg("borderMuted", "─".repeat(width)));
    const selInfo = selStart !== selEnd
      ? this.theme.fg("warning", ` L${selStart + 1}-${selEnd + 1} selected`)
      : this.theme.fg("dim", ` L${this.cursorLine + 1}`);
    const scrollInfo = this.theme.fg("dim", `${this.scrollOffset + 1}-${visEnd}/${this.lines.length}`);
    const help = this.theme.fg("dim", "↑↓ move • Shift+↑↓ select • Enter confirm • Esc close");
    output.push(truncateToWidth(`${selInfo}  ${scrollInfo}  ${help}`, width));

    this.cachedWidth = width;
    this.cachedOutput = output;
    return output;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedOutput = undefined;
  }
}

class CodeEditorModal implements Component {
  private buffer: string[] = [""];
  private cursorRow: number = 0;
  private cursorCol: number = 0;
  private scrollOffset: number = 0;
  private viewportHeight: number;
  private language: string;
  private theme: any;
  private cachedWidth: number | undefined;
  private cachedOutput: string[] | undefined;

  public onSubmit: ((code: string, language: string) => void) | undefined;
  public onCancel: (() => void) | undefined;
  public onToggleFocus: (() => void) | undefined;

  constructor(theme: any, language: string, viewportHeight: number = 20, prefill?: string) {
    this.theme = theme;
    this.language = language;
    this.viewportHeight = viewportHeight;
    if (prefill) {
      this.buffer = prefill.split("\n");
      this.cursorRow = this.buffer.length - 1;
      this.cursorCol = this.buffer[this.cursorRow]!.length;
    }
  }

  private currentLine(): string {
    return this.buffer[this.cursorRow] ?? "";
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("enter"))) {
      this.onSubmit?.(this.buffer.join("\n"), this.language);
      return;
    }
    if (matchesKey(data, Key.ctrlShift("k"))) {
      this.onToggleFocus?.();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.onCancel?.();
      return;
    }
    if (matchesKey(data, Key.ctrl("l"))) {
      const langs = ["typescript", "javascript", "python", "rust", "go", "java", "c", "cpp", "ruby", "bash", "sql", "json", "yaml", "html", "css"];
      const idx = langs.indexOf(this.language);
      this.language = langs[(idx + 1) % langs.length]!;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const line = this.currentLine();
      const before = line.slice(0, this.cursorCol);
      const after = line.slice(this.cursorCol);
      const indent = before.match(/^(\s*)/)?.[1] ?? "";
      this.buffer[this.cursorRow] = before;
      this.buffer.splice(this.cursorRow + 1, 0, indent + after);
      this.cursorRow++;
      this.cursorCol = indent.length;
      this.ensureVisible();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.insertText("  ");
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.cursorCol > 0) {
        const line = this.currentLine();
        this.buffer[this.cursorRow] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
        this.cursorCol--;
      } else if (this.cursorRow > 0) {
        const prev = this.buffer[this.cursorRow - 1]!;
        const curr = this.currentLine();
        this.buffer[this.cursorRow - 1] = prev + curr;
        this.buffer.splice(this.cursorRow, 1);
        this.cursorRow--;
        this.cursorCol = prev.length;
      }
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.delete)) {
      const line = this.currentLine();
      if (this.cursorCol < line.length) {
        this.buffer[this.cursorRow] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
      } else if (this.cursorRow < this.buffer.length - 1) {
        this.buffer[this.cursorRow] = line + this.buffer[this.cursorRow + 1]!;
        this.buffer.splice(this.cursorRow + 1, 1);
      }
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up)) {
      if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = Math.min(this.cursorCol, this.currentLine().length);
        this.ensureVisible();
      }
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.cursorRow < this.buffer.length - 1) {
        this.cursorRow++;
        this.cursorCol = Math.min(this.cursorCol, this.currentLine().length);
        this.ensureVisible();
      }
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (this.cursorCol > 0) this.cursorCol--;
      else if (this.cursorRow > 0) { this.cursorRow--; this.cursorCol = this.currentLine().length; this.ensureVisible(); }
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.right)) {
      if (this.cursorCol < this.currentLine().length) this.cursorCol++;
      else if (this.cursorRow < this.buffer.length - 1) { this.cursorRow++; this.cursorCol = 0; this.ensureVisible(); }
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.home)) { this.cursorCol = 0; this.invalidate(); return; }
    if (matchesKey(data, Key.end)) { this.cursorCol = this.currentLine().length; this.invalidate(); return; }

    const printable =
      decodeKittyPrintable(data) ??
      (data.length >= 1 && !data.startsWith("\x1b") && data.charCodeAt(0) >= 32
        ? data
        : undefined);
    if (printable !== undefined) {
      this.insertText(printable);
      return;
    }
  }

  private insertText(text: string): void {
    const line = this.currentLine();
    this.buffer[this.cursorRow] = line.slice(0, this.cursorCol) + text + line.slice(this.cursorCol);
    this.cursorCol += text.length;
    this.invalidate();
  }

  private ensureVisible(): void {
    if (this.cursorRow < this.scrollOffset) this.scrollOffset = this.cursorRow;
    else if (this.cursorRow >= this.scrollOffset + this.viewportHeight)
      this.scrollOffset = this.cursorRow - this.viewportHeight + 1;
  }

  render(width: number): string[] {
    if (this.cachedOutput && this.cachedWidth === width) return this.cachedOutput;
    this.ensureVisible();

    const output: string[] = [];
    const gutterWidth = String(this.buffer.length).length + 1;
    const codeWidth = width - gutterWidth - 3;
    const t = this.theme;

    const langLabel = t.fg("accent", t.bold(` ${this.language.toUpperCase()} `));
    const title = t.fg("muted", "Code Editor");
    const langCycle = t.fg("dim", "Ctrl+L: cycle lang");
    output.push(truncateToWidth(`${langLabel} ${title}  ${langCycle}`, width));
    output.push(t.fg("borderMuted", "─".repeat(width)));

    const visEnd = Math.min(this.scrollOffset + this.viewportHeight, this.buffer.length);
    for (let i = this.scrollOffset; i < visEnd; i++) {
      const num = String(i + 1).padStart(gutterWidth);
      const isCur = i === this.cursorRow;
      const gutter = isCur ? t.fg("accent", num) : t.fg("dim", num);
      const sep = t.fg("borderMuted", "│");

      const rawLine = this.buffer[i] ?? "";

      if (isCur) {
        const before = rawLine.slice(0, this.cursorCol);
        const atCursor = rawLine[this.cursorCol] ?? " ";
        const after = rawLine.slice(this.cursorCol + 1);

        const hlBefore = before.length > 0 ? (highlightCode(before, this.language)[0] ?? "") : "";
        const hlAfter = after.length > 0 ? (highlightCode(after, this.language)[0] ?? "") : "";
        const cursorChar = `\x1b[7m${atCursor}\x1b[27m`;

        const codePart = truncateToWidth(`${hlBefore}${cursorChar}${hlAfter}`, codeWidth);
        output.push(truncateToWidth(`${gutter} ${sep} ${codePart}`, width));
      } else {
        const hl = highlightCode(rawLine, this.language)[0] ?? "";
        output.push(truncateToWidth(`${gutter} ${sep} ${hl}`, width));
      }
    }

    for (let i = visEnd; i < this.scrollOffset + this.viewportHeight; i++) {
      const num = " ".repeat(gutterWidth);
      const sep = t.fg("borderMuted", "│");
      const tilde = t.fg("dim", "~");
      output.push(truncateToWidth(`${num} ${sep} ${tilde}`, width));
    }

    output.push(t.fg("borderMuted", "─".repeat(width)));

    const pos = t.fg("dim", `Ln ${this.cursorRow + 1}, Col ${this.cursorCol + 1}`);
    const lineCount = t.fg("dim", `${this.buffer.length} lines`);
    const submitBtn = t.fg("accent", t.bold(" [ Ctrl+Enter → Submit ] "));
    const cancelBtn = t.fg("muted", " [ Esc → Cancel ] ");

    output.push(truncateToWidth(` ${pos}  ${lineCount}    ${submitBtn} ${cancelBtn}`, width));

    this.cachedWidth = width;
    this.cachedOutput = output;
    return output;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedOutput = undefined;
  }
}

export default function mentorMode(pi: ExtensionAPI) {
  const state: MentorState = { enabled: true, mode: "learn", lastIndexedAt: undefined, fileHashes: {} };
  const persist = () => pi.appendEntry(STATE_TYPE, { ...state });

  const clearUi = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("mentor-mode", "");
    ctx.ui.setWidget("mentor-mode", []);
  };

  const setMode = (mode: Mode, ctx?: ExtensionContext) => {
    state.mode = mode;
    persist();
    if (ctx?.hasUI && state.enabled) {
      ctx.ui.setStatus("mentor-mode", `${MODE_TEXT[mode].icon} ${mode}`);
      ctx.ui.setWidget("mentor-mode", ["mentor-mode", MODE_TEXT[mode].desc]);
      ctx.ui.notify(`mentor-mode: switched to ${mode}`, "info");
    }
  };

  const applyUi = (ctx: ExtensionContext) => {
    if (!state.enabled) return clearUi(ctx);
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("mentor-mode", `${MODE_TEXT[state.mode].icon} ${state.mode}`);
    ctx.ui.setWidget("mentor-mode", ["mentor-mode", MODE_TEXT[state.mode].desc]);
  };

  let lastReadPath: string | undefined;
  let lastReadContent: string | undefined;
  let codeEditorLanguage: string = "typescript";
  let codeEditorHandle: any;
  let codeEditorOpen = false;

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data) {
        const data = entry.data as Partial<MentorState>;
        state.enabled = data.enabled ?? state.enabled;
        state.mode = (data.mode as Mode) || state.mode;
        state.lastIndexedAt = data.lastIndexedAt;
        state.fileHashes = data.fileHashes || state.fileHashes;
      }
    }
    applyUi(ctx);

    ctx.ui.setStatus(
      "code-input",
      ctx.ui.theme.fg("dim", "Ctrl+Shift+K: code editor"),
    );
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.enabled) return;

    const modeRules = `

[mentor-mode]
Current mode: ${state.mode}
Slash commands:
- /mentor on
- /mentor off
- /mentor learn
- /mentor search <query>
- /mentor index
- /mentor unstuck
- /mentor do <description>

Operating modes:
1) learn (default): guide step-by-step. Do not write large code blocks. Explain each piece, ask user to implement, then verify before proceeding.
2) search: use web_search for relevant docs/examples, summarize results, and tie them to the task.
3) index: use project_index to build or refresh ~/.pi/wiki/<project-name>/.
4) unstuck: diagnose errors and blockers, read relevant files, give targeted hints first.
5) do: directly implement changes (write/edit/run tests freely).

Behavior policy:
- In non-do modes, prioritize coaching and minimal code snippets.
- In do mode, execute end-to-end implementation.
- If user asks to switch mode, acknowledge and follow that mode.
- When referencing code, use the read tool so the user sees it rendered with syntax highlighting in the TUI.
`;

    return { systemPrompt: event.systemPrompt + modeRules };
  });

  const builtinRead = createReadTool(process.cwd());

  pi.registerTool({
    name: "read",
    label: "Read",
    description: builtinRead.description,
    parameters: builtinRead.parameters,

    async execute(toolCallId, params, signal, onUpdate) {
      const result = await builtinRead.execute(toolCallId, params, signal, onUpdate);

      const filePath = (params as any).path as string;
      if (filePath && result.content) {
        lastReadPath = filePath;
        lastReadContent = result.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
      }

      return result;
    },

    renderResult(result, options, theme, context) {
      const filePath = context.args?.path as string | undefined;
      if (!filePath) return undefined as any;

      const textContent = (result.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");

      if (!textContent) return undefined as any;

      const lang = getLanguageFromPath(filePath);
      if (!lang) return undefined as any;

      return buildCodePanel(textContent, filePath, theme, options.expanded);
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web for documentation, examples, and answers using scripts/search.sh.",
    promptSnippet: "Search the web and return top results with titles/URLs/snippets.",
    promptGuidelines: ["Use web_search when the user asks for external docs, examples, or current web information."],
    parameters: Type.Object({ query: Type.String({ description: "Search query" }) }),
    async execute(_toolCallId, params) {
      const result = await pi.exec("bash", [SEARCH_SCRIPT, params.query]);
      return {
        content: [{ type: "text", text: `Search results for: ${params.query}\n\n${(result.stdout || result.stderr || "No results").trim()}` }],
        details: { query: params.query, code: result.code },
      };
    },
  });

  pi.registerTool({
    name: "project_index",
    label: "Project Index",
    description: "Build or update a wiki-style index under ~/.pi/wiki/<project-name>/ using project structure and code relationships.",
    promptSnippet: "Build/update ~/.pi/wiki index pages from project files.",
    promptGuidelines: ["Use project_index to build or refresh the project knowledge base in ~/.pi/wiki."],
    parameters: Type.Object({ force: Type.Optional(Type.Boolean({ description: "Re-index all files" })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const projectName = await resolveProjectName(ctx.cwd, pi);
      const wikiRoot = path.join(GLOBAL_WIKI_ROOT, projectName);
      await mkdir(path.join(wikiRoot, "modules"), { recursive: true });
      await mkdir(path.join(wikiRoot, "concepts"), { recursive: true });
      await mkdir(path.join(wikiRoot, "decisions"), { recursive: true });

      const listed = await pi.exec("git", ["ls-files", "-co", "--exclude-standard"]);
      const files = (listed.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
      const significant = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|css|scss)$/.test(f));
      const changed: string[] = [];

      for (const rel of significant) {
        const abs = path.join(ctx.cwd, rel);
        const text = await safeRead(abs);
        if (!text) continue;
        const hash = createHash("sha1").update(text).digest("hex");
        if (params.force || state.fileHashes[rel] !== hash) changed.push(rel);
        state.fileHashes[rel] = hash;
      }

      const now = new Date().toISOString();
      const indexLines: string[] = ["# Project Wiki Index", "", `Project: ${projectName}`, "", "Generated pages:", ""];
      const overview: string[] = ["# Project Overview", "", `Last indexed: ${now}`, "", "## Key Areas", ""];

      for (const rel of changed) {
        const abs = path.join(ctx.cwd, rel);
        const text = await safeRead(abs);
        if (!text) continue;
        const truncated = truncateHead(text, { maxLines: 250, maxBytes: 24 * 1024 }).content;
        const imports = (truncated.match(/^import .*$/gm) || []).slice(0, 10);
        const exports = (truncated.match(/export\s+(const|function|class|type|interface|default)\s+[^\s(]+/gm) || []).slice(0, 12);
        const rels = imports.map((l) => l.match(/from\s+["']([^"']+)["']/)?.[1]).filter((s): s is string => !!s).filter((s) => s.startsWith("."));
        const title = slugify(rel.replace(/\.[^.]+$/, ""));
        const page = path.join(wikiRoot, "modules", `${title}.md`);
        const summary = exports[0]?.replace(/^export\s+/, "") || "module/file without explicit exports";
        const pageText = `---\ntitle: ${title}\nsources: [${rel}]\nlast_indexed: ${now.slice(0, 10)}\n---\n\n# ${title}\n\n## Purpose\n- Source file: \`${rel}\`\n\n## Exports / APIs\n${exports.length ? exports.map((e) => `- \`${e}\``).join("\n") : "- (none detected)"}\n\n## Key dependencies\n${imports.length ? imports.map((i) => `- \`${i}\``).join("\n") : "- (none detected)"}\n\n## Relationships\n${rels.length ? rels.map((r) => `- [[${slugify(path.join(path.dirname(rel), r))}]]`).join("\n") : "- (none detected)"}\n`;
        await writeFile(page, pageText, "utf8");
        indexLines.push(`- [[modules/${title}]] | ${summary}`);
      }

      overview.push(`- Modules indexed this run: ${changed.length}`);
      overview.push(`- Total tracked files: ${Object.keys(state.fileHashes).length}`);
      await writeFile(path.join(wikiRoot, "index.md"), indexLines.join("\n") + "\n", "utf8");
      await writeFile(path.join(wikiRoot, "overview.md"), overview.join("\n") + "\n", "utf8");

      const projectLogPath = path.join(wikiRoot, "log.md");
      const projectPriorLog = await safeRead(projectLogPath);
      await writeFile(projectLogPath, `${projectPriorLog}\n## [${now}] index\n- changed_files: ${changed.length}\n- total_tracked_files: ${Object.keys(state.fileHashes).length}\n`, "utf8");

      await mkdir(GLOBAL_WIKI_ROOT, { recursive: true });
      const globalIndexPath = path.join(GLOBAL_WIKI_ROOT, "index.md");
      const globalLogPath = path.join(GLOBAL_WIKI_ROOT, "log.md");
      const globalIndex = await safeRead(globalIndexPath);
      const globalIndexLines = globalIndex ? globalIndex.split("\n") : ["# Global Wiki Index", ""];
      const projectLine = `- [[${projectName}/index]] | last indexed ${now}`;
      const filtered = globalIndexLines.filter((line) => !line.startsWith(`- [[${projectName}/index]] |`));
      filtered.push(projectLine);
      await writeFile(globalIndexPath, `${filtered.join("\n").trimEnd()}\n`, "utf8");
      const globalPriorLog = await safeRead(globalLogPath);
      await writeFile(globalLogPath, `${globalPriorLog}\n## [${now}] indexed project\n- project: ${projectName}\n- path: ${wikiRoot}\n`, "utf8");

      state.lastIndexedAt = now;
      persist();

      return {
        content: [{ type: "text", text: `Indexed ${changed.length} changed files. Wiki updated at ${wikiRoot}.` }],
        details: { changedCount: changed.length, lastIndexedAt: now, projectName, wikiRoot },
      };
    },
  });

  pi.registerCommand("mentor", {
    description: "mentor-mode controls: on | off | learn | search <query> | index | unstuck | do <description>",
    handler: async (args, ctx) => {
      const input = (args || "").trim();
      const [sub, ...rest] = input.split(/\s+/);
      const tail = rest.join(" ").trim();

      if (sub === "off") { state.enabled = false; persist(); clearUi(ctx); ctx.ui.notify("mentor-mode: disabled", "info"); return; }
      if (sub === "on") { state.enabled = true; persist(); applyUi(ctx); ctx.ui.notify(`mentor-mode: enabled (${state.mode})`, "info"); return; }
      if (!sub || sub === "learn") { setMode("learn", ctx); return; }
      if (sub === "search") { setMode("search", ctx); if (tail) pi.sendUserMessage(`Use web_search for: ${tail}`); return; }
      if (sub === "index") { setMode("index", ctx); pi.sendUserMessage("Use project_index to refresh ~/.pi/wiki now."); return; }
      if (sub === "unstuck") { setMode("unstuck", ctx); return; }
      if (sub === "do") { setMode("do", ctx); if (tail) pi.sendUserMessage(tail); return; }

      ctx.ui.notify("Usage: /mentor on|off|learn|search <query>|index|unstuck|do <description>", "warning");
    },
  });

  pi.registerCommand("wiki", {
    description: "Open/query wiki. Use: /wiki [--all] or /wiki search <term> [--all]",
    handler: async (args, ctx) => {
      const input = (args || "").trim();
      const tokens = input ? input.split(/\s+/) : [];
      const useAll = tokens.includes("--all");
      const projectName = await resolveProjectName(ctx.cwd, pi);
      const projectWikiRoot = path.join(GLOBAL_WIKI_ROOT, projectName);

      if (!input || input === "--all") {
        const idxPath = useAll ? path.join(GLOBAL_WIKI_ROOT, "index.md") : path.join(projectWikiRoot, "index.md");
        const idx = await safeRead(idxPath);
        ctx.ui.notify(idx ? `Loaded ${idxPath} (use read tool for full content).` : "No wiki index yet. Run /mentor index.", "info");
        return;
      }

      const [sub, ...rest] = tokens.filter((t) => t !== "--all");
      if (sub === "search") {
        const term = rest.join(" ").trim();
        if (!term) { ctx.ui.notify("Usage: /wiki search <term>", "warning"); return; }
        const grepRoot = useAll ? GLOBAL_WIKI_ROOT : projectWikiRoot;
        const grep = await pi.exec("grep", ["-R", "-n", term, grepRoot]);
        ctx.ui.notify("Wiki search complete (see output in tool context).", "info");
        pi.sendMessage({ customType: "mentor-wiki-search", content: grep.stdout || grep.stderr || "No matches", display: true });
        return;
      }

      ctx.ui.notify("Usage: /wiki or /wiki search <term>", "warning");
    },
  });

  pi.registerShortcut("ctrl+shift+v", {
    description: "Select lines from last-read file for follow-up",
    handler: async (ctx) => {
      if (!lastReadPath || !lastReadContent) {
        ctx.ui.notify("No file has been read yet in this session", "warning");
        return;
      }

      const language = getLanguageFromPath(lastReadPath) ?? "text";

      const selection = await ctx.ui.custom<{ code: string; startLine: number; endLine: number } | null>(
        (tui, theme, _kb, done) => {
          const termHeight = tui.terminal.rows ?? 24;
          const vh = Math.max(10, termHeight - 4);
          const viewer = new CodeViewerComponent(lastReadContent!, lastReadPath!, language, theme, vh);
          viewer.onSelect = (code, s, e) => done({ code, startLine: s, endLine: e });
          viewer.onCancel = () => done(null);
          return {
            render: (w: number) => viewer.render(w),
            invalidate: () => viewer.invalidate(),
            handleInput: (data: string) => { viewer.handleInput(data); tui.requestRender(); },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-right",
            width: "50%",
            minWidth: 40,
            maxHeight: "100%",
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            visible: (termWidth: number) => termWidth >= 80,
          },
        },
      );

      if (selection) {
        const prefix = `Regarding \`${lastReadPath}\` lines ${selection.startLine}-${selection.endLine}:\n\`\`\`${language}\n${selection.code}\n\`\`\`\n\n`;
        ctx.ui.setEditorText(prefix);
        ctx.ui.notify(`Selected L${selection.startLine}-${selection.endLine} — type your follow-up`, "info");
      }
    },
  });

  pi.registerShortcut("ctrl+shift+k", {
    description: "Toggle focus between chat editor and code editor modal",
    handler: async (ctx) => {
      if (codeEditorOpen && codeEditorHandle) {
        if (codeEditorHandle.isFocused()) {
          codeEditorHandle.unfocus();
          ctx.ui.notify("Code editor unfocused (chat editor active)", "info");
        } else {
          codeEditorHandle.focus();
          ctx.ui.notify("Code editor focused", "info");
        }
        return;
      }

      codeEditorOpen = true;
      await ctx.ui.custom<null>(
        (tui, theme, _kb, done) => {
          const termHeight = tui.terminal.rows ?? 24;
          const vh = Math.max(8, termHeight - 4);
          const modal = new CodeEditorModal(theme, codeEditorLanguage, vh);

          modal.onSubmit = (code, lang) => {
            if (!code.trim()) return;
            codeEditorLanguage = lang;
            const message = `\`\`\`${lang}\n${code}\n\`\`\``;
            pi.sendUserMessage(message);
            ctx.ui.notify("Code submitted (editor still open)", "info");
          };
          modal.onCancel = () => done(null);
          modal.onToggleFocus = () => {
            if (!codeEditorHandle) return;
            if (codeEditorHandle.isFocused()) {
              codeEditorHandle.unfocus();
            } else {
              codeEditorHandle.focus();
            }
          };

          return {
            render: (w: number) => modal.render(w),
            invalidate: () => modal.invalidate(),
            handleInput: (data: string) => { modal.handleInput(data); tui.requestRender(); },
          };
        },
        {
          overlay: true,
          onHandle: (handle) => {
            codeEditorHandle = handle;
          },
          overlayOptions: {
            anchor: "top-right",
            width: "50%",
            minWidth: 40,
            maxHeight: "100%",
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            visible: (termWidth: number) => termWidth >= 80,
          },
        },
      );

      codeEditorOpen = false;
      codeEditorHandle = undefined;
    },
  });

  pi.registerCommand("code-lang", {
    description: "Set language for code editor modal",
    handler: async (args, ctx) => {
      const languages = ["typescript", "javascript", "python", "rust", "go", "java", "c", "cpp", "ruby", "bash", "sql", "json", "yaml", "html", "css"];
      if (args && args.trim()) {
        codeEditorLanguage = args.trim().toLowerCase();
        ctx.ui.notify(`Code editor language: ${codeEditorLanguage}`, "info");
        return;
      }
      const choice = await ctx.ui.select("Select code editor language:", languages);
      if (choice) {
        codeEditorLanguage = choice;
        ctx.ui.notify(`Code editor language: ${choice}`, "info");
      }
    },
  });
}
