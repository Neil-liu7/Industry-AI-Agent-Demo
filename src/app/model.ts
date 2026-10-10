import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { OnlineEngine } from '../harness/run';

export function onlineEngineFromEnv(): OnlineEngine | null {
  const provider = process.env.MODEL_PROVIDER ?? 'anthropic';
  const configuredName = process.env.MODEL_NAME ??
    (provider === 'openai' ? 'gpt-4.1-mini' : provider === 'deepseek' ? 'deepseek-flash' : 'claude-sonnet-4-6');
  // DeepSeek still accepts this legacy ID, while the pinned Pi catalog uses the current ID.
  const name = provider === 'deepseek' && configuredName === 'deepseek-v4-flash' ? 'deepseek-flash' : configuredName;
  const key = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY :
    provider === 'openai' ? process.env.OPENAI_API_KEY :
    provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined;
  if (!key) return null;
  const models = createModels();
  if (provider === 'anthropic') models.setProvider(anthropicProvider());
  else if (provider === 'openai') models.setProvider(openaiProvider());
  else if (provider === 'deepseek') models.setProvider(deepseekProvider());
  else return null;
  const model = models.getModel(provider, name);
  if (!model) return null;
  return { model, streamFn: models.streamSimple.bind(models), getApiKey: () => key };
}
