import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApp } from '../src/app/api';
import { loadKnowledgeLibrary, searchKnowledge } from '../src/knowledge';
import { loadSchedulingDataset, simulateIncidentImpact, simulateSchedule, type ScheduleResult } from '../src/scheduling';
import { loadOperationsDataset, telemetryEvidence } from '../src/operations';
import { Repository } from '../src/storage/repository';

describe('synthetic knowledge and virtual scheduling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-knowledge-scheduling-'));
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

  it('returns only scoped, sourced SOP cards and explains no matches', async () => {
    const library = loadKnowledgeLibrary(repository);
    expect(searchKnowledge(library, 'IND-001', '冷却流量').map((item) => item.id)).toEqual(['SOP-COOL-01']);
    expect(searchKnowledge(library, 'IND-004', '缺失').map((item) => item.id)).toEqual(['SOP-DATA-04']);
    expect(searchKnowledge(library, 'IND-005', '冷却')).toEqual([]);
    const response = await fetch(base + '/api/knowledge?case_id=IND-001&query=%E6%B8%A9%E5%BA%A6');
    const result = await response.json();
    expect(result).toMatchObject({ case_id: 'IND-001', data_type: 'synthetic', version: '1.0.0' });
    expect(result.results[0]).toMatchObject({ id: 'SOP-COOL-01', version: '1.0', updated_at: '2026-09-22' });
    expect((await fetch(base + '/api/knowledge?case_id=IND-999&query=%E6%B8%A9%E5%BA%A6')).status).toBe(400);
    expect((await fetch(base + '/api/knowledge?case_id=IND-001&query=a')).status).toBe(400);
  });

  it('keeps each machine conflict free and exposes the delay–energy tradeoff', async () => {
    const data = loadSchedulingDataset();
    const deadline = simulateSchedule(data, 'deadline_first');
    const energy = simulateSchedule(data, 'energy_first');
    expect(deadline.kpis).toEqual({ makespan_h: 5, total_late_h: 0, late_orders: 0, energy_kwh: 142.2 });
    expect(energy.kpis).toEqual({ makespan_h: 14.5, total_late_h: 15, late_orders: 4, energy_kwh: 116 });
    for (const result of [deadline, energy]) {
      expect(result.assignments).toHaveLength(data.orders.length);
      for (const machine of data.machines) {
        const assigned = result.assignments.filter((item) => item.machine_id === machine.id)
          .sort((left, right) => left.start_h - right.start_h);
        for (let index = 1; index < assigned.length; index++) {
          expect(assigned[index].start_h).toBeGreaterThanOrEqual(assigned[index - 1].end_h);
        }
      }
      for (const item of result.assignments) {
        expect(data.orders.find((order) => order.id === item.order_id)?.duration_h[item.machine_id]).toBe(item.end_h - item.start_h);
        expect(item.late_h).toBe(Math.max(0, item.end_h - item.due_h));
      }
    }
    const disrupted = simulateSchedule(data, 'deadline_first', 'M-FAST');
    expect(disrupted.assignments.every((item) => item.machine_id !== 'M-FAST')).toBe(true);
    expect(disrupted.kpis).toEqual({ makespan_h: 6.8, total_late_h: 0.8, late_orders: 1, energy_kwh: 143.2 });
    expect(() => simulateSchedule(data, 'deadline_first', 'M-UNKNOWN')).toThrow('Unknown unavailable machine');
    const response = await fetch(base + '/api/scheduling/simulate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unavailable_machine_id: 'M-FAST' }),
    });
    expect(response.status).toBe(200);
    const body: { deadline_first: ScheduleResult } = await response.json();
    expect(body.deadline_first.kpis).toEqual(disrupted.kpis);
    expect((await fetch(base + '/api/scheduling/simulate', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unavailable_machine_id: 'M-UNKNOWN' }) })).status).toBe(400);
  });

  it('links an alarm to a feasible schedule and stores only a human-selected simulation', async () => {
    const episode = loadOperationsDataset(repository).episodes.find((item) => item.case_id === 'IND-001')!;
    const incident = telemetryEvidence(episode, loadOperationsDataset(repository).thresholds).incident;
    const impact = simulateIncidentImpact(loadSchedulingDataset(), incident);
    expect(impact).toMatchObject({ case_id: 'IND-001', line_id: 'LINE-03',
      equipment_id: 'EQ-003', machine_id: 'M-FAST', recommended_strategy: 'deadline_first' });
    expect(impact.incident.evidence_ids).toEqual(['TEL-IND-001-003', 'TEL-IND-001-004']);
    expect(impact.disrupted.deadline_first.kpis.total_late_h).toBe(0.8);
    expect(impact.disrupted.energy_first.kpis.total_late_h).toBe(15);
    expect((await fetch(base + '/api/scheduling/incident-impact?case_id=IND-003')).status).toBe(400);
    const response = await fetch(base + '/api/scheduling/incident-impact?case_id=IND-001');
    expect(response.status).toBe(200);
    expect((await response.json()).recommended_strategy).toBe('deadline_first');

    const replay = await (await fetch(base + '/api/replay', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ case_id: 'IND-001' }) })).json();
    const orderResponse = await fetch(base + '/api/work-orders', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: replay.id, assignee: 'equipment_technician' }) });
    expect(orderResponse.status).toBe(201);
    const order = await orderResponse.json();
    const payload = { case_id: 'IND-001', work_order_id: order.id, strategy: 'deadline_first',
      note: '优先保证装配批次交期，人工选择此方案。' };
    const decisionResponse = await fetch(base + '/api/scheduling/decisions', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(decisionResponse.status).toBe(201);
    const decision = await decisionResponse.json();
    expect(decision).toMatchObject({ ...payload, impact: { incident: {
      telemetry_evidence_id: 'IND-001:telemetry:2026-09-22' },
      disrupted: { deadline_first: { unavailable_machine_id: 'M-FAST' } } } });
    const reader = new Repository(join(dir, 'demo.sqlite'), { readOnly: true });
    expect(reader.listScheduleDecisions('IND-001')[0].id).toBe(decision.id);
    reader.close();
    const invalid = await fetch(base + '/api/scheduling/decisions', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload,
        work_order_id: '00000000-0000-4000-8000-000000000000' }) });
    expect(invalid.status).toBe(409);
  });
});
