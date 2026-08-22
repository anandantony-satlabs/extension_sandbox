export type BoomResult = { status: "ok" | "crashed"; value?: number };
export function boom(n: number | "loop" | "throw"): BoomResult {
  if (n === "loop") { while (true) {} }
  if (n === "throw") throw new Error("boom: deliberate failure");
  if (typeof n !== "number" || n < 0) throw new Error("boom: invalid argument");
  return { status: "ok", value: n * 2 };
}
