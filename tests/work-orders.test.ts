import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApp } from '../src/app/api';
import { Repository } from '../src/storage/repository';

describe('human inspection work order lifecycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-work-orders-'));
  const dbPath = join(dir, 'demo.sqlite');
  let repository: Repository;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    repository = new Repository(dbPath);
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

  const post = async (url: string, body: unknown) => fetch(base + url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const patch = async (url: string, body: unknown) => fetch(base + url, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('links an alarm, diagnosis and SOP to recorded inspection and separately confirmed resolution', async () => {
    expect((await post('/api/work-orders', { session_id: '00000000-0000-4000-8000-000000000000', assignee: 'equipment_technician' })).status).toBe(400);
    const replay = await (await post('/api/replay', { case_id: 'IND-001' })).json();
    const response = await post('/api/work-orders', { session_id: replay.id, assignee: 'equipment_technician' });
    expect(response.status).toBe(201);
    const order = await response.json();
    expect(order).toMatchObject({
      session_id: replay.id, case_id: 'IND-001', equipment_id: 'EQ-003',
      assignee: 'equipment_technician', risk_level: 'HIGH', status: 'open',
      evidence_ids: replay.diagnosis.evidence_ids,
      incident: { state: 'ALARM', telemetry_evidence_id: 'IND-001:telemetry:2026-09-22',
        evidence_ids: ['TEL-IND-001-003', 'TEL-IND-001-004'] },
      sop: { id: 'SOP-COOL-01' }, resolution: null,
    });
    expect(order.checklist.map((item: { description: string }) => item.description))
      .toEqual(replay.diagnosis.recommended_checks);
    expect(order.checklist.every((item: { completed: boolean }) => !item.completed)).toBe(true);
    expect((await patch(`/api/work-orders/${order.id}/status`, { status: 'completed' })).status).toBe(409);
    expect((await patch(`/api/work-orders/${order.id}/checklist/${order.checklist[0].id}`,
      { completed: true, finding: 'normal', note: '现场核查记录正常' })).status).toBe(409);
    expect((await post(`/api/work-orders/${order.id}/recheck`, {})).status).toBe(409);

    const startedResponse = await patch(`/api/work-orders/${order.id}/status`, { status: 'in_progress' });
    expect(startedResponse.status).toBe(200);
    let updated = await startedResponse.json();
    expect((await patch(`/api/work-orders/${order.id}/checklist/${order.checklist[0].id}`, { completed: true })).status).toBe(400);
    for (const check of updated.checklist) {
      const result = await patch(`/api/work-orders/${order.id}/checklist/${check.id}`,
        { completed: true, finding: 'normal', note: '现场核查记录正常' });
      expect(result.status).toBe(200);
      updated = await result.json();
    }
    expect(updated.checklist.every((item: { checked_at: string; note: string }) =>
      item.checked_at && item.note === '现场核查记录正常')).toBe(true);
    expect((await patch(`/api/work-orders/${order.id}/status`, { status: 'completed' })).status).toBe(200);
    expect((await patch(`/api/work-orders/${order.id}/status`, { status: 'in_progress' })).status).toBe(409);
    const resolvePath = `/api/work-orders/${order.id}/resolve`;
    expect((await post(resolvePath, { production_confirmed: true, quality_confirmed: true,
      note: '人工确认产量和质量已复核' })).status).toBe(409);
    const recheckResponse = await post(`/api/work-orders/${order.id}/recheck`, {});
    expect(recheckResponse.status).toBe(200);
    const rechecked = await recheckResponse.json();
    expect(rechecked).toMatchObject({ status: 'completed', resolution: null,
      recheck: { result: 'PASS', evidence_ids: ['TEL-IND-001-005', 'TEL-IND-001-006'] } });
    expect((await post(resolvePath, { production_confirmed: true, quality_confirmed: false,
      note: '人工确认产量和质量已复核' })).status).toBe(400);
    const resolvedResponse = await post(resolvePath, { production_confirmed: true, quality_confirmed: true,
      note: '人工确认产量和质量已复核' });
    expect(resolvedResponse.status).toBe(200);
    expect((await resolvedResponse.json()).resolution).toMatchObject({ production_confirmed: true,
      quality_confirmed: true, note: '人工确认产量和质量已复核' });
    expect((await post(`/api/work-orders/${order.id}/recheck`, {})).status).toBe(409);

    const list = await (await fetch(base + '/api/work-orders?case_id=IND-001')).json();
    expect(list.items[0]).toMatchObject({ id: order.id, status: 'completed', resolution: { production_confirmed: true } });
    expect((await fetch(base + '/api/work-orders?case_id=IND-999')).status).toBe(400);

    const reopened = new Repository(dbPath, { readOnly: true });
    try { expect(reopened.getWorkOrder(order.id)).toMatchObject({ status: 'completed',
      checklist: updated.checklist, recheck: rechecked.recheck, resolution: { production_confirmed: true } }); }
    finally { reopened.close(); }
  });

  it('retains failed recheck evidence and refuses to clear an unresolved alarm', async () => {
    const replay = await (await post('/api/replay', { case_id: 'IND-003' })).json();
    const order = await (await post('/api/work-orders', {
      session_id: replay.id, assignee: 'process_engineer',
    })).json();
    expect(order.sop.id).toBe('SOP-COOL-01');
    await patch(`/api/work-orders/${order.id}/status`, { status: 'in_progress' });
    for (const check of order.checklist) await patch(`/api/work-orders/${order.id}/checklist/${check.id}`,
      { completed: true, finding: 'normal', note: '现场核查记录正常' });
    await patch(`/api/work-orders/${order.id}/status`, { status: 'completed' });
    const response = await post(`/api/work-orders/${order.id}/recheck`, {});
    expect(response.status).toBe(200);
    expect((await response.json()).recheck).toMatchObject({ result: 'FAIL',
      evidence_ids: ['TEL-IND-003-005', 'TEL-IND-003-006'] });
    expect((await post(`/api/work-orders/${order.id}/resolve`, { production_confirmed: true,
      quality_confirmed: true, note: '人工确认产量和质量已复核' })).status).toBe(409);
    expect(repository.getWorkOrder(order.id)?.resolution).toBeNull();
  });
});
