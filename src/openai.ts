export interface EmbeddedImage {
  data: string;
  mimeType: string;
}

export interface NormalizedTurn {
  role: "user" | "assistant";
  text: string;
  images: EmbeddedImage[];
}

export interface NormalizedConversation {
  requestedModel: string;
  stream: boolean;
  systemInstructions: string;
  assistantPrefix: string | null;
  stopSequences: string[];
  maxOutputTokens: number | null;
  history: NormalizedTurn[];
  prompt: NormalizedTurn;
  messageCount: number;
  textCharacters: number;
}

export interface CompletionUsage {
  input: number;
  output: number;
  total: number;
}

export interface CompletionResult {
  text: string;
  finishReason: "stop" | "length";
  usage: CompletionUsage;
}

export interface CompletionProfile {
  publicModelId: string;
  thinkingLevel: string;
}

export interface CompletionRunner {
  readonly provider: string;
  readonly modelId: string;
  readonly profiles: readonly CompletionProfile[];
  complete(
    conversation: NormalizedConversation,
    onTextDelta: (delta: string) => void,
    signal: AbortSignal,
  ): Promise<CompletionResult>;
}

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDataImage(url: string): EmbeddedImage | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const encoded = match[2].replace(/\s/g, "");
  if (encoded.length === 0 || encoded.length % 4 === 1) {
    return undefined;
  }

  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 || decoded.length > 8 * 1024 * 1024) {
    return undefined;
  }

  return {
    data: decoded.toString("base64"),
    mimeType: match[1].toLowerCase(),
  };
}

function normalizeContent(content: unknown): { text: string; images: EmbeddedImage[] } {
  if (typeof content === "string") {
    return { text: content, images: [] };
  }
  if (content === null || content === undefined) {
    return { text: "", images: [] };
  }
  if (!Array.isArray(content)) {
    throw new RequestError(400, "invalid_messages", "Message content must be text or an array of content blocks");
  }

  const textParts: string[] = [];
  const images: EmbeddedImage[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
      continue;
    }
    if (!isRecord(block)) {
      continue;
    }

    const type = block.type;
    if ((type === "text" || type === "input_text") && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }

    if (type === "image_url" || type === "input_image") {
      let url: string | undefined;
      if (typeof block.image_url === "string") {
        url = block.image_url;
      } else if (isRecord(block.image_url) && typeof block.image_url.url === "string") {
        url = block.image_url.url;
      } else if (typeof block.image_url === "undefined" && typeof block.url === "string") {
        url = block.url;
      }

      if (url) {
        const image = parseDataImage(url);
        if (image) {
          images.push(image);
        } else {
          textParts.push("[An image URL was supplied, but the local bridge only accepts embedded PNG, JPEG, WebP, or GIF data images.]");
        }
      }
    }
  }

  return { text: textParts.join("\n"), images };
}

function normalizeMaxOutputTokens(body: Record<string, unknown>): number | null {
  const value = body.max_completion_tokens ?? body.max_tokens;
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000_000) {
    throw new RequestError(400, "unsupported_parameter", "max_tokens must be a positive integer");
  }
  return value as number;
}

function normalizeStopSequences(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) {
    throw new RequestError(400, "unsupported_parameter", "stop must be a string or an array of strings");
  }
  const stops = (values as string[]).filter((item) => item.length > 0);
  if (stops.length > 16 || stops.some((item) => item.length > 1000)) {
    throw new RequestError(400, "unsupported_parameter", "Too many or excessively long stop sequences");
  }
  return stops;
}

export function normalizeChatRequest(body: unknown): NormalizedConversation {
  if (!isRecord(body)) {
    throw new RequestError(400, "invalid_request", "The request body must be a JSON object");
  }
  if (typeof body.model !== "string" || body.model.trim() === "") {
    throw new RequestError(400, "invalid_model", "A model name is required");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestError(400, "invalid_messages", "At least one message is required");
  }
  if (body.messages.length > 200) {
    throw new RequestError(400, "invalid_messages", "Too many messages");
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw new RequestError(400, "tools_disabled", "Tools are disabled for this bridge profile");
  }
  if (typeof body.n === "number" && body.n !== 1) {
    throw new RequestError(400, "unsupported_parameter", "Only one completion is supported");
  }

  const parsed = body.messages.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.role !== "string") {
      throw new RequestError(400, "invalid_messages", `Invalid message at index ${index}`);
    }
    const normalized = normalizeContent(raw.content);
    return { role: raw.role, ...normalized };
  });

  let finalConversationIndex = -1;
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const message = parsed[index];
    if (
      message
      && (message.role === "user" || message.role === "assistant")
      && (message.text !== "" || message.images.length > 0)
    ) {
      finalConversationIndex = index;
      break;
    }
  }
  if (finalConversationIndex < 0) {
    throw new RequestError(400, "invalid_messages", "The conversation must contain a user message");
  }

  const finalConversationMessage = parsed[finalConversationIndex];
  if (!finalConversationMessage) {
    throw new RequestError(400, "invalid_messages", "The conversation is empty");
  }
  let lastUserIndex = finalConversationIndex;
  let assistantPrefix: string | null = null;
  if (finalConversationMessage.role === "assistant") {
    assistantPrefix = finalConversationMessage.text;
    for (let index = finalConversationIndex - 1; index >= 0; index -= 1) {
      if (parsed[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
  }
  if (parsed[lastUserIndex]?.role !== "user") {
    throw new RequestError(400, "invalid_messages", "The conversation must contain a user message");
  }

  const systemInstructions = parsed
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => message.text)
    .filter(Boolean)
    .join("\n\n");

  const history: NormalizedTurn[] = [];
  for (const message of parsed.slice(0, lastUserIndex)) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    if (message.text === "" && message.images.length === 0) {
      continue;
    }
    history.push({
      role: message.role,
      text: message.text,
      images: message.role === "user" ? message.images : [],
    });
  }

  const latest = parsed[lastUserIndex];
  if (!latest) {
    throw new RequestError(400, "invalid_messages", "The conversation must contain a user message");
  }
  let promptText = latest.text || (latest.images.length > 0 ? "Please respond to the attached image." : "");
  if (assistantPrefix !== null) {
    promptText += `\n\n[Local bridge continuation instruction]\nThe assistant response has already begun with the exact prefix below. Continue it and return only the text that follows the prefix; do not repeat the prefix.\n\n${assistantPrefix}`;
  }
  const prompt: NormalizedTurn = {
    role: "user",
    text: promptText,
    images: latest.images,
  };
  if (prompt.text === "" && prompt.images.length === 0) {
    throw new RequestError(400, "invalid_messages", "The final user message is empty");
  }

  return {
    requestedModel: body.model,
    stream: body.stream === true,
    systemInstructions,
    assistantPrefix,
    stopSequences: normalizeStopSequences(body.stop),
    maxOutputTokens: normalizeMaxOutputTokens(body),
    history,
    prompt,
    messageCount: parsed.length,
    textCharacters: parsed.reduce((total, message) => total + message.text.length, 0),
  };
}
