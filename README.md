# extension_sandbox

A pi **dev extension** that tests other pi extensions in isolation *before* you hot-reload them into a live session.

It registers one tool — `extension_sandbox` — that drives a target extension under test with a **scripted fake model** inside a throwaway `pi` subprocess. You point it at a directory of repeatable `*.json` fixtures and get back a structured **PASS/FAIL** report. If the target extension crashes or hangs, only the child subprocess dies; your live session stays alive.

## Why

Pi hot-reloads extensions via `/reload`, in-process. That's great for iteration, but a synchronous throw during `execute`, an uncaught rejection, or a `while (true) {}` will crash or wedge the session you're working in. There's no built-in extension isolation.

`extension_sandbox` gives you that isolation: it spins up a **separate `pi` process** per fixture, drives the target's tools with a fake model whose output is fully scripted (no network, no API key, no cost), and `SIGKILL`s the child on timeout. The live session just collects results.

## The workflow

1. **Develop** your extension — e.g. `./my-ext.ts`.
2. **Scaffold** starter fixtures by asking the model:
   > Use `extension_sandbox` with `scaffold=true`, `extension="./my-ext.ts"`.
   This discovers the tools your extension registers (in an isolated child) and writes one template fixture per custom tool into `./tests/my-ext/`, with placeholder args (derived from each tool's parameter schema — enums pick the first allowed value) and placeholder assertions. Built-in tools are skipped; existing fixtures are never overwritten.
3. **Edit** the generated `*.json`: fix the args and replace the placeholder `expect.resultContains` / `resultIsError` with the real expected behavior. Running a fixture as-is correctly **assert-fails** and surfaces the tool's actual return value — so you can copy that into `resultContains`.
4. **Test** until green:
   > `extension_sandbox(extension="./my-ext.ts", fixturesDir="./tests/my-ext")`
5. **Install** — once green, drop the extension into `.pi/extensions/` (or `~/.pi/agent/extensions/`). It's now safe to load, because the tests that would have crashed your session already pass.

Tests live as files so you can re-run the same suite later, after changes. Re-scaffold after adding a new tool to pick up its fixture (existing ones are preserved).

## Scaffold mode

Don't hand-write fixtures from scratch. Ask the model:

> `extension_sandbox(scaffold=true, extension="./my-ext.ts")`

The tool runs a **discovery** child (the same isolated subprocess, but the fake model emits a single JSON text turn listing the target's registered tools instead of calling one). It then writes one starter fixture per **custom** tool into `scaffoldDir` (default `./tests/<extension-basename>/`):

```jsonc
// ./tests/my-ext/mytool.json — generated, ready to edit
{
  "name": "mytool",
  "prompt": "call mytool",
  "script": { "tool": "mytool", "args": { "mode": "safe" }, "text": "MYTOOL_RESULT" },
  "expect": { "alive": true, "resultContains": "<expected substring in result>", "resultIsError": false }
}
```

- **Placeholder args** come from the tool's parameter schema: enums pick the first allowed value, required strings default to `""`, numbers to `0`, etc. Optionals are omitted.
- **Built-in tools** (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`) are skipped — you only get fixtures for your extension's own tools.
- **Idempotent**: re-scaffolding skips tools whose fixture already exists (never overwrites). Run it again after adding a new tool to pick up just that one.
- **A target that throws during load** yields a clear `discovery failed` report with the crash tail — useful in itself, since an extension that can't load won't register anything.
- **A command/handler-only extension** (no custom tools) reports "nothing to scaffold" — `extension_sandbox` fixture-tests *tools*, not commands.

### The edit loop

Running a freshly-scaffolded fixture **assert-fails** by design — the placeholder `resultContains` won't match. The failure surfaces the tool's actual return value, so you copy that into the assertion and re-run:

```
[ASSERT-FAIL] mytool    1153ms  no tool result contained: "<expected substring in result>"
        └─ mytool: safe result: 42   ← copy this into resultContains
```

## Load it

```bash
# in your dev session, from the project where you're building extensions:
pi -e ~/PROJECT/extension_sandbox

# or symlink it into your agent extensions so every session has it:
ln -s ~/PROJECT/extension_sandbox ~/.pi/agent/extensions/extension_sandbox
```

## The `extension_sandbox` tool

| Parameter | Type | Description |
|-----------|------|-------------|
| `extension` | `string` *(required)* | Target under test: a path (file or dir) or an installed extension name. Prefer a path while developing. |
| `fixturesDir` | `string` | Directory of `*.json` fixtures to run as a repeatable suite. Mutually exclusive with `tests`. Preferred for tests you want to keep. |
| `tests` | `TestCase[]` | Inline test cases. Mutually exclusive with `fixturesDir`. |
| `timeoutS` | `number` | Per-test timeout in seconds before the child is `SIGKILL`ed (default `30`). Raise for slow tools. |
| `fakeExt` | `string` | Override the fake-model provider (advanced). Defaults to the sandbox's bundled `fake/`. |
| `outputDir` | `string` | **Dump all test artifacts** (stdout, stderr, tool results, fixture, summary, child working tree) into per-test subdirectories under this path. Relative paths resolved from project cwd. |
| `scaffold` | `boolean` | **Generate** starter fixtures instead of running: discover the target's tools (in an isolated child) and write one template `*.json` per custom tool into `scaffoldDir`. Built-in tools are skipped. Existing fixtures are never overwritten. Edit them, then re-run with `fixturesDir`. Mutually exclusive with `fixturesDir`/`tests`. |
| `scaffoldDir` | `string` | Where scaffolded fixtures go (default `./tests/<extension-basename>`). Created if missing. |

**Returns** a per-fixture table and, in `details`, the full result set (each result carries `toolResults[]` with the tool's actual return content and `isError`, any assistant-level `errors[]`, the `actualResult` string, and `childCwd` when a temp working tree was kept on failure):

```
extension_sandbox — 4/4 passed (all green)
...
[PASS] tree-happy            1291ms  ... | result matched "a.ts" | result excluded ".env" | result isError=false   # resettable corpus; asserts dotfiles excluded
        └─ actual: a.ts
sub/b.ts
```

Every row — pass **or** fail — shows an `└─ actual:` line with the tool's actual return value (truncated). On a **pass** this lets you eyeball whether you asserted the *right* thing (substring matches can pass on semantically wrong expectations); on a failure it shows why it failed.

```
extension_sandbox — 4/4 passed (all green)
target: /home/me/proj/targets/risky-ext.ts
fake:   /home/me/proj/extension_sandbox/fake

[PASS] boom-safe        1240ms  child ran to completion | output matched "SANDBOX_SAFE_PASS"
[PASS] boom-throw       1266ms  child ran to completion | output matched "SANDBOX_THROW_PASS"
[PASS] boom-bad-args    1232ms  child ran to completion | output matched "SANDBOX_BADARGS_PASS"
[PASS] boom-loop       15023ms  child hung (timeout 15s) and was killed | output matched ""
```

On a `crash`, `timeout`, or `assert-fail`, the row also shows the tool's actual return value(s) (`toolName: <content>`, truncated), or the child's stdout/stderr tail as a fallback — invaluable for debugging the target.

### Artifact dumping (`outputDir`)

Set `outputDir` to dump a complete, self-contained artifact package for each test — invaluable for debugging flaky or failing fixtures without re-running them:

```bash
# CLI
node run-sandbox.ts tests/fixtures ./fake ./targets/risky-ext.ts --output-dir ./artifacts

# Tool
extension_sandbox(extension="./my-ext", fixturesDir="./tests/my-ext", outputDir="./sandbox-artifacts")
```

Each test gets its own subdirectory (`outputDir/<test-name>/`):

```
artifacts/
└── test-name/
    ├── stdout.txt          # Full child stdout+stderr (merged)
    ├── stderr.txt          # Same as stdout
    ├── result.json         # Structured: toolResults[], errors[], exitCode, timedOut, durationMs, ok, outcome
    ├── actual-result.txt   # First tool's text content (truncated in report)
    ├── fixture.json        # The fixture JSON used for this run
    ├── summary.txt         # Human-readable one-page summary
    └── child-cwd/          # Child's temp working tree (only on failure; auto-cleaned on pass)
```

**Files written per test:**

| File | Purpose |
|------|---------|
| `stdout.txt` / `stderr.txt` | Complete child output (JSON event stream) — search for tool calls, timing, schema validation |
| `result.json` | Machine-parseable: all tool results with `isError`, args, content; exit code; timing; outcome |
| `actual-result.txt` | The exact tool return text (what the `└─ actual:` line truncates) |
| `fixture.json` | The exact fixture that was run — reproducible without guessing |
| `summary.txt` | One-page human summary (outcome, detail, tool list, errors) |
| `child-cwd/` | The temp working tree (`setup.cwd: "temp"`) — **only on failure**, auto-cleaned on pass |

**CLI:**
```bash
node run-sandbox.ts tests/fixtures ./fake ./targets/risky-ext.ts --output-dir ./artifacts
```

**Tool:**
```typescript
extension_sandbox({
  extension: "./my-ext",
  fixturesDir: "./tests/my-ext",
  outputDir: "./sandbox-artifacts"   // relative to project cwd
})
```

When `outputDir` is omitted (default), no artifacts are written — zero overhead, zero cleanup.

```
extension_sandbox — 4/4 passed (all green)
target: ./targets/risky-ext.ts
fake:   ./fake

[PASS] boom-safe        1240ms  child ran to completion | output matched "SANDBOX_SAFE_PASS"
[PASS] boom-throw       1266ms  child ran to completion | output matched "SANDBOX_THROW_PASS"
[PASS] boom-bad-args    1232ms  child ran to completion | output matched "SANDBOX_BADARGS_PASS"
[PASS] boom-loop       15023ms  child hung (timeout 15s) and was killed | output matched ""

Artifacts dumped to: ./artifacts
```

## Fixture format

A fixture is a JSON object describing one test: the prompt, the scripted fake-model behavior (the **input** to the tool call), and the **expected output / survival** assertions.

```jsonc
{
  "name": "tree-happy",                     // optional; defaults to the filename
  "note": "resettable corpus; asserts dotfiles excluded", // optional human note, shown in reports
  "prompt": "list the project",            // sent to the fake model in the child
  "setup": {                               // optional hermetic working tree
    "cwd": "temp",                         //   fresh temp dir each run (resettable, portable)
    "files": {                             //   files written into the temp dir before the child runs
      "src/a.ts": "export const a = 1;",    //     (relative paths; nested parents auto-created)
      "src/sub/b.ts": "export const b = 2;",
      ".env": "SECRET=1"
    }
  },
  "envAllow": ["MY_API_KEY"],              // optional: extra env var NAMES passed through from the parent process
  "env": { "MY_FLAG": "1" },               // optional: explicit env var VALUES injected into the child
  "script": {                               // what the fake model "says"
    "tool": "tree",                         //   tool name to call (target must register it)
    "args": { "path": "src" },             //   arguments for the call
    "text": "TREE_HAPPY"                   //   final reply emitted after the tool runs
  },
  "expect": {                               // optional assertions (all must hold)
    "alive": true,                          //   child should survive to natural exit (default true)
    "outputContains": "TREE_HAPPY",         //   substring in child stdout+stderr
    "resultContains": "a.ts",               //   substring that MUST appear in the tool's result
    "resultNotContains": ".env",            //   substring that MUST NOT appear (assert absence)
    "resultIsError": false                  //   whether the tool result is an error (true/false)
  }
}
```

- `script.tool` omitted → the fake goes straight to emitting `script.text` (useful for prompts that need no tool call).
- `expect.alive: false` → the child is *expected* to hang/crash and be killed; use this for loop/timeout containment tests.
- `outputContains` matches against the child's combined stdout+stderr (the full JSON event stream). In JSON mode that includes both the tool's result and the fake's final text, so a unique sentinel works — but it mostly proves "the session survived and the follow-up turn ran."
- `resultContains` / `resultNotContains` / `resultIsError` are **precise**: they assert on the tool's actual return value (parsed from the `tool_execution_end` JSON event), independent of the fake model's scripted final text. Prefer these for verifying a tool's real behavior.
- **`resultNotContains`** asserts a substring does **not** appear in any tool result — use it to confirm something is *absent* (e.g. a dotfile excluded by an ignore rule), without inverting via an impossible substring.
- **`note`** is a free-text annotation shown in the report. Use it instead of stray `expect__*` fields (those are silently ignored).

### Resettable temp-dir corpora (`setup`)

Tools that do file I/O (tree, file listing, globbing, path handling) shouldn't depend on hand-created fixture trees living relative to your repo — those drift and aren't portable. Declare the corpus *in the fixture* and let the sandbox materialize it fresh each run:

```jsonc
"setup": {
  "cwd": "temp",                 // fresh mkdtemp() per run
  "files": { "src/a.ts": "...", ".env": "..." }
}
```

- The child runs in that temp dir as its `cwd`, so the target tool's relative-path args resolve there.
- Fresh every run = **resettable** (no cleanup, no drift) and **portable** (the fixture is self-contained — no `fixtures/sample` checked into the repo).
- On **failure**, the temp dir is **kept** and its path is surfaced (`⚠ working tree kept: /tmp/sandbox-XXXX`) so you can inspect what the tool saw. On **pass**, it's auto-cleaned.
- Omit `setup` entirely to run in the live session's `cwd` (the original behavior).

The `tree` sample suite under `tests/tree-fixtures/` demonstrates all of these.

Every file in `fixturesDir` is run (sorted by name). One fixture = one child subprocess.

### Environment variables (`sandbox-env.json`)

The child env is **hermetic by default** (small hardcoded allowlist + `SANDBOX_SCRIPT`, `PI_OFFLINE=1`). To pass through extra vars — e.g. real API keys — declare them in a `sandbox-env.json`:

```jsonc
{
  "allow": ["OPENROUTESERVICE_API_KEY"],   // names only; values come from the parent shell (secrets stay out of files)
  "set":   { "MY_FLAG": "1" }               // explicit values injected unconditionally
}
```

**Locations** (all merged per run; later overrides earlier for `set`):

1. `<extension_sandbox dir>/sandbox-env.json` — beside `index.ts`; resolves via `import.meta.url`, so it **travels with the extension into any project folder**
2. `<project>/sandbox-env.json`
3. `<project>/.pi/sandbox-env.json`

A default file ships beside `index.ts` — edit it in place. Files are **hot-read on every child spawn**: edits apply to the next test, no `/reload`.

Per-fixture overrides (highest precedence): fixture fields `envAllow: ["KEY"]` and `env: {"KEY": "value"}` extend the allow-list / override `set` values for that one test.

Malformed or missing config files are skipped silently.

### Authoring tips

- **Prefer `resultContains` / `resultNotContains` / `resultIsError`** for asserting on the tool's return value. Reserve `outputContains` (with a unique sentinel for `script.text`) for proving the session survived and the follow-up turn completed.
- **Check the `actual:` line on every pass** before trusting a green run — it's the cheapest way to catch a substring assertion that matched the wrong thing.
- For **file-I/O tests**, use `setup.cwd: "temp"` + `setup.files` to declare a self-contained corpus. Don't rely on repo-relative paths; those make the suite non-portable and let the corpus drift.
- For **crash tests**, set `expect.alive: false` and `text` to something unreachable — the child should be killed before emitting it. (No tool result is produced, so don't set `resultContains`/`resultIsError` here.)
- For **input-contract tests**, pass args that violate the tool's schema; set `resultIsError: true` and `resultContains` to the expected validation message fragment (e.g. `"must be equal to one of the allowed values"`) — this proves the schema rejected the args, not just "something errored."
- For **throw tests**, set `resultIsError: true` and `resultContains` to the thrown message fragment. Note pi's real contract: a tool **throws** to surface an error (`isError` in the event stream); returning `isError: true` in the result object is **not** propagated. `resultIsError` asserts on the event-level flag, so throw in your tool.
- Fixtures are plain data — version them with your extension.

### Outcome categories

| Outcome | Meaning |
|---------|---------|
| `pass` | Child behaved as the fixture expects (survived + all assertions hold). |
| `assert-fail` | Child survived, but a `outputContains` / `resultContains` / `resultIsError` assertion failed. The report surfaces the tool's actual return value. |
| `crash` | Child exited non-zero (unexpected, given `alive: true`). |
| `timeout` | Child was killed on timeout (unexpected, given `alive: true`; expected when `alive: false`). |
| `error` | Could not run (e.g. target/fake extension not found). |

## Headless CLI

The orchestrator is also runnable directly, no model needed:

```bash
# one fixture:
node run-sandbox.ts tests/fixtures/boom-safe.json ./fake ./targets/risky-ext.ts 15

# whole suite (dir of *.json):
node run-sandbox.ts tests/fixtures ./fake ./targets/risky-ext.ts 15
```

Prints a per-fixture `[PASS|CRASH|TIMEOUT]` line and exits `0` iff all pass — handy for CI or a git pre-commit hook.

## How it works

```
live session (your dev pi)
  └─ model calls extension_sandbox(extension, fixturesDir)
       └─ for each fixture, runSandbox() spawns a child:
            pi -p --provider sandbox-fake --model fake-1 \
                -e <fake> -e <target> \
                --no-extensions --no-skills --no-prompt-templates \
                --no-themes --no-context-files --no-session \
                "<prompt>"
            env: SANDBOX_SCRIPT=<json>, hermetic allowlist + sandbox-env.json
                passthrough (allow/set, hot-read per run), PI_OFFLINE=1
            └─ fake provider (pi-ai faux) emits the scripted tool call
            └─ pi executes the target's tool for real
            └─ fake emits the final text; pi prints it; child exits
       └─ SIGKILL on timeout; collect PASS/FAIL/CRASH/TIMEOUT
  └─ tool returns aggregated report; live session untouched
```


- **Isolation** = a separate OS process per fixture, killable with `SIGKILL`.
- **Fidelity** = the child is a real `pi` running the real agent loop (schema validation → `execute` → result → follow-up), so it exercises the exact path that would crash a live session.
- **Structured results** = the child runs in `--mode json`, so the orchestrator parses the `tool_execution_end` events and exposes each tool's actual return value + `isError` as `resultContains` / `resultIsError` assertions — independent of the fake's scripted final text.
- **Determinism** = hermetic child env by default (no leaked provider/model/API key), offline, no resource discovery except the two explicit `-e` extensions. Extra vars opt-in via `sandbox-env.json` / fixture `envAllow`+`env` (hot-read per run).
- The fake model is built on `@earendil-works/pi-ai`'s tested **faux** provider (the same one pi's own test suite uses).
```

## Files

| Path | Purpose |
|------|---------|
| `index.ts` | The dev extension. Registers the `extension_sandbox` tool. |
| `run-sandbox.ts` | The orchestrator: spawns the child, kills on timeout, returns `SandboxResult`. Also a headless CLI. Reads `sandbox-env.json` for env passthrough. |
| `sandbox-env.json` | Env passthrough config shipped beside `index.ts`: `{ "allow": [...], "set": {...} }`. Edit in place to activate. Also read from project root and `.pi/`. Hot-read every run. |
| `fake/index.ts` | The scripted fake-model provider (pi-ai faux). Reads `SANDBOX_SCRIPT` env. |
| `targets/risky-ext.ts` | Sample target: a `boom` tool with `safe`/`throw`/`loop` modes. |
| `targets/risky.ts` | Pure logic for `boom`, unit-testable headless. |
| `targets/tree-ext.ts` | Sample target: a `tree` tool — demos temp-dir corpora, `resultNotContains`, the thrown-error contract. |
| `tests/fixtures/*.json` | Repeatable fixtures for the `boom` target. |
| `tests/tree-fixtures/*.json` | Fixtures for `tree` — resettable temp corpora + `resultNotContains`. |

## Sample fixture outcomes

Against `targets/risky-ext.ts`, the `tests/fixtures/` suite (all green):

| Fixture | Tool input | Assertions | Outcome |
|---------|-----------|------------|---------|
| `boom-safe` | `mode: safe` | survives, outputContains sentinel, `resultContains "safe result: 42"`, `resultIsError: false` | PASS |
| `boom-throw` | `mode: throw` | survives (pi catches the throw), `resultContains "deliberate failure"`, `resultIsError: true` | PASS |
| `boom-bad-args` | `mode: bogus` | survives (schema rejects), `resultContains "must be equal to one of the allowed values"`, `resultIsError: true` | PASS |
| `boom-loop` | `mode: loop` | hangs → killed (`alive: false`) | PASS (containment) |

All `tests/fixtures/` pass — meaning the sandbox correctly **contains** every failure mode the target can produce, and asserts on the tool's real return value.