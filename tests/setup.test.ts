import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('project bootstrap', () => {
  it('documents the supported Node runtime and excludes local secrets', () => {
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('22.19.0');
    expect(readFileSync('.gitignore', 'utf8')).toContain('.env\n');
    expect(readFileSync('.env.example', 'utf8')).toContain('ANTHROPIC_API_KEY=\n');
  });
});
