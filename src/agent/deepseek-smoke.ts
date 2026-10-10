import { existsSync } from 'node:fs';
import { onlineEngineFromEnv } from '../app/model';
import { runPiSmoke } from './pi-smoke';

if (existsSync('.env')) process.loadEnvFile('.env');

if (process.env.MODEL_PROVIDER !== 'deepseek') {
  throw new Error('Set MODEL_PROVIDER=deepseek in .env before the DeepSeek smoke test');
}
const engine = onlineEngineFromEnv();
if (!engine) throw new Error('Set MODEL_NAME=deepseek-flash and DEEPSEEK_API_KEY in local .env');

const result = await runPiSmoke(engine.model, engine.streamFn, engine.getApiKey);
if (result.error || !result.events.includes('tool_execution_end') ||
  result.messages.at(-1)?.role !== 'assistant') {
  throw new Error(`DeepSeek tool-call smoke failed: ${result.error ?? 'tool call or final answer missing'}`);
}
console.log(`DeepSeek Pi tool-call smoke passed: ${engine.model.id}`);
