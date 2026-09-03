import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const project = resolve(process.cwd());
const configureScript = join(project, "scripts", "configure-install.py");
const removeScript = join(project, "scripts", "remove-brave-models.py");
const setDefaultScript = join(project, "scripts", "set-brave-default.py");
const installScript = join(project, "scripts", "install.sh");

interface Fixture {
  root: string;
  home: string;
  preferences: string;
  config: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-leo-installer-"));
  const home = join(root, "home");
  const profile = join(
    home,
    "Library",
    "Application Support",
    "BraveSoftware",
    "Brave-Browser",
    "Default",
  );
  await mkdir(profile, { recursive: true });
  await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
  const preferences = join(profile, "Preferences");
  await writeFile(
    preferences,
    JSON.stringify({
      brave: {
        ai_chat: {
          default_model_key: "custom:gemini",
          custom_models: [
            {
              key: "custom:gemini",
              label: "Gemini fixture",
              model_request_name: "gemini-fixture",
              endpoint_url: "https://example.invalid/v1/chat/completions",
              api_key: "encrypted-fixture-value",
              supports_tools: false,
            },
            {
              key: "custom:unrelated-pi",
              label: "Unrelated Pi endpoint",
              model_request_name: "pi-unrelated",
              endpoint_url: `http://127.0.0.1:43127/auth/${"A".repeat(43)}/v1/chat/completions`,
              api_key: "another-encrypted-fixture-value",
              supports_tools: false,
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  return {
    root,
    home,
    preferences,
    config: join(home, ".config", "pi-leo-bridge", "config.json"),
  };
}

function runPython(home: string, script: string, args: string[]): string {
  const result = spawnSync("python3", [script, ...args], {
    cwd: project,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function configure(f: Fixture, extra: string[] = []): string {
  return runPython(f.home, configureScript, [
    "--project",
    project,
    "--node",
    process.execPath,
    "--preferences",
    f.preferences,
    ...extra,
  ]);
}

async function mockInstallerCommands(root: string): Promise<string> {
  const directory = join(root, "mock-bin");
  await mkdir(directory, { recursive: true });
  const state = join(root, "mock-launchctl-state");
  const scripts: Record<string, string> = {
    node: `#!/bin/bash\nif [[ "$1" == *"/dist/src/check-model.js" ]]; then\n  if [[ "\${PI_LEO_MOCK_MODEL_FAIL:-0}" == "1" ]]; then\n    echo 'Pi authentication is not configured for provider: openai-codex' >&2\n    exit 43\n  fi\n  echo '{"provider":"openai-codex","modelId":"gpt-5.6-sol","name":"GPT-5.6 Sol","contextWindow":272000,"reasoning":true,"vision":true}'\nelse\n  exec "${process.execPath}" "$@"\nfi\n`,
    launchctl: `#!/bin/bash\ncase "$1" in\n  print)\n    [[ -f "${state}" ]] || exit 1\n    printf 'state = running\\npid = 4242\\n'\n    ;;\n  bootout) rm -f "${state}" ;;\n  bootstrap)\n    [[ "\${PI_LEO_MOCK_BOOTSTRAP_FAIL:-0}" == "1" ]] && exit 42\n    touch "${state}"\n    ;;\nesac\nexit 0\n`,
    curl: "#!/bin/bash\necho '{\"status\":\"ok\",\"service\":\"pi-leo-bridge\"}'\n",
    lsof: `#!/bin/bash\n[[ -f "${state}" ]] || exit 1\nif [[ " $* " == *" -t "* ]]; then\n  echo 4242\nelse\n  printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\nnode 4242 user 1u IPv4 0 0t0 TCP 127.0.0.1:43127 (LISTEN)\\n'\nfi\n`,
    pgrep: "#!/bin/bash\nexit 1\n",
    osascript: "#!/bin/bash\nexit 0\n",
    open: "#!/bin/bash\nexit 0\n",
  };
  for (const [name, content] of Object.entries(scripts)) {
    const path = join(directory, name);
    await writeFile(path, content, { mode: 0o755 });
  }
  return directory;
}

function runInstaller(
  f: Fixture,
  mockBin: string,
  options: { failBootstrap?: boolean; failModel?: boolean } = {},
) {
  return spawnSync("/bin/bash", [installScript, "--yes", "--skip-verify"], {
    cwd: project,
    env: {
      ...process.env,
      HOME: f.home,
      PATH: `${mockBin}:${process.env.PATH ?? ""}`,
      PI_LEO_MOCK_BOOTSTRAP_FAIL: options.failBootstrap ? "1" : "0",
      PI_LEO_MOCK_MODEL_FAIL: options.failModel ? "1" : "0",
    },
    encoding: "utf8",
  });
}

test("full installer works from packaged-style runtime without executing npm", async () => {
  const f = await fixture();
  const mockBin = await mockInstallerCommands(f.root);
  const result = runInstaller(f, mockBin);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(f.config), true);
  assert.equal(
    existsSync(join(f.home, "Library", "LaunchAgents", "com.ojm.pi-leo-bridge.plist")),
    true,
  );
  assert.equal(existsSync(join(f.home, ".local", "bin", "pi-leo")), true);
  const preferences = JSON.parse(await readFile(f.preferences, "utf8"));
  assert.equal(preferences.brave.ai_chat.custom_models.length, 5);
  await rm(f.root, { recursive: true, force: true });
});

test("installer changes nothing when model authentication validation fails", async () => {
  const f = await fixture();
  const original = await readFile(f.preferences);
  const mockBin = await mockInstallerCommands(f.root);
  const result = runInstaller(f, mockBin, { failModel: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication is not configured/);
  assert.deepEqual(await readFile(f.preferences), original);
  assert.equal(existsSync(f.config), false);
  assert.equal(
    existsSync(join(f.home, "Library", "LaunchAgents", "com.ojm.pi-leo-bridge.plist")),
    false,
  );
  assert.equal(existsSync(join(f.home, ".local", "bin", "pi-leo")), false);
  await rm(f.root, { recursive: true, force: true });
});

test("installer rolls back browser and service files when service startup fails", async () => {
  const f = await fixture();
  const original = await readFile(f.preferences);
  const mockBin = await mockInstallerCommands(f.root);
  const result = runInstaller(f, mockBin, { failBootstrap: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restoring the previous bridge and Brave configuration/);
  assert.deepEqual(await readFile(f.preferences), original);
  assert.equal(existsSync(f.config), false);
  assert.equal(
    existsSync(join(f.home, "Library", "LaunchAgents", "com.ojm.pi-leo-bridge.plist")),
    false,
  );
  assert.equal(existsSync(join(f.home, ".local", "bin", "pi-leo")), false);
  await rm(f.root, { recursive: true, force: true });
});

test("installer configuration is idempotent and preserves unrelated credentials", async () => {
  const f = await fixture();
  const original = JSON.parse(await readFile(f.preferences, "utf8"));

  configure(f);
  const first = JSON.parse(await readFile(f.preferences, "utf8"));
  const firstModels = first.brave.ai_chat.custom_models;
  const bridgeModels = firstModels.filter((model: Record<string, unknown>) =>
    String(model.model_request_name).startsWith("pi-gpt-5.6-sol"),
  );
  assert.equal(bridgeModels.length, 3);
  assert.equal(first.brave.ai_chat.default_model_key, "custom:gemini");
  assert.equal(firstModels[0].api_key, "encrypted-fixture-value");
  assert.equal(
    firstModels.find((model: Record<string, unknown>) => model.key === "custom:unrelated-pi").api_key,
    "another-encrypted-fixture-value",
  );

  const identity = bridgeModels.map((model: Record<string, unknown>) => [
    model.model_request_name,
    model.key,
    model.endpoint_url,
  ]);
  configure(f);
  const second = JSON.parse(await readFile(f.preferences, "utf8"));
  const secondBridge = second.brave.ai_chat.custom_models.filter(
    (model: Record<string, unknown>) => String(model.model_request_name).startsWith("pi-gpt-5.6-sol"),
  );
  assert.deepEqual(
    secondBridge.map((model: Record<string, unknown>) => [
      model.model_request_name,
      model.key,
      model.endpoint_url,
    ]),
    identity,
  );
  assert.equal(second.brave.ai_chat.custom_models[0].api_key, "encrypted-fixture-value");

  const config = JSON.parse(await readFile(f.config, "utf8"));
  assert.deepEqual(
    config.profiles.map((profile: Record<string, unknown>) => [
      profile.publicModelId,
      profile.thinkingLevel,
    ]),
    [
      ["pi-gpt-5.6-sol-low", "low"],
      ["pi-gpt-5.6-sol", "medium"],
      ["pi-gpt-5.6-sol-high", "high"],
    ],
  );
  assert.equal(config.previousDefaultModelKey, "custom:gemini");
  assert.equal((await stat(f.config)).mode & 0o777, 0o600);

  const backups = (await readdir(join(f.home, "Library", "Application Support", "BraveSoftware", "Brave-Browser", "Default")))
    .filter((name) => name.includes("before-pi-leo-bridge"));
  assert.equal(backups.length, 2);
  assert.deepEqual(original.brave.ai_chat.custom_models[0], second.brave.ai_chat.custom_models[0]);
});

test("configuration can rotate the capability without changing model keys", async () => {
  const f = await fixture();
  configure(f);
  const first = JSON.parse(await readFile(f.preferences, "utf8"));
  const firstBridge = first.brave.ai_chat.custom_models.filter(
    (model: Record<string, unknown>) => String(model.model_request_name).startsWith("pi-gpt-5.6-sol"),
  );

  configure(f, ["--rotate-token"]);
  const second = JSON.parse(await readFile(f.preferences, "utf8"));
  const secondBridge = second.brave.ai_chat.custom_models.filter(
    (model: Record<string, unknown>) => String(model.model_request_name).startsWith("pi-gpt-5.6-sol"),
  );
  assert.deepEqual(
    secondBridge.map((model: Record<string, unknown>) => model.key),
    firstBridge.map((model: Record<string, unknown>) => model.key),
  );
  assert.notEqual(secondBridge[0].endpoint_url, firstBridge[0].endpoint_url);
});

test("configuration supports another Pi provider, model, and profile set", async () => {
  const f = await fixture();
  configure(f, [
    "--provider",
    "google",
    "--model",
    "gemini-example",
    "--display-name",
    "Gemini Example",
    "--levels",
    "off,high",
    "--primary-level",
    "high",
    "--port",
    "44001",
    "--context-size",
    "50000",
  ]);

  const config = JSON.parse(await readFile(f.config, "utf8"));
  assert.equal(config.provider, "google");
  assert.equal(config.modelId, "gemini-example");
  assert.equal(config.port, 44001);
  assert.equal(config.contextSize, 50000);
  assert.equal(config.publicModelId, "pi-google-gemini-example");
  assert.deepEqual(
    config.profiles.map((profile: Record<string, unknown>) => profile.thinkingLevel),
    ["off", "high"],
  );
});

test("changing the underlying model preserves the selected thinking level", async () => {
  const f = await fixture();
  configure(f);
  const config = JSON.parse(await readFile(f.config, "utf8"));
  const preferences = JSON.parse(await readFile(f.preferences, "utf8"));
  preferences.brave.ai_chat.default_model_key = config.braveModelKeys[2];
  await writeFile(f.preferences, JSON.stringify(preferences));

  configure(f, ["--model", "gpt-example", "--display-name", "GPT Example"]);
  const updated = JSON.parse(await readFile(f.preferences, "utf8"));
  const selected = updated.brave.ai_chat.custom_models.find(
    (model: Record<string, unknown>) => model.key === updated.brave.ai_chat.default_model_key,
  );
  assert.equal(selected.label, "Pi — GPT Example (High)");
});

test("default command selects a managed level and restores the prior model", async () => {
  const f = await fixture();
  configure(f);
  runPython(f.home, setDefaultScript, ["--config", f.config, "high"]);
  let preferences = JSON.parse(await readFile(f.preferences, "utf8"));
  let selected = preferences.brave.ai_chat.custom_models.find(
    (model: Record<string, unknown>) => model.key === preferences.brave.ai_chat.default_model_key,
  );
  assert.equal(selected.label, "Pi — GPT-5.6 Sol (High)");

  runPython(f.home, setDefaultScript, ["--config", f.config, "restore"]);
  preferences = JSON.parse(await readFile(f.preferences, "utf8"));
  assert.equal(preferences.brave.ai_chat.default_model_key, "custom:gemini");
});

test("uninstall removes only managed Brave models and restores the prior default", async () => {
  const f = await fixture();
  configure(f);
  const config = JSON.parse(await readFile(f.config, "utf8"));
  const preferences = JSON.parse(await readFile(f.preferences, "utf8"));
  preferences.brave.ai_chat.default_model_key = config.braveModelKeys[1];
  const managedEndpoint = preferences.brave.ai_chat.custom_models.find(
    (model: Record<string, unknown>) => model.key === config.braveModelKeys[0],
  ).endpoint_url;
  preferences.brave.ai_chat.custom_models.find(
    (model: Record<string, unknown>) => model.key === "custom:unrelated-pi",
  ).endpoint_url = managedEndpoint;
  await writeFile(f.preferences, JSON.stringify(preferences));

  runPython(f.home, removeScript, ["--config", f.config, "--preferences", f.preferences]);
  const updated = JSON.parse(await readFile(f.preferences, "utf8"));
  assert.equal(updated.brave.ai_chat.custom_models.length, 2);
  const gemini = updated.brave.ai_chat.custom_models.find(
    (model: Record<string, unknown>) => model.key === "custom:gemini",
  );
  assert.equal(gemini.api_key, "encrypted-fixture-value");
  assert.equal(
    updated.brave.ai_chat.custom_models.some(
      (model: Record<string, unknown>) => model.key === "custom:unrelated-pi",
    ),
    true,
  );
  assert.equal(updated.brave.ai_chat.default_model_key, "custom:gemini");
});
