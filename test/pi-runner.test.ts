import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { BridgeConfig } from "../src/config.js";
import { normalizeChatRequest } from "../src/openai.js";
import { PiCompletionRunner } from "../src/pi-runner.js";

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function fakeRunner(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "pi-leo-runner-test-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "AGENTS.md"), "UNTRUSTED_LOCAL_INSTRUCTIONS must not load.");
  const requests: Array<{ context: TranscriptContext; options: SimpleStreamOptions | undefined; maxTokens: number }> = [];
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("bridge-test", {
    api: "bridge-test-api",
    apiKey: "fake-test-key",
    baseUrl: "https://example.invalid",
    models: [{
      id: "fake",
      name: "Fake test model",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 1000,
    }],
    streamSimple(model, context, options) {
      requests.push({ context: structuredClone(context), options, maxTokens: model.maxTokens });
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "pending",
        content: [],
        usage: {
          input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        message.content = [{ type: "text", text: "" }];
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        message.content = [{ type: "text", text: "Bridge reply" }];
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Bridge reply", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "Bridge reply", partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    },
  });
  await runtime.getAvailable("bridge-test");
  t.mock.method(ModelRuntime, "create", async () => runtime);
  const config: BridgeConfig = {
    version: 1,
    host: "127.0.0.1",
    port: 43127,
    tokenSha256: "0".repeat(64),
    publicModelId: "pi-test",
    provider: "bridge-test",
    modelId: "fake",
    thinkingLevel: "off",
    profiles: [{ publicModelId: "pi-test", thinkingLevel: "off" }],
    workspace,
    agentDir: join(workspace, "agent"),
    maxBodyBytes: 1024 * 1024,
    maxConcurrentRequests: 2,
  };
  return { runner: await PiCompletionRunner.create(config), requests, workspace };
}

test("Pi SDK receives restored multimodal history and a tool-free isolated prompt", async (t) => {
  const { runner, requests, workspace } = await fakeRunner(t);
  const conversation = normalizeChatRequest({
    model: "pi-test",
    max_tokens: 123,
    messages: [
      { role: "system", content: "Use the page context." },
      { role: "user", content: [
        { type: "text", text: "Earlier question" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${onePixelPng}` } },
      ] },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Follow-up question" },
    ],
  });
  const deltas: string[] = [];
  const result = await runner.complete(conversation, (text) => deltas.push(text), new AbortController().signal);
  assert.equal(result.text, "Bridge reply");
  assert.equal(deltas.join(""), "Bridge reply");
  assert.deepEqual(result.usage, { input: 10, output: 2, total: 12 });
  assert.equal(requests.length, 1);
  const { context, maxTokens } = requests[0]!;
  const messages = context.messages.filter((message) => message.role !== "system");
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.deepEqual(messages[0]?.content, [
    { type: "text", text: "Earlier question" },
    { type: "image", data: onePixelPng, mimeType: "image/png" },
  ]);
  assert.deepEqual(messages[1]?.content, [{ type: "text", text: "Earlier answer" }]);
  assert.deepEqual(messages[2]?.content, [{ type: "text", text: "Follow-up question" }]);
  assert.deepEqual(getCurrentTools(context.messages), []);
  assert.match(getCurrentSystemPrompt(context.messages), /Use the page context/);
  assert.match(getCurrentSystemPrompt(context.messages), /untrusted reference material/);
  assert.doesNotMatch(getCurrentSystemPrompt(context.messages), /UNTRUSTED_LOCAL_INSTRUCTIONS/);
  assert.equal(maxTokens, 123);
  assert.deepEqual(await readdir(workspace), ["AGENTS.md"]);
});

test("reported brace-expansion payloads remain literal data in the tool-free SDK", async (t) => {
  const { runner, requests } = await fakeRunner(t);
  // The public advisories describe parser-side failures, not large expansion sets.
  const payloads = [
    "{".repeat(3200) + "a,b" + "}".repeat(3200),
    "{a,".repeat(4000) + "z" + "}".repeat(4000),
    "{" + "{a},".repeat(7000) + "b}",
    "{a}" + "}".repeat(16000) + ",z}",
  ];
  for (const payload of payloads) {
    const conversation = normalizeChatRequest({
      model: "pi-test",
      stop: "*{literal,stop}",
      messages: [
        { role: "system", content: payload },
        { role: "developer", content: payload },
        { role: "user", content: payload },
        { role: "assistant", content: payload },
        { role: "user", content: payload },
        { role: "assistant", content: payload },
      ],
    });
    const result = await runner.complete(conversation, () => {}, new AbortController().signal);
    assert.equal(result.text, "Bridge reply");
    const context = requests.at(-1)!.context;
    const messages = context.messages.filter((message) => message.role !== "system");
    const text = (content: typeof messages[number]["content"]) => typeof content === "string"
      ? content
      : content.filter((part) => part.type === "text").map((part) => part.text).join("");
    assert.equal(messages.length, 3);
    assert.equal(text(messages[0]!.content), payload);
    assert.equal(text(messages[1]!.content), payload);
    assert.equal(text(messages[2]!.content), conversation.prompt.text);
    assert.ok(getCurrentSystemPrompt(context.messages).includes(payload));
    assert.deepEqual(getCurrentTools(context.messages), []);
  }
  assert.equal(requests.length, payloads.length);
});

test("each Pi completion has fresh in-memory history and a distinct session ID", async (t) => {
  const { runner, requests } = await fakeRunner(t);
  for (const text of ["First private conversation", "Separate conversation"]) {
    await runner.complete(normalizeChatRequest({
      model: "pi-test",
      messages: [{ role: "user", content: text }],
    }), () => {}, new AbortController().signal);
  }
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.options?.sessionId, requests[1]?.options?.sessionId);
  assert.ok(requests[0]?.options?.sessionId);
  const second = requests[1]!.context.messages.filter((message) => message.role !== "system");
  assert.equal(second.length, 1);
  assert.deepEqual(second[0]?.content, [{ type: "text", text: "Separate conversation" }]);
  assert.deepEqual(getCurrentTools(requests[1]!.context.messages), []);
});
