import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export interface BridgeProfile {
  publicModelId: string;
  thinkingLevel: ThinkingLevel;
}

export interface BridgeConfig {
  version: 1;
  host: "127.0.0.1";
  port: number;
  tokenSha256: string;
  publicModelId: string;
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  profiles: BridgeProfile[];
  workspace: string;
  agentDir: string;
  maxBodyBytes: number;
  maxConcurrentRequests: number;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid configuration field: ${name}`);
  }
  return value;
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Invalid configuration field: ${name}`);
  }
  return value as number;
}

export function defaultConfigPath(): string {
  return resolve(homedir(), ".config", "pi-leo-bridge", "config.json");
}

function loadProfiles(
  value: unknown,
  fallbackModelId: string,
  fallbackThinkingLevel: ThinkingLevel,
): BridgeProfile[] {
  if (value === undefined) {
    return [{ publicModelId: fallbackModelId, thinkingLevel: fallbackThinkingLevel }];
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error("Invalid configuration field: profiles");
  }

  const profiles = value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Invalid configuration profile at index ${index}`);
    }
    const profile = item as Record<string, unknown>;
    const publicModelId = requireString(profile.publicModelId, `profiles[${index}].publicModelId`);
    const level = requireString(profile.thinkingLevel, `profiles[${index}].thinkingLevel`);
    if (!(thinkingLevels as readonly string[]).includes(level)) {
      throw new Error(`Invalid configuration profile thinking level at index ${index}`);
    }
    return { publicModelId, thinkingLevel: level as ThinkingLevel };
  });
  if (new Set(profiles.map((profile) => profile.publicModelId)).size !== profiles.length) {
    throw new Error("Configuration profile model names must be unique");
  }
  return profiles;
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (raw.version !== 1) {
    throw new Error("Unsupported bridge configuration version");
  }
  if (raw.host !== "127.0.0.1") {
    throw new Error("The bridge must bind to 127.0.0.1");
  }

  const tokenSha256 = requireString(raw.tokenSha256, "tokenSha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(tokenSha256)) {
    throw new Error("Invalid configuration field: tokenSha256");
  }

  const thinkingLevel = requireString(raw.thinkingLevel, "thinkingLevel");
  if (!(thinkingLevels as readonly string[]).includes(thinkingLevel)) {
    throw new Error("Invalid configuration field: thinkingLevel");
  }
  const publicModelId = requireString(raw.publicModelId, "publicModelId");
  const profiles = loadProfiles(raw.profiles, publicModelId, thinkingLevel as ThinkingLevel);
  if (!profiles.some((profile) => profile.publicModelId === publicModelId)) {
    throw new Error("The primary publicModelId must appear in profiles");
  }

  return {
    version: 1,
    host: "127.0.0.1",
    port: requireInteger(raw.port, "port", 1024, 65535),
    tokenSha256,
    publicModelId,
    provider: requireString(raw.provider, "provider"),
    modelId: requireString(raw.modelId, "modelId"),
    thinkingLevel: thinkingLevel as ThinkingLevel,
    profiles,
    workspace: resolve(requireString(raw.workspace, "workspace")),
    agentDir: resolve(requireString(raw.agentDir, "agentDir")),
    maxBodyBytes: requireInteger(raw.maxBodyBytes, "maxBodyBytes", 1024, 64 * 1024 * 1024),
    maxConcurrentRequests: requireInteger(raw.maxConcurrentRequests, "maxConcurrentRequests", 1, 16),
  };
}
