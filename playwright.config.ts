import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const dataDir = mkdtempSync(join(tmpdir(), 'pi-demo-browser-'));

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://127.0.0.1:3107', browserName: 'chromium' },
  webServer: {
    command: 'npm run dev', url: 'http://127.0.0.1:3107/api/health',
    env: { PORT: '3107', DATA_DIR: dataDir,
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: '' },
    reuseExistingServer: false, timeout: 30000,
  },
});
