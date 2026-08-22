// Target extension under test: a `boom` tool with safe/throw/loop modes.
// (Reuses the pure logic module so it is also unit-testable headless.)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { boom } from "../targets/risky.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "boom",
    label: "Boom",
    description: "Risk-test tool. Pass mode=safe|throw|loop.",
    parameters: Type.Object({
      mode: Type.String({ enum: ["safe", "throw", "loop"] }),
    }),
    async execute(_id, params) {
      if (params.mode === "loop") {
        boom("loop"); // spin forever
      }
      if (params.mode === "throw") boom("throw");
      const r = boom(21);
      return { content: [{ type: "text", text: `safe result: ${r.value}` }], details: {} };
    },
  });
}