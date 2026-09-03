import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const provider = args.find((argument) => !argument.startsWith("-"));

const runtime = await ModelRuntime.create({
  allowModelNetwork: false,
  refreshOnCreate: true,
  signal: AbortSignal.timeout(30_000),
});

const providerIds = provider
  ? [provider]
  : runtime
      .getProviders()
      .map((candidate) => candidate.id)
      .filter((providerId) => runtime.hasConfiguredAuth(providerId));

const models = [];
for (const providerId of providerIds) {
  if (!runtime.getProvider(providerId)) {
    throw new Error(`Unknown Pi provider: ${providerId}`);
  }
  if (!runtime.hasConfiguredAuth(providerId)) {
    if (provider) {
      throw new Error(`Pi authentication is not configured for provider: ${providerId}`);
    }
    continue;
  }
  const available = await runtime.getAvailable(providerId, {
    signal: AbortSignal.timeout(30_000),
  });
  for (const model of available) {
    models.push({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      vision: model.input.includes("image"),
      contextWindow: model.contextWindow,
    });
  }
}

models.sort((left, right) =>
  `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
);

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(models, null, 2)}\n`);
} else if (models.length === 0) {
  process.stdout.write("No available models were found for configured Pi providers.\n");
} else {
  for (const model of models) {
    const capabilities = [model.reasoning ? "reasoning" : "no-reasoning", model.vision ? "vision" : "text"];
    process.stdout.write(
      `${model.provider}/${model.id}\t${model.name}\t${capabilities.join(",")}\tcontext=${model.contextWindow}\n`,
    );
  }
}
