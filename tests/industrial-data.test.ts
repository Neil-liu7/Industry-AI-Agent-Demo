import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApp } from '../src/app/api';
import { evaluateIndustrialOutcome, scheduleConstraintViolations } from '../src/industrial-evaluation';
import { loadOperationsDataset } from '../src/operations';
import { loadSchedulingDataset, simulateSchedule } from '../src/scheduling';
import { Repository } from '../src/storage/repository';

describe('isolated CSV telemetry and industrial outcome checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-industrial-data-'));
  const path = join(dir, 'demo.sqlite');
  const sample = readFileSync(join(process.cwd(), 'data', 'telemetry-import-example.csv'), 'utf8');
  let repository: Repository;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    repository = new Repository(path);
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

  const upload = (caseId: string, csv: string) => fetch(base + '/api/telemetry/import', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ case_id: caseId, csv }),
  });

  it('keeps uploaded evidence distinct from built-in telemetry and persists its assessment', async () => {
    const original = repository.getCase('IND-001');
    const response = await upload('IND-001', sample);
    expect(response.status).toBe(201);
    const imported = await response.json();
    expect(imported).toMatchObject({ data_type: 'uploaded_csv', case_id: 'IND-001',
      equipment_id: 'EQ-003', bad_samples: 0, assessment: { state: 'ALARM' } });
    expect(imported.assessment.evidence_ids).toEqual([
      `${imported.id}:003`, `${imported.id}:004`,
    ]);
    expect(repository.getCase('IND-001')).toEqual(original);
    const reopened = new Repository(path, { readOnly: true });
    expect(reopened.listTelemetryImports('IND-001')[0].id).toBe(imported.id);
    reopened.close();
    const history = await (await fetch(base + '/api/telemetry/imports?case_id=IND-001')).json();
    expect(history.items[0].id).toBe(imported.id);
  });

  it('quarantines bad quality and rejects cross-equipment, missing-unit and out-of-order rows', async () => {
    const bad = sample.replace('87.5,8.1,20,GOOD', ',,20,BAD');
    const response = await upload('IND-001', bad);
    expect(response.status).toBe(201);
    expect((await response.json())).toMatchObject({ bad_samples: 1, assessment: { state: 'DATA_GAP' } });
    expect((await upload('IND-003', sample)).status).toBe(400);
    expect((await upload('IND-001', sample.replace('EQ-003', 'EQ-999'))).status).toBe(400);
    expect((await upload('IND-001', sample.replace('temperature_c', 'temperature_f'))).status).toBe(400);
    expect((await upload('IND-001', sample.replace('2026-09-22T08:15:00+08:00',
      '2026-09-22T08:05:00+08:00'))).status).toBe(400);
    expect((await upload('IND-001', sample.replace('87.5,8.1,20,GOOD', ',8.1,20,GOOD'))).status).toBe(400);
  });

  it('reports alarm confirmation time, schedule tradeoff and real constraint checks', async () => {
    const operations = loadOperationsDataset(repository);
    const scheduling = loadSchedulingDataset();
    const outcome = evaluateIndustrialOutcome(repository, operations, scheduling);
    expect(outcome.alarms.map((item) => [item.case_id, item.confirmation_minutes]))
      .toEqual([['IND-001', 5], ['IND-003', 5], ['IND-005', 5]]);
    expect(outcome.scheduling).toMatchObject({ constraint_violations: [],
      deadline_first_late_h: 0.8, energy_first_late_h: 15,
      delay_saved_h: 14.2, extra_energy_kwh: 27.2 });
    expect(outcome.imports.find((item) => item.case_id === 'IND-001')).toMatchObject({
      batches: 2, bad_samples: 1,
    });
    const disrupted = simulateSchedule(scheduling, 'deadline_first', 'M-FAST');
    expect(scheduleConstraintViolations(scheduling, disrupted)).toEqual([]);
    const invalid = { ...disrupted, assignments: [{ ...disrupted.assignments[0], machine_id: 'M-FAST' },
      ...disrupted.assignments.slice(1)] };
    expect(scheduleConstraintViolations(scheduling, invalid)).toContain('Invalid assignment ORD-101');
    const apiOutcome = await (await fetch(base + '/api/industrial-evaluation')).json();
    expect(apiOutcome.scheduling.delay_saved_h).toBe(14.2);
  });
});
