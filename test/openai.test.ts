import assert from "node:assert/strict";
import test from "node:test";

import { normalizeChatRequest, RequestError } from "../src/openai.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("normalizes a Brave-style multimodal conversation and ignores temperature", () => {
  const result = normalizeChatRequest({
    model: "pi-gpt-5.6-sol",
    temperature: 0.7,
    max_tokens: 321,
    stream: true,
    messages: [
      { role: "system", content: [{ type: "text", text: "Be concise." }] },
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${onePixelPng}` } },
        ],
      },
    ],
  });

  assert.equal(result.requestedModel, "pi-gpt-5.6-sol");
  assert.equal(result.stream, true);
  assert.equal(result.systemInstructions, "Be concise.");
  assert.equal(result.maxOutputTokens, 321);
  assert.deepEqual(result.history.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "First question" },
    { role: "assistant", text: "First answer" },
  ]);
  assert.equal(result.prompt.text, "What is in this image?");
  assert.equal(result.prompt.images.length, 1);
  assert.equal(result.prompt.images[0]?.mimeType, "image/png");
});

test("does not fetch remote images", () => {
  const result = normalizeChatRequest({
    model: "pi-gpt-5.6-sol",
    messages: [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/private.png" } }],
      },
    ],
  });

  assert.equal(result.prompt.images.length, 0);
  assert.match(result.prompt.text, /only accepts embedded/);
});

test("rejects tool definitions", () => {
  assert.throws(
    () => normalizeChatRequest({
      model: "pi-gpt-5.6-sol",
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ type: "function", function: { name: "danger" } }],
    }),
    (error: unknown) => error instanceof RequestError && error.code === "tools_disabled",
  );
});

test("supports Brave assistant-prefix requests for titles and rewrites", () => {
  const result = normalizeChatRequest({
    model: "pi-gpt-5.6-sol",
    stop: ["</title>"],
    messages: [
      { role: "user", content: "Discussing local browser integration" },
      { role: "assistant", content: "Here is the title in <title> tags:\n<title>" },
    ],
  });

  assert.equal(result.assistantPrefix, "Here is the title in <title> tags:\n<title>");
  assert.deepEqual(result.stopSequences, ["</title>"]);
  assert.match(result.prompt.text, /Discussing local browser integration/);
  assert.match(result.prompt.text, /return only the text that follows/);
  assert.equal(result.history.length, 0);
});

test("rejects invalid output-token limits", () => {
  assert.throws(
    () => normalizeChatRequest({
      model: "pi-gpt-5.6-sol",
      max_completion_tokens: 0,
      messages: [{ role: "user", content: "Hello" }],
    }),
    (error: unknown) => error instanceof RequestError && error.code === "unsupported_parameter",
  );
});

test("rejects a conversation with no user message", () => {
  assert.throws(
    () => normalizeChatRequest({
      model: "pi-gpt-5.6-sol",
      messages: [{ role: "assistant", content: "Hello" }],
    }),
    (error: unknown) => error instanceof RequestError && error.code === "invalid_messages",
  );
});
