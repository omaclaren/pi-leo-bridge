import { ModelRuntime } from "@earendil-works/pi-coding-agent";

class ModelValidationError extends Error {}

async function main(): Promise<void> {
  const [, , provider, modelId] = process.argv;
  if (!provider || !modelId) {
    console.error("Usage: check-model PROVIDER MODEL");
    process.exitCode = 2;
    return;
  }

  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: true,
    signal: AbortSignal.timeout(30_000),
  });
  const model = runtime.getModel(provider, modelId);
  if (!model) {
    throw new ModelValidationError(`Pi model is not registered: ${provider}/${modelId}`);
  }
  if (!runtime.hasConfiguredAuth(provider)) {
    throw new ModelValidationError(
      `Pi authentication is not configured for provider: ${provider}`,
    );
  }
  const available = await runtime.getAvailable(provider, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!available.some((candidate) => candidate.id === modelId)) {
    throw new ModelValidationError(
      `Pi model is not currently available: ${provider}/${modelId}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      provider,
      modelId,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      vision: model.input.includes("image"),
    })}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ModelValidationError) {
    console.error(error.message.replace(/[\r\n]+/g, " ").slice(0, 300));
  } else {
    console.error(
      "Pi model validation failed. Check provider authentication and network access.",
    );
  }
  process.exitCode = 1;
});
