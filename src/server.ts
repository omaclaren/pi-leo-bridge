import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { BridgeConfig } from "./config.js";
import {
  type CompletionResult,
  type CompletionRunner,
  type NormalizedConversation,
  normalizeChatRequest,
  RequestError,
} from "./openai.js";

export interface BridgeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface BridgeServer {
  server: Server;
  activeRequests(): number;
}

function safeError(error: unknown): string {
  if (error instanceof RequestError) {
    return `${error.code}: ${error.message}`.replace(/[\r\n]+/g, " ").slice(0, 300);
  }

  const name = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message : "";
  let category = "internal_error";
  if (/abort/i.test(message) || name === "AbortError") {
    category = "aborted";
  } else if (/auth|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(message)) {
    category = "provider_authentication";
  } else if (/rate.?limit|quota|usage.?limit|\b429\b/i.test(message)) {
    category = "provider_limit";
  } else if (/context|too many tokens|prompt is too long/i.test(message)) {
    category = "context_limit";
  } else if (/timeout|timed out/i.test(message) || name === "TimeoutError") {
    category = "timeout";
  } else if (/network|fetch failed|ECONN|ENOTFOUND|socket/i.test(message)) {
    category = "network";
  } else if (/not registered|not available/i.test(message)) {
    category = "model_unavailable";
  }
  // Provider errors can echo request text. Log only a category, never the raw message.
  return `${name}:${category}`;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

function writeError(res: ServerResponse, error: RequestError): void {
  writeJson(res, error.status, {
    error: {
      message: error.message,
      type: "invalid_request_error",
      param: null,
      code: error.code,
    },
  });
}

async function readJsonBody(req: IncomingMessage, maximumBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on("aborted", () => reject(new RequestError(400, "request_aborted", "Request body was aborted")));
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) {
        reject(new RequestError(413, "request_too_large", "Request body is too large"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RequestError(400, "invalid_json", "Request body is not valid JSON"));
      }
    });
  });
}

function tokenMatches(candidate: string, expectedHex: string): boolean {
  const actual = createHash("sha256").update(candidate, "utf8").digest();
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function completionId(): string {
  return `chatcmpl-pi-${randomUUID().replaceAll("-", "")}`;
}

function openAICompletion(
  id: string,
  created: number,
  model: string,
  result: CompletionResult,
): unknown {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        logprobs: null,
        finish_reason: result.finishReason,
      },
    ],
    usage: {
      prompt_tokens: result.usage.input,
      completion_tokens: result.usage.output,
      total_tokens: result.usage.total,
    },
  };
}

function streamChunk(
  res: ServerResponse,
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): void {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function extractAuthorizedRoute(
  pathname: string,
): { token: string; route: "chat" | "health" } | undefined {
  const match = /^\/auth\/([^/]+)\/(v1\/chat\/completions|healthz)$/.exec(pathname);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  try {
    return {
      token: decodeURIComponent(match[1]),
      route: match[2] === "healthz" ? "health" : "chat",
    };
  } catch {
    return undefined;
  }
}

export function createBridgeServer(
  config: BridgeConfig,
  runner: CompletionRunner,
  logger: BridgeLogger = console,
): BridgeServer {
  let active = 0;
  let pending = 0;
  const startedAt = Date.now();

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const requestUrl = new URL(req.url ?? "/", `http://${config.host}:${config.port}`);

    if (req.method === "GET" && requestUrl.pathname === "/healthz") {
      writeJson(res, 200, { status: "ok", service: "pi-leo-bridge" });
      return;
    }

    const authorizedRoute = extractAuthorizedRoute(requestUrl.pathname);
    if (!authorizedRoute || !tokenMatches(authorizedRoute.token, config.tokenSha256)) {
      writeJson(res, 404, { error: { message: "Not found", type: "not_found_error", code: "not_found" } });
      return;
    }
    if (authorizedRoute.route === "health") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        writeJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error", code: "method_not_allowed" } });
        return;
      }
      writeJson(res, 200, {
        status: "ok",
        service: "pi-leo-bridge",
        version: 1,
        provider: runner.provider,
        model: runner.modelId,
        profiles: runner.profiles,
        tools: "disabled",
        activeRequests: active,
        pendingRequests: pending,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      writeJson(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error", code: "method_not_allowed" } });
      return;
    }
    if (active + pending >= config.maxConcurrentRequests) {
      writeJson(res, 429, { error: { message: "The local Pi bridge is busy", type: "rate_limit_error", code: "bridge_busy" } });
      return;
    }

    pending += 1;
    let body: unknown;
    try {
      body = await readJsonBody(req, config.maxBodyBytes);
    } catch (error) {
      pending -= 1;
      if (error instanceof RequestError) {
        writeError(res, error);
      } else {
        writeJson(res, 400, { error: { message: "Could not read request", type: "invalid_request_error", code: "invalid_request" } });
      }
      return;
    }

    let conversation: NormalizedConversation;
    try {
      conversation = normalizeChatRequest(body);
      if (!runner.profiles.some((profile) => profile.publicModelId === conversation.requestedModel)) {
        throw new RequestError(404, "model_not_found", `Unknown model: ${conversation.requestedModel}`);
      }
    } catch (error) {
      pending -= 1;
      if (error instanceof RequestError) {
        writeError(res, error);
      } else {
        writeJson(res, 400, { error: { message: "Invalid request", type: "invalid_request_error", code: "invalid_request" } });
      }
      return;
    }

    pending -= 1;
    active += 1;
    const id = completionId();
    const created = Math.floor(Date.now() / 1000);
    const requestStartedAt = Date.now();
    const abortController = new AbortController();
    let completed = false;
    res.on("close", () => {
      if (!completed) {
        abortController.abort(new Error("Client disconnected"));
      }
    });

    logger.info(
      `${new Date().toISOString()} request=${id} profile=${conversation.requestedModel} messages=${conversation.messageCount} chars=${conversation.textCharacters} stream=${conversation.stream}`,
    );

    try {
      if (!conversation.stream) {
        const result = await runner.complete(conversation, () => {}, abortController.signal);
        completed = true;
        writeJson(res, 200, openAICompletion(id, created, conversation.requestedModel, result));
      } else {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        res.flushHeaders();
        streamChunk(res, id, created, conversation.requestedModel, { role: "assistant" }, null);

        let emitted = "";
        const keepAlive = setInterval(() => {
          if (!res.destroyed) {
            res.write(": keep-alive\n\n");
          }
        }, 15_000);
        keepAlive.unref();

        try {
          const result = await runner.complete(
            conversation,
            (delta) => {
              if (!res.destroyed && delta !== "") {
                emitted += delta;
                streamChunk(res, id, created, conversation.requestedModel, { content: delta }, null);
              }
            },
            abortController.signal,
          );

          if (!res.destroyed && result.text.startsWith(emitted) && result.text.length > emitted.length) {
            const suffix = result.text.slice(emitted.length);
            emitted += suffix;
            streamChunk(res, id, created, conversation.requestedModel, { content: suffix }, null);
          } else if (!res.destroyed && emitted === "" && result.text !== "") {
            emitted = result.text;
            streamChunk(res, id, created, conversation.requestedModel, { content: result.text }, null);
          }

          if (!res.destroyed) {
            streamChunk(res, id, created, conversation.requestedModel, {}, result.finishReason);
            res.write("data: [DONE]\n\n");
            completed = true;
            res.end();
          }
        } finally {
          clearInterval(keepAlive);
        }
      }

      logger.info(
        `${new Date().toISOString()} request=${id} completed_ms=${Date.now() - requestStartedAt}`,
      );
    } catch (error) {
      if (abortController.signal.aborted || res.destroyed) {
        logger.info(`${new Date().toISOString()} request=${id} aborted`);
      } else {
        logger.error(`${new Date().toISOString()} request=${id} failed=${safeError(error)}`);
        if (!res.headersSent) {
          writeJson(res, 502, {
            error: {
              message: "Pi could not complete the request; check pi-leo logs",
              type: "api_error",
              code: "pi_request_failed",
            },
          });
        } else {
          streamChunk(
            res,
            id,
            created,
            conversation.requestedModel,
            { content: "\n\n[Pi could not complete this response. Check `pi-leo logs`.]" },
            null,
          );
          streamChunk(res, id, created, conversation.requestedModel, {}, "stop");
          res.write("data: [DONE]\n\n");
          completed = true;
          res.end();
        }
      }
    } finally {
      active -= 1;
    }
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      logger.error(`${new Date().toISOString()} request_handler_failed=${safeError(error)}`);
      if (res.destroyed) {
        return;
      }
      try {
        if (!res.headersSent) {
          writeJson(res, 500, {
            error: {
              message: "The local Pi bridge could not process the request",
              type: "api_error",
              code: "internal_error",
            },
          });
        } else {
          res.destroy();
        }
      } catch {
        res.destroy();
      }
    });
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    activeRequests: () => active + pending,
  };
}
