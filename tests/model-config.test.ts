import { describe, expect, it } from 'vitest';
import { onlineEngineFromEnv } from '../src/app/model';

describe('local OpenAI configuration', () => {
  it('uses the pinned catalog model and keeps the API key on the server', () => {
    const before = { provider: process.env.MODEL_PROVIDER, name: process.env.MODEL_NAME,
      key: process.env.OPENAI_API_KEY };
    try {
      process.env.MODEL_PROVIDER = 'openai';
      process.env.MODEL_NAME = 'gpt-4.1-mini';
      delete process.env.OPENAI_API_KEY;
      expect(onlineEngineFromEnv()).toBeNull();
      process.env.OPENAI_API_KEY = 'test-key-never-sent';
      const engine = onlineEngineFromEnv();
      expect(engine?.model.id).toBe('gpt-4.1-mini');
      expect(engine?.getApiKey?.('openai')).toBe('test-key-never-sent');
      process.env.MODEL_NAME = 'not-in-pinned-catalog';
      expect(onlineEngineFromEnv()).toBeNull();
    } finally {
      if (before.provider === undefined) delete process.env.MODEL_PROVIDER;
      else process.env.MODEL_PROVIDER = before.provider;
      if (before.name === undefined) delete process.env.MODEL_NAME;
      else process.env.MODEL_NAME = before.name;
      if (before.key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before.key;
    }
  });
});
