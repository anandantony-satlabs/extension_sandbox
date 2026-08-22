// Fake scripted model provider — drives a target extension's tools with a
// fully scripted "LLM": no network, no API key, no cost. Built on pi-ai's
// battle-tested faux provider (the same one pi's own test suite uses).
//
// The script (one tool call + final reply text) arrives via the SANDBOX_SCRIPT
// env var, which run-sandbox.ts sets per fixture. createFauxCore shifts one
// queued response per model call, so the real tool-execution -> follow-up
// loop is driven exactly:
//   turn 1: emit the scripted tool call (stopReason: "toolUse") -> pi runs it
//   turn 2: emit the final text (stopReason: "stop") -> pi prints and exits
//
// Special `__discover` mode: emit a single text turn whose content is JSON
// listing every tool the target registered (name, description, sampleArgs),
// so the orchestrator can scaffold starter fixtures. No tool is executed.
//
// Loaded by the throwaway child `pi` subprocess that run-sandbox.ts spawns.
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Script = {
  // Discovery mode: emit the registered tool list as JSON instead of a call.
  __discover?: boolean;
  // Tool the target extension registered. If omitted, skip straight to text.
  tool?: string;
  // Arguments for the tool call.
  args?: Record<string, unknown>;
  // Final reply text (also used when `tool` is omitted).
  text?: string;
};

function loadScript(): Script {
  const raw = process.env.SANDBOX_SCRIPT;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Script;
  } catch {
    return {};
  }
}

// Generate a placeholder value for a typebox parameter schema, preferring
// the first enum value when one is available so templates are immediately
// runnable. Only required fields are populated (optionals omitted), matching
// how Create() behaves but without the dependency.
function sampleFor(node: unknown): unknown {
  if (!node || typeof node !== "object") return null;
  const n = node as Record<string, unknown> & { anyOf?: unknown[] };
  if (Array.isArray(n.enum) && n.enum.length > 0) return n.enum[0];
  if (n.anyOf && Array.isArray(n.anyOf)) {
    for (const sub of n.anyOf) {
      const v = sampleFor(sub);
      if (v !== null && v !== undefined) return v;
    }
  }
  const t = n.type;
  if (t === "object" && n.properties && typeof n.properties === "object") {
    const required = new Set(Array.isArray(n.required) ? (n.required as unknown[]) : []);
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(n.properties as Record<string, unknown>)) {
      if (required.has(k)) {
        const v = sampleFor(sub);
        if (v !== null && v !== undefined) out[k] = v;
      }
    }
    return out;
  }
  if (t === "array" && n.items) {
    const v = sampleFor(n.items);
    return v === null ? [] : [v];
  }
  if (t === "string") return "";
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return false;
  return null;
}

const MODEL = {
  id: "fake-1",
  name: "Fake Scripted Model",
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64000,
  maxTokens: 4096,
};

export default function (pi: ExtensionAPI) {
  const script = loadScript();

  // `api`/`provider` here must match what we register below; faux stamps every
  // emitted message with these so the child's records are self-consistent.
  const core = createFauxCore({
    api: "sandbox-scripted",
    provider: "sandbox-fake",
  });

  let responses;
  if (script.__discover) {
    // Discovery is a factory: deferred until the first model call, so the
    // target has finished loading and registered its tools into context.tools.
    // Emits a single text turn whose content is JSON: { tools: [...] }.
    responses = [
      (context: unknown) => {
        const ctx = context as { tools?: { name: string; description: string; parameters: unknown }[] };
        const tools = (ctx.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          sampleArgs: sampleFor(tool.parameters),
        }));
        return fauxAssistantMessage(JSON.stringify({ tools }), { stopReason: "stop" });
      },
    ];
  } else {
    responses = [];
    if (script.tool) {
      responses.push(
        fauxAssistantMessage([fauxToolCall(script.tool, script.args ?? {})], {
          stopReason: "toolUse",
        }),
      );
    }
    responses.push(
      fauxAssistantMessage(script.text ?? "sandbox: done", { stopReason: "stop" }),
    );
  }
  core.setResponses(responses);

  pi.registerProvider("sandbox-fake", {
    baseUrl: "http://sandbox.invalid/v1",
    apiKey: "sk-sandbox-fake",
    api: core.api,
    models: [MODEL],
    streamSimple: core.streamSimple,
  });
}
