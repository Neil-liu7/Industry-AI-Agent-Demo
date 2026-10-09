import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../src/storage/repository';
import { runSafetyScenario, safetyScenarios } from '../src/safety-lab';

describe('scripted safety lab through Pi and Harness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-safety-'));
  let repository: Repository;
  beforeAll(() => {
    process.env.DATA_DIR = dir;
    repository = new Repository(join(dir, 'demo.sqlite'));
    repository.seed();
  });
  afterAll(() => {
    repository.close();
    delete process.env.DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('enforces all four fixed stop conditions without persisting fake runs', async () => {
    const results = [];
    for (const spec of safetyScenarios) {
      const result = await runSafetyScenario(repository, spec.id);
      expect(result, spec.id).toMatchObject({
        scenario_id: spec.id, execution: 'scripted_fake_model', data_type: 'synthetic',
        passed: true, expected_stop_reason: spec.expected_stop_reason,
        observed_stop_reason: spec.expected_stop_reason, model_calls: spec.expected_model_calls,
      });
      expect(result.evidence_ids, spec.id).toHaveLength(spec.expected_evidence_count);
      expect(result.trace.at(-1)?.stop_reason, spec.id).toBe(spec.expected_stop_reason);
      results.push(result);
    }
    expect(results[0].tool_calls).toBe(0);
    expect(results[1].trace.filter((item) => item.kind === 'tool')).toMatchObject([
      { name: 'get_line_snapshot', status: 'failed' },
    ]);
    expect(results[2].trace.filter((item) => item.kind === 'tool').map((item) => item.source))
      .toEqual(['local', 'local', 'mcp']);
    expect(results[2].evidence_ids).not.toContain('FAKE-EVIDENCE');
    expect(results[3].evidence_ids).toHaveLength(2);
    expect(repository.listSessions({}).items).toEqual([]);
  });
});
