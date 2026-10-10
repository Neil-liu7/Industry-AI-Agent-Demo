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

describe('local DeepSeek configuration', () => {
  it('uses the official provider and resolves the legacy Flash model name', () => {
    const before = { provider: process.env.MODEL_PROVIDER, name: process.env.MODEL_NAME,
      key: process.env.DEEPSEEK_API_KEY };
    try {
      process.env.MODEL_PROVIDER = 'deepseek';
      process.env.MODEL_NAME = 'deepseek-v4-flash';
      delete process.env.DEEPSEEK_API_KEY;
      expect(onlineEngineFromEnv()).toBeNull();
      process.env.DEEPSEEK_API_KEY = 'test-key-never-sent';
      const engine = onlineEngineFromEnv();
      expect(engine?.model).toMatchObject({
        id: 'deepseek-flash', provider: 'deepseek', api: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
      });
      expect(engine?.getApiKey?.('deepseek')).toBe('test-key-never-sent');
      process.env.MODEL_NAME = 'deepseek-flash';
      expect(onlineEngineFromEnv()?.model.id).toBe('deepseek-flash');
      process.env.MODEL_NAME = 'not-in-pinned-catalog';
      expect(onlineEngineFromEnv()).toBeNull();
    } finally {
      if (before.provider === undefined) delete process.env.MODEL_PROVIDER;
      else process.env.MODEL_PROVIDER = before.provider;
      if (before.name === undefined) delete process.env.MODEL_NAME;
      else process.env.MODEL_NAME = before.name;
      if (before.key === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = before.key;
    }
  });
});
