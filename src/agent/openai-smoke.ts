import { existsSync } from 'node:fs';
import { onlineEngineFromEnv } from '../app/model';
import { runPiSmoke } from './pi-smoke';

if (existsSync('.env')) process.loadEnvFile('.env');

if (process.env.MODEL_PROVIDER !== 'openai') {
  throw new Error('Set MODEL_PROVIDER=openai in .env before the OpenAI smoke test');
}
const engine = onlineEngineFromEnv();
if (!engine) throw new Error('Set a supported MODEL_NAME and OPENAI_API_KEY in local .env');

const result = await runPiSmoke(engine.model, engine.streamFn, engine.getApiKey);
if (result.error || !result.events.includes('tool_execution_end') ||
  result.messages.at(-1)?.role !== 'assistant') {
  throw new Error(`OpenAI tool-call smoke failed: ${result.error ?? 'tool call or final answer missing'}`);
}
console.log(`OpenAI Pi tool-call smoke passed: ${engine.model.id}`);
