import assert from "node:assert/strict";
import test from "node:test";

import { filterCompleteOutput, StreamingOutputFilter } from "../src/output-filter.js";

test("filters an assistant seed and a complete stop sequence", () => {
  const result = filterCompleteOutput(
    "<title>Useful title</title>ignored",
    "<title>",
    ["</title>"],
  );
  assert.deepEqual(result, { text: "Useful title", stopped: true });
});

test("filters prefixes and stop sequences split across streaming chunks", () => {
  const emitted: string[] = [];
  const filter = new StreamingOutputFilter(
    "<response>",
    ["</response>"],
    (text) => emitted.push(text),
  );

  for (const chunk of ["<res", "ponse>", "Rewritten", " text</res", "ponse>", "ignored"]) {
    filter.push(chunk);
  }
  filter.finish();

  assert.equal(emitted.join(""), "Rewritten text");
  assert.equal(filter.output, "Rewritten text");
  assert.equal(filter.stopped, true);
});

test("preserves text that only partially resembles a prefix or stop", () => {
  const emitted: string[] = [];
  const filter = new StreamingOutputFilter("<title>", ["</title>"], (text) => emitted.push(text));
  filter.push("ordinary text ending in </tit");
  filter.finish();
  assert.equal(emitted.join(""), "ordinary text ending in </tit");
  assert.equal(filter.stopped, false);
});
