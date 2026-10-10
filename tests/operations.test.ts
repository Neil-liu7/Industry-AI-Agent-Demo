import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApp } from '../src/app/api';
import { loadKnowledgeLibrary } from '../src/knowledge';
import { assessOperations, loadOperationsDataset, verifyOperations } from '../src/operations';
import { Repository } from '../src/storage/repository';

describe('industrial event and virtual recheck', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-operations-'));
  let repository: Repository;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    repository = new Repository(join(dir, 'demo.sqlite'));
    repository.seed();
    server = createApp(repository, () => null).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    repository.close();
    delete process.env.DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('debounces alarms, preserves source IDs and separates missing data', () => {
    const data = loadOperationsDataset(repository);
    const episode = data.episodes.find((item) => item.case_id === 'IND-001')!;
    expect(assessOperations(episode, data.thresholds, 0).state).toBe('NORMAL');
    expect(assessOperations(episode, data.thresholds, 1).state).toBe('WATCH');
    expect(assessOperations(episode, data.thresholds, 2)).toMatchObject({
      state: 'ALARM', evidence_ids: ['TEL-IND-001-002', 'TEL-IND-001-003'],
      recommendation: { action_id: 'cooling_check', sop_id: 'SOP-COOL-01' },
    });
    expect(assessOperations(data.episodes.find((item) => item.case_id === 'IND-002')!, data.thresholds, 3).state).toBe('NORMAL');
    expect(assessOperations(data.episodes.find((item) => item.case_id === 'IND-004')!, data.thresholds, 3))
      .toMatchObject({ state: 'DATA_GAP', recommendation: { action_id: 'sensor_check' } });
    expect(assessOperations(data.episodes.find((item) => item.case_id === 'IND-005')!, data.thresholds, 3))
      .toMatchObject({ state: 'ALARM', recommendation: { action_id: 'bearing_check' } });
    const knowledge = loadKnowledgeLibrary(repository);
    for (const item of data.episodes) {
      const recommendation = assessOperations(item, data.thresholds, item.points.length - 1).recommendation;
      if (recommendation) expect(knowledge.documents.some((document) =>
        document.id === recommendation.sop_id && document.case_ids.includes(item.case_id))).toBe(true);
    }
    expect(() => assessOperations(episode, data.thresholds, 99)).toThrow('Invalid telemetry index');
  });

  it('requires supported action and two complete, in-limit rechecks', () => {
    const data = loadOperationsDataset(repository);
    const episode = data.episodes.find((item) => item.case_id === 'IND-001')!;
    expect(verifyOperations(episode, data.thresholds, 'cooling_check')).toMatchObject({
      result: 'PASS', checks: [{ data_complete: true, within_limits: true }, { data_complete: true, within_limits: true }],
    });
    expect(() => verifyOperations(episode, data.thresholds, 'bearing_check')).toThrow('No verification fixture');
    expect(verifyOperations(data.episodes.find((item) => item.case_id === 'IND-003')!, data.thresholds, 'process_check'))
      .toMatchObject({ result: 'FAIL', checks: [{ within_limits: false }, { within_limits: false }] });
    expect(verifyOperations(data.episodes.find((item) => item.case_id === 'IND-004')!, data.thresholds, 'sensor_check').result).toBe('PASS');
    const incomplete = { ...episode, verification_points: [
      episode.verification_points[0], { ...episode.verification_points[1], temperature_c: null },
    ] };
    expect(verifyOperations(incomplete, data.thresholds, 'cooling_check')).toMatchObject({
      result: 'FAIL', checks: [{ data_complete: true }, { data_complete: false, within_limits: false }],
    });
  });

  it('returns case-scoped telemetry and refuses unsupported virtual actions without changing source cases', async () => {
    const before = await (await fetch(base + '/api/cases/IND-001/snapshot')).json();
    const response = await fetch(base + '/api/operations?case_id=IND-001');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ case_id: 'IND-001', line_id: 'LINE-03', equipment_id: 'EQ-003', data_type: 'synthetic' });
    expect(body.assessments.map((item: { state: string }) => item.state)).toEqual(['NORMAL', 'WATCH', 'ALARM', 'ALARM']);
    expect((await fetch(base + '/api/operations?case_id=IND-999')).status).toBe(400);
    const post = (value: unknown) => fetch(base + '/api/operations/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    expect((await post({ case_id: 'IND-001', action_id: 'bearing_check' })).status).toBe(409);
    expect((await post({ case_id: 'IND-002', action_id: 'cooling_check' })).status).toBe(409);
    expect((await post({ case_id: 'IND-001', action_id: 'cooling_check', execute: true })).status).toBe(400);
    const verified = await post({ case_id: 'IND-001', action_id: 'cooling_check' });
    expect(verified.status).toBe(200);
    expect((await verified.json()).result).toBe('PASS');
    const after = await (await fetch(base + '/api/cases/IND-001/snapshot')).json();
    expect(after).toEqual(before);
  });
});
