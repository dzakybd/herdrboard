import { expect, test } from "bun:test";
import { parseVerdicts } from "../src/server.ts";

test("--pr values parse into verdicts, and anything else is refused", () => {
  expect(parseVerdicts(["AccentureCodeFoundry/316531_AdTune#1650=changes", "a/b#7=approve"])).toEqual([
    { repo: "AccentureCodeFoundry/316531_AdTune", number: 1650, verdict: "changes" },
    { repo: "a/b", number: 7, verdict: "approve" },
  ]);
  expect(parseVerdicts(undefined)).toEqual([]);
  for (const bad of ["a/b#7", "a/b#x=approve", "a/b#7=merge", "a/b;rm -rf#7=approve"]) expect(() => parseVerdicts([bad])).toThrow();
});
