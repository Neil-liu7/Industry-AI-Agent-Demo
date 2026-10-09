import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { OnlineEngine } from '../harness/run';

export function onlineEngineFromEnv(): OnlineEngine | null {
  const provider = process.env.MODEL_PROVIDER ?? 'anthropic';
  const name = process.env.MODEL_NAME ?? 'claude-sonnet-4-6';
  const key = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY :
    provider === 'openai' ? process.env.OPENAI_API_KEY : undefined;
  if (!key) return null;
  const models = createModels();
  if (provider === 'anthropic') models.setProvider(anthropicProvider());
  else if (provider === 'openai') models.setProvider(openaiProvider());
  else return null;
  const model = models.getModel(provider, name);
  if (!model) return null;
  return { model, streamFn: models.streamSimple.bind(models), getApiKey: () => key };
}
