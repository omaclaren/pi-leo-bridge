import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import type { BridgeConfig } from "../src/config.js";
import type { CompletionRunner } from "../src/openai.js";
import { createBridgeServer } from "../src/server.js";

const token = "test-token-that-is-not-installed";
const config: BridgeConfig = {
  version: 1,
  host: "127.0.0.1",
  port: 43127,
  tokenSha256: createHash("sha256").update(token).digest("hex"),
  publicModelId: "pi-gpt-5.6-sol",
  provider: "test",
  modelId: "fake",
  thinkingLevel: "off",
  profiles: [
    { publicModelId: "pi-gpt-5.6-sol", thinkingLevel: "off" },
    { publicModelId: "pi-gpt-5.6-sol-high", thinkingLevel: "high" },
  ],
  workspace: "/tmp/pi-leo-bridge-test",
  agentDir: "/tmp/pi-leo-bridge-test-agent",
  maxBodyBytes: 1024 * 1024,
  maxConcurrentRequests: 2,
};

const runner: CompletionRunner = {
  provider: "test",
  modelId: "fake",
  profiles: config.profiles,
  async complete(conversation, onTextDelta) {
    assert.equal(conversation.prompt.text, "Hello");
    onTextDelta("Hello ");
    onTextDelta("from Pi");
    return {
      text: "Hello from Pi",
      finishReason: "stop",
      usage: { input: 4, output: 3, total: 7 },
    };
  },
};

const quietLogger = { info() {}, warn() {}, error() {} };
const bridge = createBridgeServer(config, runner, quietLogger);
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(0, "127.0.0.1", resolve);
  });
  const address = bridge.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
});

test("public health endpoint reveals only service availability", async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body, { status: "ok", service: "pi-leo-bridge" });
});

test("authenticated health endpoint reports the isolated profile", async () => {
  const response = await fetch(`${baseUrl}/auth/${token}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.status, "ok");
  assert.equal(body.tools, "disabled");
  assert.equal(body.model, "fake");
  assert.deepEqual(body.profiles, config.profiles);
});

test("wrong capability token is indistinguishable from an unknown route", async () => {
  const response = await fetch(`${baseUrl}/auth/wrong/v1/chat/completions`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 404);
});

test("returns a non-streaming OpenAI-compatible completion", async () => {
  const response = await fetch(`${baseUrl}/auth/${token}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "pi-gpt-5.6-sol",
      temperature: 0.7,
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage: { total_tokens: number };
  };
  assert.equal(body.choices[0]?.message.content, "Hello from Pi");
  assert.equal(body.usage.total_tokens, 7);
});

test("streams OpenAI-compatible SSE chunks", async () => {
  const response = await fetch(`${baseUrl}/auth/${token}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "pi-gpt-5.6-sol",
      stream: true,
      temperature: 0.7,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const text = await response.text();
  assert.match(text, /"content":"Hello "/);
  assert.match(text, /"content":"from Pi"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});

test("rejects an unexpected public model name", async () => {
  const response = await fetch(`${baseUrl}/auth/${token}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "some-other-model",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  assert.equal(response.status, 404);
});
