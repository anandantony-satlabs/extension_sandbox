// Sample target: a minimal `tree` tool that lists files under a path,
// skipping dotfiles. Used to demo resettable temp-dir corpora, resultNotContains,
// and the actual-result-on-pass report. (Inspired by the user's real `tree` work.)
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function walk(root: string, base: string, out: string[], skipDots: boolean): void {
  let entries;
  try {
    entries = readdirSync(root).sort();
  } catch {
    throw new Error(`cannot read directory: ${root}`);
  }
  for (const name of entries) {
    if (skipDots && name.startsWith(".")) continue;
    const full = join(root, name);
    const rel = relative(base, full);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, base, out, skipDots);
    } else {
      out.push(rel);
    }
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "tree",
    label: "Tree",
    description: "List files under a path, skipping dotfiles. Returns a newline-separated list, or an error if the path is missing or not a directory.",
    parameters: Type.Object({
      path: Type.String({ description: "Directory to list (relative to cwd)." }),
    }),
    async execute(_id, params) {
      let st;
      try {
        st = statSync(params.path);
      } catch {
        // pi's contract: throw to surface a tool error (a returned isError:true
        // is NOT propagated to the event-level isError flag).
        throw new Error(`path not found: ${params.path}`);
      }
      if (!st.isDirectory()) {
        throw new Error(`not a directory: ${params.path}`);
      }
      const out: string[] = [];
      walk(params.path, params.path, out, true);
      return {
        content: [{ type: "text", text: out.join("\n") }],
        details: { count: out.length },
      };
    },
  });
}
