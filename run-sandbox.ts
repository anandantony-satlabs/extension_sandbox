// Shared orchestrator: runs a *real pi subprocess* driven by a scripted fake
// model (SANDBOX_SCRIPT) against a target extension. Regardless of what the
// target does (crash, hang, throw), only the child dies — the caller (your live
// TUI, via /sandbox, or a headless CLI) stays alive and gets a structured PASS/FAIL.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FixtureScript {
  tool?: string;
  args?: Record<string, unknown>;
  text?: string;
}

export interface Fixture {
  prompt: string;
  script: FixtureScript;
  /** Optional human note shown in reports; ignored by assertions. */
  note?: string;
  /** Hermetic working tree for the child: a fresh temp dir seeded with `files`. */
  setup?: {
    /** "temp" (the only supported value) => mkdtemp each run; defaults to "temp" when `files` is set. */
    cwd?: "temp";
    /** Files to write into the temp dir before the child runs (relative paths; parents auto-created). */
    files?: Record<string, string>;
  };
  /** Pass/fail assertions on the child run. */
  expect?: {
    alive?: boolean; // child process should survive to natural exit
    outputContains?: string; // substring in child stdout+stderr (covers fake's final text + tool result JSON)
    resultContains?: string; // substring that MUST appear in a tool's actual result content
    resultNotContains?: string; // substring that MUST NOT appear in any tool's actual result content (assert absence)
    resultIsError?: boolean; // whether a tool result should be an error (true) or success (false)
  };
}

/** One tool execution as observed in the child's JSON event stream. */
export interface ToolResultInfo {
  toolName: string;
  isError: boolean;
  /** Text content blocks from the tool's result (the tool's actual return value). */
  content: string[];
  /** Arguments the tool was called with (from tool_execution_start). */
  args?: unknown;
}

export interface SandboxOptions {
  /** directory the child pi runs in (used to resolve relative target/fixture paths) */
  cwd: string;
  /** path to the fake-model provider extension (dir with index.ts or .ts file) */
  fakeExt: string;
  /** path to the target extension under test */
  targetExt: string;
  fixture: Fixture;
  /** seconds; if child doesn't exit in time it is killed (containment proof) */
  timeoutS?: number;
}

export interface SandboxResult {
  ok: boolean;
  outcome: "pass" | "crash" | "timeout" | "assert-fail" | "error";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
  detail: string;
  /** Tool executions observed in the child's JSON event stream (empty if none ran). */
  toolResults: ToolResultInfo[];
  /** Assistant-level error messages observed (e.g. model stopReason "error"). */
  errors: string[];
  /** Temp working dir used for this run, if `setup.cwd: "temp"` was set.
   *  Kept (not deleted) on failure for inspection; auto-cleaned on pass. */
  childCwd?: string;
  /** The first tool result's text content (the tool's actual return), shown in
   *  reports even on PASS so assertion mistakes are visible at a glance. */
  actualResult?: string;
}

// Parse the child's `--mode json` event stream (one JSON object per line) into
// structured tool results. Strict LF split: JSON payloads can contain Unicode
// separators that generic line readers would wrongly split on.
function parseEvents(output: string): { toolResults: ToolResultInfo[]; errors: string[] } {
  const starts = new Map<string, { toolName: string; args?: unknown }>();
  const toolResults: ToolResultInfo[] = [];
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim() || !line.startsWith("{")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // not a JSON event line (e.g. a stray log) — ignore
    }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "tool_execution_start" && typeof ev.toolCallId === "string") {
      starts.set(ev.toolCallId, { toolName: ev.toolName, args: ev.args });
    } else if (ev.type === "tool_execution_end" && typeof ev.toolCallId === "string") {
      const content: string[] = [];
      const blocks = ev.result?.content;
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") {
            content.push(b.text);
          }
        }
      }
      const start = starts.get(ev.toolCallId);
      toolResults.push({
        toolName: ev.toolName,
        isError: !!ev.isError,
        content,
        args: start?.args,
      });
    } else if (ev.type === "message_end" && ev.message?.stopReason === "error" && ev.message?.errorMessage) {
      errors.push(ev.message.errorMessage);
    }
  }
  return { toolResults, errors };
}

function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(join(cwd, p));
}

// The child is a throwaway `pi` subprocess; keep its environment hermetic and
// deterministic so tests don't depend on the live session's provider/model/
// API key. The fake provider needs no network, so we go offline too.
const CHILD_ENV_ALLOW = [
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM",
  "PI_CODING_AGENT_DIR", "PI_PACKAGE_DIR",
];

function minimalChildEnv(script: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  env.SANDBOX_SCRIPT = JSON.stringify(script);
  env.PI_OFFLINE = "1";
  return env;
}

/** Materialize a per-fixture hermetic working tree.
 *  - `setup.cwd === "temp"` (or `files` present) => a fresh mkdtemp(), seeded
 *    with `setup.files` (relative paths, nested parents auto-created).
 *  - otherwise => use `baseCwd` (the project cwd), no seeding.
 *  Returns the dir to run the child in; `createdTemp` is set only when we made it. */
function materializeFixture(fixture: Fixture, baseCwd: string): { childCwd: string; createdTemp?: string } {
  const setup = fixture.setup;
  const wantTemp = setup && (setup.cwd === "temp" || (setup.files && Object.keys(setup.files).length > 0));
  if (!wantTemp) return { childCwd: baseCwd };
  const temp = mkdtempSync(join(tmpdir(), "sandbox-"));
  if (setup?.files) {
    for (const [rel, content] of Object.entries(setup.files)) {
      const dest = join(temp, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
  }
  return { childCwd: temp, createdTemp: temp };
}

/** Shared child-arg builder for a hermetic `pi` run in JSON mode. */
function childArgs(fake: string, target: string, prompt: string): string[] {
  return [
    "--mode", "json",
    "--provider", "sandbox-fake",
    "--model", "fake-1",
    "-e", fake,
    "-e", target,
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-session",
    prompt,
  ];
}

interface ChildRun {
  output: string;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
}

/** Spawn a hermetic `pi` child, capture all output, SIGKILL on timeout. */
function runChild(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutS: number): Promise<ChildRun> {
  const start = Date.now();
  const timeoutMs = timeoutS * 1000;
  return new Promise<ChildRun>((resolvePromise) => {
    const child = spawn("pi", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: pi treats SIGTERM as graceful shutdown and
      // waits for the in-flight tool call, which hangs forever on a loop.
      try { child.destroy?.(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    child.stdout?.on("data", (d) => { output += d.toString(); });
    child.stderr?.on("data", (d) => { output += d.toString(); });
    child.on("error", () => { /* e.g. ENOENT for missing pi binary */ });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ output, timedOut, exitCode: code, durationMs: Date.now() - start });
    });
  });
}

export async function runSandbox(o: SandboxOptions): Promise<SandboxResult> {
  const fake = abs(o.fakeExt, o.cwd);
  const target = abs(o.targetExt, o.cwd);

  if (!existsSync(fake)) return { ok: false, outcome: "error", exitCode: null, timedOut: false, durationMs: 0, outputTail: "", detail: `fake extension not found: ${fake}`, toolResults: [], errors: [] };
  if (!existsSync(target)) return { ok: false, outcome: "error", exitCode: null, timedOut: false, durationMs: 0, outputTail: "", detail: `target extension not found: ${target}`, toolResults: [], errors: [] };

  const args = childArgs(fake, target, o.fixture.prompt);
  const env = minimalChildEnv(o.fixture.script);
  const { childCwd, createdTemp } = materializeFixture(o.fixture, o.cwd);
  const { output, timedOut, exitCode, durationMs } = await runChild(args, env, childCwd, o.timeoutS ?? 30);

  const tail = output.slice(-1200);
  const wantsAlive = o.fixture.expect?.alive ?? true;
  const expectedDead = wantsAlive === false;
  const contains = o.fixture.expect?.outputContains ?? undefined;
  const resultContains = o.fixture.expect?.resultContains ?? undefined;
  const resultNotContains = o.fixture.expect?.resultNotContains ?? undefined;
  const resultIsError = o.fixture.expect?.resultIsError ?? undefined;
  const { toolResults, errors } = parseEvents(output);
  const survived = !timedOut && exitCode === 0;
  // The first tool result's text content (the tool's actual return),
  // surfaced in reports even on PASS so assertion mistakes are visible.
  const actualResult = toolResults[0]?.content.join("\\n") ?? "";

  // Process-level pass/fail: did the child survive as the fixture expects?
  let processOk: boolean;
  let detail = "";
  if (timedOut) {
    processOk = expectedDead;
    detail = `child hung (timeout ${o.timeoutS}s) and was killed`;
  } else if (exitCode !== 0) {
    processOk = expectedDead;
    detail = `child exited non-zero (${exitCode})`;
  } else {
    processOk = !expectedDead;
    detail = "child ran to completion";
  }

  // Assertions only apply when the process survived long enough to emit
  // its event stream. A crash/hang has no meaningful tool result to assert.
  let assertOk = true;
  if (processOk && survived) {
    if (contains !== undefined) {
      if (!output.includes(contains)) {
        assertOk = false;
        detail = `output missing: "${contains}"`;
      } else {
        detail += ` | output matched "${contains}"`;
      }
    }
    if (assertOk && resultContains !== undefined) {
      const found = toolResults.some((tr) => tr.content.some((c) => c.includes(resultContains)));
      if (!found) {
        assertOk = false;
        detail = `no tool result contained: "${resultContains}"`;
      } else {
        detail += ` | result matched "${resultContains}"`;
      }
    }
    if (assertOk && resultNotContains !== undefined) {
      const present = toolResults.some((tr) => tr.content.some((c) => c.includes(resultNotContains)));
      if (present) {
        assertOk = false;
        detail = `tool result unexpectedly contained: "${resultNotContains}"`;
      } else {
        detail += ` | result excluded "${resultNotContains}"`;
      }
    }
    if (assertOk && resultIsError !== undefined) {
      const anyError = toolResults.some((tr) => tr.isError);
      if (anyError !== resultIsError) {
        assertOk = false;
        detail = `expected tool result isError=${resultIsError}, got ${anyError}`;
      } else {
        detail += ` | result isError=${resultIsError}`;
      }
    }
  }

  const alright = processOk && assertOk;
  let outcome: SandboxResult["outcome"];
  if (timedOut) outcome = "timeout";
  else if (exitCode !== 0) outcome = processOk ? "pass" : "crash";
  else outcome = assertOk ? "pass" : "assert-fail";

  // Keep the temp working tree on failure for inspection; auto-clean on pass.
  const keepTemp = createdTemp !== undefined && !alright;
  if (createdTemp !== undefined && alright) {
    try { rmSync(createdTemp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  return {
    ok: alright,
    outcome,
    exitCode,
    timedOut,
    durationMs,
    outputTail: tail,
    detail,
    toolResults,
    errors,
    childCwd: keepTemp ? createdTemp : undefined,
    actualResult,
  };
}

/** One tool discovered from the target's registered tool list. */
export interface DiscoveredTool {
  name: string;
  description: string;
  /** Placeholder arguments generated from the tool's parameter schema. */
  sampleArgs: unknown;
}

export interface DiscoverOptions {
  cwd: string;
  fakeExt: string;
  targetExt: string;
  timeoutS?: number;
}

export interface DiscoverResult {
  ok: boolean;
  tools: DiscoveredTool[];
  durationMs: number;
  /** When the target crashed/hung during load, the captured output tail. */
  outputTail: string;
  error?: string;
}

/** Discover the tools a target extension registers, by running a single
 *  discovery turn in an isolated child. The fake emits `{ tools: [...] }`
 *  as JSON text; we parse it from the `message_end` event. A target that
 *  throws during load simply yields an empty list (with the crash tail). */
export async function discoverTools(o: DiscoverOptions): Promise<DiscoverResult> {
  const fake = abs(o.fakeExt, o.cwd);
  const target = abs(o.targetExt, o.cwd);
  const start = Date.now();
  if (!existsSync(fake)) return { ok: false, tools: [], durationMs: 0, outputTail: "", error: `fake extension not found: ${fake}` };
  if (!existsSync(target)) return { ok: false, tools: [], durationMs: 0, outputTail: "", error: `target extension not found: ${target}` };

  const args = childArgs(fake, target, "discover");
  const env = minimalChildEnv({ __discover: true });
  const { output, timedOut, exitCode, durationMs } = await runChild(args, env, o.cwd, o.timeoutS ?? 30);
  const durationTotal = Date.now() - start;

  if (timedOut) return { ok: false, tools: [], durationMs: durationTotal, outputTail: output.slice(-1200), error: `target hung during load (timeout ${o.timeoutS ?? 30}s)` };
  if (exitCode !== 0) return { ok: false, tools: [], durationMs: durationTotal, outputTail: output.slice(-1200), error: `target crashed during load (exit ${exitCode})` };

  // Collect text content from message_end events; the discovery payload is a
  // single text block whose body is JSON: { tools: [...] }.
  let payload = "";
  for (const line of output.split("\n")) {
    if (!line.trim() || !line.startsWith("{")) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === "message_end" && ev.message?.role === "assistant") {
      const content = ev.message.content;
      if (Array.isArray(content)) for (const b of content) if (b?.type === "text" && typeof b.text === "string") payload += b.text;
    }
  }

  let tools: DiscoveredTool[] = [];
  try {
    const parsed = JSON.parse(payload);
    if (parsed && Array.isArray(parsed.tools)) {
      tools = parsed.tools.filter((t: any) => t && typeof t.name === "string");
    }
  } catch (e) {
    return { ok: false, tools: [], durationMs: durationTotal, outputTail: output.slice(-1200), error: `could not parse discovery payload: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, tools, durationMs: durationTotal, outputTail: output.slice(-1200) };
}

// ——— headless CLI entry ———
// usage: node run-sandbox.ts <fixture.json|fixturesDir> <fakeExt> <targetExt> [timeoutS]
//   <fixture.json>  run a single fixture, print its SandboxResult JSON
//   <fixturesDir>   run every *.json in the dir (sorted), print a summary
// True only when node launched this file directly (not when jiti imports it
// from the dev extension). Guards the CLI block so importing this module as a
// library can never process.exit() the live session.
function isMainEntry(): boolean {
  try {
    if (!import.meta.main) return false;
    const entry = process.argv[1];
    if (!entry) return false;
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isMainEntry()) {
  const [fixturePath, fakeExt, targetExt, timeoutS] = process.argv.slice(2);
  if (!fixturePath || !fakeExt || !targetExt) {
    console.error('usage: node run-sandbox.ts <fixture.json|fixturesDir> <fakeExt> <targetExt> [timeoutS]');
    process.exit(2);
  }
  const cwd = process.cwd();
  const t = timeoutS ? Number(timeoutS) : 30;

  const isDir = existsSync(fixturePath) && statSync(fixturePath).isDirectory();
  const files = isDir
    ? readdirSync(fixturePath).filter((f) => f.endsWith(".json")).sort().map((f) => join(fixturePath, f))
    : [fixturePath];
  if (files.length === 0) {
    console.error(`no fixtures found in ${fixturePath}`);
    process.exit(2);
  }

  const results = [];
  for (const f of files) {
    const fixture = JSON.parse(readFileSync(f, "utf-8"));
    const res = await runSandbox({ cwd, fakeExt, targetExt, fixture, timeoutS: t });
    results.push({ name: fixture.name ?? basename(f, ".json"), note: fixture.note, file: f, ...res });
  }

  if (isDir) {
    const passed = results.filter((r) => r.ok).length;
    for (const r of results) {
      const tag = r.ok ? "PASS" : r.outcome.toUpperCase();
      const note = r.note ? `  # ${r.note}` : "";
      console.log(`[${tag}] ${r.name.padEnd(20)} ${String(r.durationMs).padStart(6)}ms  ${r.detail}${note}`);
      // Always surface the tool's actual return value: on failure it shows why,
      // on pass it lets you eyeball whether you asserted the right thing.
      if (r.actualResult) {
        const body = r.actualResult.slice(0, 200);
        console.log(`        └─ actual: ${body}${body.length >= 200 ? " …" : ""}`);
      } else if (!r.ok) {
        // No tool ran (crash/timeout) — fall back to the raw output tail.
        const t = r.outputTail.trim();
        if (t) console.log(`        └─ ${t.slice(0, 200)}${t.length >= 200 ? " …" : ""}`);
      }
      if (!r.ok) {
        for (const e of r.errors) console.log(`        ✖ ${e}`);
        if (r.childCwd) console.log(`        ⚠ working tree kept: ${r.childCwd}`);
      }
    }
    console.log(`\n${passed}/${results.length} passed`);
    process.exit(passed === results.length ? 0 : 1);
  } else {
    console.log(JSON.stringify(results[0], null, 2));
    process.exit(results[0].ok ? 0 : 1);
  }
}