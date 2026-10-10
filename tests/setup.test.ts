import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function isIgnored(path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', path]);
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed for ${path}`);
  return result.status === 0;
}

describe('project bootstrap', () => {
  it('documents the supported Node runtime and excludes local secrets', () => {
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('22.19.0');
    expect(readFileSync('.env.example', 'utf8')).toContain('ANTHROPIC_API_KEY=\n');
    expect(isIgnored('.env')).toBe(true);
    expect(isIgnored('.env.local')).toBe(true);
    expect(isIgnored('config/.env.production')).toBe(true);
    expect(isIgnored('.env.example')).toBe(false);
    expect(isIgnored('config/.env.example')).toBe(false);
    expect(isIgnored('debug.log')).toBe(true);
    expect(isIgnored('.DS_Store')).toBe(true);
  });
});
