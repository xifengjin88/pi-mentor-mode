import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Mode = "learn" | "search" | "index" | "unstuck" | "do";

interface MentorState {
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

export default function mentorMode(pi: ExtensionAPI) {
  const state: MentorState = { mode: "learn", lastIndexedAt: undefined, fileHashes: {} };

  const setMode = (mode: Mode, ctx?: ExtensionContext) => {
    state.mode = mode;
    pi.appendEntry(STATE_TYPE, { ...state });
    if (ctx?.hasUI) {
      ctx.ui.setStatus("mentor-mode", `${MODE_TEXT[mode].icon} ${mode}`);
      ctx.ui.setWidget("mentor-mode", ["mentor-mode", MODE_TEXT[mode].desc]);
      ctx.ui.notify(`mentor-mode: switched to ${mode}`, "info");
    }
  };

  const applyUi = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("mentor-mode", `${MODE_TEXT[state.mode].icon} ${state.mode}`);
    ctx.ui.setWidget("mentor-mode", ["mentor-mode", MODE_TEXT[state.mode].desc]);
  };

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === STATE_TYPE && entry.data) {
        const data = entry.data as Partial<MentorState>;
        state.mode = (data.mode as Mode) || state.mode;
        state.lastIndexedAt = data.lastIndexedAt;
        state.fileHashes = data.fileHashes || state.fileHashes;
      }
    }
    applyUi(ctx);
  });

  pi.on("before_agent_start", async (event) => {
    const modeRules = `

[mentor-mode]
Current mode: ${state.mode}
Slash commands:
- /mentor learn
- /mentor search <query>
- /mentor index
- /mentor unstuck
- /mentor do <description>

Operating modes:
1) learn (default): guide step-by-step. Do not write large code blocks. Explain each piece, ask user to implement, then verify before proceeding.
2) search: use web_search for relevant docs/examples, summarize results, and tie them to the task.
3) index: use project_index to build or refresh .pi/wiki.
4) unstuck: diagnose errors and blockers, read relevant files, give targeted hints first.
5) do: directly implement changes (write/edit/run tests freely).

Behavior policy:
- In non-do modes, prioritize coaching and minimal code snippets.
- In do mode, execute end-to-end implementation.
- If user asks to switch mode, acknowledge and follow that mode.
`;

    return { systemPrompt: event.systemPrompt + modeRules };
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
    description: "Build or update a wiki-style index under .pi/wiki using project structure and code relationships.",
    promptSnippet: "Build/update .pi/wiki index pages from project files.",
    promptGuidelines: ["Use project_index to build or refresh the project knowledge base in .pi/wiki."],
    parameters: Type.Object({ force: Type.Optional(Type.Boolean({ description: "Re-index all files" })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const wikiRoot = path.join(ctx.cwd, ".pi", "wiki");
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
      const indexLines: string[] = ["# Project Wiki Index", "", "Generated pages:", ""];
      const overview: string[] = ["# Project Overview", "", `Last indexed: ${now}`, "", "## Key Areas", ""];

      for (const rel of changed) {
        const abs = path.join(ctx.cwd, rel);
        const text = await safeRead(abs);
        if (!text) continue;

        const truncated = truncateHead(text, { maxLines: 250, maxBytes: 24 * 1024 }).content;
        const imports = (truncated.match(/^import .*$/gm) || []).slice(0, 10);
        const exports = (truncated.match(/export\s+(const|function|class|type|interface|default)\s+[^\s(]+/gm) || []).slice(0, 12);
        const rels = imports
          .map((l) => l.match(/from\s+["']([^"']+)["']/)?.[1])
          .filter((s): s is string => !!s)
          .filter((s) => s.startsWith("."));

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

      const logPath = path.join(wikiRoot, "log.md");
      const priorLog = await safeRead(logPath);
      const logEntry = `\n## [${now}] index\n- changed_files: ${changed.length}\n- total_tracked_files: ${Object.keys(state.fileHashes).length}\n`;
      await writeFile(logPath, `${priorLog}${logEntry}`, "utf8");

      state.lastIndexedAt = now;
      pi.appendEntry(STATE_TYPE, { ...state });

      return {
        content: [{ type: "text", text: `Indexed ${changed.length} changed files. Wiki updated at .pi/wiki/.` }],
        details: { changedCount: changed.length, lastIndexedAt: now },
      };
    },
  });

  pi.registerCommand("mentor", {
    description: "mentor-mode controls: learn | search <query> | index | unstuck | do <description>",
    handler: async (args, ctx) => {
      const input = (args || "").trim();
      const [sub, ...rest] = input.split(/\s+/);
      const tail = rest.join(" ").trim();

      if (!sub || sub === "learn") {
        setMode("learn", ctx);
        return;
      }
      if (sub === "search") {
        setMode("search", ctx);
        if (tail) {
          pi.sendUserMessage(`Use web_search for: ${tail}`);
        }
        return;
      }
      if (sub === "index") {
        setMode("index", ctx);
        pi.sendUserMessage("Use project_index to refresh .pi/wiki now.");
        return;
      }
      if (sub === "unstuck") {
        setMode("unstuck", ctx);
        return;
      }
      if (sub === "do") {
        setMode("do", ctx);
        if (tail) pi.sendUserMessage(tail);
        return;
      }

      ctx.ui.notify("Usage: /mentor learn|search <query>|index|unstuck|do <description>", "warning");
    },
  });

  pi.registerCommand("wiki", {
    description: "Open/query wiki. Use: /wiki or /wiki search <term>",
    handler: async (args, ctx) => {
      const input = (args || "").trim();
      if (!input) {
        const idx = await safeRead(path.join(ctx.cwd, ".pi", "wiki", "index.md"));
        ctx.ui.notify(idx ? "Loaded .pi/wiki/index.md (use read tool for full content)." : "No wiki index yet. Run /mentor index.", "info");
        return;
      }

      const [sub, ...rest] = input.split(/\s+/);
      if (sub === "search") {
        const term = rest.join(" ").trim();
        if (!term) {
          ctx.ui.notify("Usage: /wiki search <term>", "warning");
          return;
        }
        const grep = await pi.exec("grep", ["-R", "-n", term, ".pi/wiki"]);
        ctx.ui.notify("Wiki search complete (see output in tool context).", "info");
        pi.sendMessage({ customType: "mentor-wiki-search", content: grep.stdout || grep.stderr || "No matches", display: true });
        return;
      }

      ctx.ui.notify("Usage: /wiki or /wiki search <term>", "warning");
    },
  });
}
