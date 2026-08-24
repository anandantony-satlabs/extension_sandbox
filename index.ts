/**
 * Extension Sandbox — a pi dev extension for testing other pi extensions
 * in isolation before hot-reloading them into a live session.
 *
 * Registers a single tool, `extension_sandbox`, which drives a target
 * extension under test with a scripted (fake) model inside a throwaway `pi`
 * subprocess. If the target crashes or hangs, only the child dies; this live
 * session stays alive and gets a structured PASS/FAIL report.
 *
 * Dev workflow:
 *   1. Author/iterate your extension (e.g. ./my-ext.ts).
 *   2. Author repeatable fixtures as *.json (see tests/fixtures/ for shape).
 *   3. Ask the model: extension_sandbox(extension="./my-ext.ts", fixturesDir="./tests/fixtures")
 *   4. Once green, drop the extension into .pi/extensions/ — safe to load.
 *
 * Tests live as files so you can re-run the same suite later, after changes.
 *
 * Load this extension in your dev session with:
 *   pi -e ~/PROJECT/extension_sandbox
 * (or symlink it into ~/.pi/agent/extensions/).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverTools, runSandbox, type Fixture, type SandboxResult } from "./run-sandbox.ts";

// Co-located fake provider used by every child unless `fakeExt` overrides it.
const EXT_DIR = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();
const DEFAULT_FAKE_EXT = join(EXT_DIR, "fake");

const TestCase = Type.Object({
  name: Type.Optional(Type.String({ description: "Label shown in the report. Defaults to an index." })),
  prompt: Type.String({
    description: "User prompt sent to the fake model in the child. The fake is scripted, so this only seeds context.",
  }),
  script: Type.Object({
    tool: Type.Optional(Type.String({ description: "Name of the target tool to call. Omit for a text-only turn." })),
    args: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arguments for the tool call." })),
    text: Type.Optional(Type.String({
      description: "Final reply text the fake emits after the tool runs (or immediately if no tool). Use a unique sentinel and assert it via expect.outputContains.",
    })),
  }),
  expect: Type.Optional(Type.Object({
    alive: Type.Optional(Type.Boolean({
      description: "Whether the child should survive to natural exit. Default true. Set false for hang/loop tests that must be killed.",
    })),
    outputContains: Type.Optional(Type.String({
      description: "Substring that must appear in child stdout+stderr (covers both the tool's result and the fake's final text).",
    })),
    resultContains: Type.Optional(Type.String({
      description: "Substring that must appear in the tool's actual result content (from the JSON event stream). Precisely asserts on the tool's return value, independent of the fake model's scripted final text.",
    })),
    resultIsError: Type.Optional(Type.Boolean({
      description: "Whether the tool result should be an error (true) or a success (false). Asserts on isError from the JSON tool_execution_end event.",
    })),
  })),
});

/** Resolve a target extension spec: a direct path, or an installed name. */
function resolveTarget(spec: string, cwd: string): string | null {
  // 1. Direct path (absolute, or relative to the project cwd).
  const asPath = isAbsolute(spec) ? spec : resolve(cwd, spec);
  if (existsSync(asPath)) {
    try {
      const s = statSync(asPath);
      if (s.isFile() || s.isDirectory()) return asPath;
    } catch {
      // fall through to name lookup
    }
  }
  // 2. Installed name: <agentDir>/extensions/<name> (dir | .ts | dir/index.ts)
  //    or project-local .pi/extensions/<name>.
  const candidates = [
    join(getAgentDir(), "extensions", spec),
    join(getAgentDir(), "extensions", spec + ".ts"),
    join(getAgentDir(), "extensions", spec, "index.ts"),
    join(cwd, ".pi", "extensions", spec),
    join(cwd, ".pi", "extensions", spec + ".ts"),
    join(cwd, ".pi", "extensions", spec, "index.ts"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

/** Load every *.json fixture from a directory (sorted for stable ordering). */
function loadFixturesDir(dir: string, cwd: string): { name: string; fixture: Fixture }[] {
  const abs = isAbsolute(dir) ? dir : resolve(cwd, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`fixturesDir not found or not a directory: ${abs}`);
  }
  const files = readdirSync(abs).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no *.json fixtures found in ${abs}`);
  return files.map((f) => {
    const fixture = JSON.parse(readFileSync(join(abs, f), "utf-8")) as Fixture & { name?: string };
    const name = fixture.name ?? basename(f, ".json");
    return { name, fixture };
  });
}

function excerpt(tail: string, max = 240): string {
  const s = tail.trim();
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + " …";
}

/** Show an absolute path relative to cwd when it's under cwd (nicer for the model to echo back). */
function relativeOrAbs(p: string, cwd: string): string {
  const rel = p.replace(cwd + "/", "");
  return rel.startsWith("..") ? p : "./" + rel;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "extension_sandbox",
    label: "Extension Sandbox",
    description:
      "Safely test a pi extension under development by driving its tools with a scripted (fake) model in an isolated `pi` subprocess, then return a structured PASS/FAIL report. " +
      "Use while developing or modifying a pi extension to verify its tools don't crash or hang before hot-reloading them into the live session. " +
      "Runs a repeatable suite of fixtures (a directory of *.json files) or inline tests. If the target crashes or hangs, only the child subprocess is affected — this session stays alive. " +
      "Child env is hermetic; if a test fails on a missing API key, follow the FIX line in the report.",
    promptGuidelines: [
      "Use extension_sandbox when developing, modifying, or reviewing a pi extension, to exercise its tools with repeatable fixtures before loading the extension into the live session.",
      "When asked to test or verify an extension, prefer extension_sandbox with a fixturesDir of saved *.json tests over ad-hoc inline tests, so the suite is reusable later.",
    ],
    parameters: Type.Object({
      extension: Type.String({
        description: "Target extension under test: a path (file or dir) or an installed extension name. Prefer a path while developing.",
      }),
      fixturesDir: Type.Optional(Type.String({
        description: "Directory of *.json fixtures to run as a repeatable suite. Mutually exclusive with `tests`. Preferred for tests you want to keep and re-run.",
      })),
      tests: Type.Optional(Type.Array(TestCase, {
        description: "Inline test cases. Mutually exclusive with `fixturesDir`.",
      })),
      timeoutS: Type.Optional(Type.Number({
        description: "Per-test timeout in seconds before the child is SIGKILLed (default 30). Raise for slow tools.",
      })),
      fakeExt: Type.Optional(Type.String({
        description: "Override the fake-model provider extension (advanced). Defaults to the sandbox's bundled fake.",
      })),
      outputDir: Type.Optional(Type.String({
        description: "Directory to dump all test artifacts (stdout, stderr, tool results, fixture, summary). Per-test subdirectories created automatically.",
      })),
      scaffold: Type.Optional(Type.Boolean({
        description: "Instead of running tests, discover the target's tools (in an isolated child) and write one starter fixture per tool into scaffoldDir. Edit them, then re-run with fixturesDir=scaffoldDir. Mutually exclusive with fixturesDir/tests. Built-in tools (read/bash/etc.) are skipped." })),
      scaffoldDir: Type.Optional(Type.String({
        description: "Where to write scaffolded fixtures (default ./tests/<extension-basename>). Resolved relative to cwd. Created if missing. Existing fixtures are not overwritten." })),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const cwd = ctx.cwd;

      // — scaffold mode: discover tools, write starter fixtures, don't run —
      if (params.scaffold) {
        if (params.fixturesDir || params.tests) {
          return {
            content: [{ type: "text", text: "scaffold is mutually exclusive with fixturesDir/tests: scaffold writes starter fixtures, the others run them." }],
            details: { error: "ambiguous" },
          };
        }
        const target = resolveTarget(params.extension, cwd);
        if (!target) {
          return {
            content: [{ type: "text", text: `target extension not found: "${params.extension}"` }],
            details: { error: "target_not_found", spec: params.extension },
          };
        }
        const fakeExt = params.fakeExt ? (isAbsolute(params.fakeExt) ? params.fakeExt : resolve(cwd, params.fakeExt)) : DEFAULT_FAKE_EXT;
        const timeoutS = params.timeoutS ?? 30;
        const defaultDir = join("tests", basename(target).replace(/\.(ts|js|mjs|cjs)$/, ""));
        const scaffoldDir = isAbsolute(params.scaffoldDir ?? defaultDir) ? (params.scaffoldDir ?? defaultDir) : resolve(cwd, params.scaffoldDir ?? defaultDir);

        onUpdate?.({ content: [{ type: "text", text: `extension_sandbox: discovering tools in ${target}…` }] });
        const discovery = await discoverTools({ cwd, fakeExt, targetExt: target, timeoutS });
        if (!discovery.ok) {
          return {
            content: [{ type: "text", text: `discovery failed: ${discovery.error ?? "unknown"}\n${excerpt(discovery.outputTail)}` }],
            details: { error: "discovery_failed", target, ...(discovery.error ? { message: discovery.error } : {}), outputTail: discovery.outputTail },
          };
        }

        // Skip pi's built-in tools; only scaffold fixtures for the target's own.
        const BUILTINS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
        const tools = discovery.tools.filter((t) => !BUILTINS.has(t.name));
        if (tools.length === 0) {
          return {
            content: [{ type: "text", text: `target registered no custom tools (only built-ins). Nothing to scaffold. If the extension adds commands or event handlers rather than tools, extension_sandbox can't fixture-test those.` }],
            details: { target, discovered: discovery.tools.map((t) => t.name), scaffolded: [] },
          };
        }

        mkdirSync(scaffoldDir, { recursive: true });
        const created: string[] = [];
        const skipped: string[] = [];
        for (const tool of tools) {
          const file = join(scaffoldDir, `${tool.name}.json`);
          if (existsSync(file)) { skipped.push(tool.name); continue; }
          const sentinel = `${tool.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_RESULT`;
          const fixture = {
            name: tool.name,
            prompt: `call ${tool.name}`,
            script: { tool: tool.name, args: tool.sampleArgs ?? {}, text: sentinel },
            expect: {
              alive: true,
              resultContains: "<expected substring in result>",
              resultIsError: false,
            },
          };
          writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
          created.push(tool.name);
        }

        const lines: string[] = [];
        lines.push(`extension_sandbox — scaffolded ${created.length} fixture${created.length === 1 ? "" : "s"} into ${scaffoldDir}`);
        lines.push(`target: ${target} (${discovery.tools.length} tools discovered, ${tools.length} custom, ${discovery.tools.length - tools.length} built-in skipped)`);
        lines.push("");
        for (const t of tools) {
          const status = created.includes(t.name) ? "created" : "exists, skipped";
          lines.push(`  ${t.name.padEnd(20)} ${status}  args=${JSON.stringify(t.sampleArgs ?? {})}`);
        }
        lines.push("");
        lines.push(`Each fixture calls the tool with placeholder args and asserts a placeholder resultContains. Edit the args and assertions, then re-run:`);
        lines.push(`  extension_sandbox(extension="${params.extension}", fixturesDir="${relativeOrAbs(scaffoldDir, cwd)}")`);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { target, scaffoldDir, created, skipped, tools },
        };
      }

      // — run mode —
      const target = resolveTarget(params.extension, cwd);
      if (!target) {
        return {
          content: [{
            type: "text",
            text: `target extension not found: "${params.extension}"\nTried as a path (relative to ${cwd}) and as an installed name under ${join(getAgentDir(), "extensions")}.`,
          }],
          details: { error: "target_not_found", spec: params.extension, agentExtensions: join(getAgentDir(), "extensions") },
        };
      }

      const fakeExt = params.fakeExt
        ? (isAbsolute(params.fakeExt) ? params.fakeExt : resolve(cwd, params.fakeExt))
        : DEFAULT_FAKE_EXT;
      if (!existsSync(fakeExt)) {
        return {
          content: [{ type: "text", text: `fake extension not found: ${fakeExt}` }],
          details: { error: "fake_not_found", fakeExt },
        };
      }

      const timeoutS = params.timeoutS ?? 30;

      // Build the fixture list.
      let suite: { name: string; fixture: Fixture }[];
      try {
        if (params.fixturesDir && params.tests) {
          return {
            content: [{ type: "text", text: "provide either fixturesDir or tests, not both." }],
            details: { error: "ambiguous" },
          };
        }
        if (params.fixturesDir) {
          suite = loadFixturesDir(params.fixturesDir, cwd);
        } else if (params.tests && params.tests.length) {
          suite = params.tests.map((t, i) => {
            const { name, ...fixture } = t;
            return { name: name ?? `test-${i + 1}`, fixture };
          });
        } else {
          return {
            content: [{ type: "text", text: "no tests provided: supply `fixturesDir` (a directory of *.json) or `tests` (inline array)." }],
            details: { error: "no_tests" },
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `failed to load tests: ${msg}` }],
          details: { error: "load_failed", message: msg },
        };
      }

      const outputDir = params.outputDir ? (isAbsolute(params.outputDir) ? params.outputDir : resolve(cwd, params.outputDir)) : undefined;

      onUpdate?.({
        content: [{
          type: "text",
          text: `extension_sandbox: running ${suite.length} test${suite.length === 1 ? "" : "s"} against ${target}`,
        }],
      });

      const results: ({ name: string; note?: string } & SandboxResult)[] = [];
      for (const { name, fixture } of suite) {
        onUpdate?.({ content: [{ type: "text", text: `> ${name}` }] });
        const res = await runSandbox({ cwd, fakeExt, targetExt: target, fixture, timeoutS, outputDir, testName: name });
        results.push({ name, note: fixture.note, ...res });
      }

      const passed = results.filter((r) => r.ok).length;
      const total = results.length;
      const allOk = passed === total;

      const lines: string[] = [];
      lines.push(`extension_sandbox — ${passed}/${total} ${allOk ? "passed (all green)" : "passed"}`);
      lines.push(`target: ${target}`);
      lines.push(`fake:   ${fakeExt}`);
      lines.push("");
      for (const r of results) {
        const tag = r.ok ? "PASS" : r.outcome.toUpperCase();
        const note = r.note ? `   # ${r.note}` : "";
        lines.push(`[${tag}] ${r.name.padEnd(22)} ${String(r.durationMs).padStart(6)}ms  ${r.detail}${note}`);
        // Always surface the tool's actual return value: on failure it shows
        // why; on pass it lets you eyeball whether you asserted the right thing
        // (substring matches can pass on semantically wrong expectations).
        if (r.actualResult) {
          lines.push(`        └─ actual: ${excerpt(r.actualResult)}`);
        } else if (!r.ok) {
          // No tool ran (crash/timeout) — fall back to the raw output tail.
          if (r.toolResults.length) {
            for (const tr of r.toolResults) {
              lines.push(`        └─ ${tr.toolName}${tr.isError ? " (error)" : ""}: ${excerpt(tr.content.join("\\n"))}`);
            }
          } else if (r.outputTail.trim()) {
            lines.push(`        └─ ${excerpt(r.outputTail)}`);
          }
          for (const e of r.errors) lines.push(`        ✖ ${e}`);
        }
        if (!r.ok && r.childCwd) lines.push(`        ⚠ working tree kept: ${r.childCwd}`);
      }

      if (outputDir) lines.push(`
Artifacts dumped to: ${outputDir}`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { target, fakeExt, passed, total, results },
      };
    },
  });
}
