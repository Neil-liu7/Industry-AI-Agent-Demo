import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApp } from '../src/app/api';
import { renderReport } from '../src/app/report';
import { Repository } from '../src/storage/repository';
import { fakeMessage, fakeModel, scriptedStream } from './helpers/fake-model';
import type { AssistantMessage } from '@earendil-works/pi-ai';

describe('diagnosis API, replay and durable history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-api-'));
  const path = join(dir, 'demo.sqlite');
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
  const post = async (url: string, body: unknown) => fetch(base + url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('exposes five consistent cases and reports online unavailability without a key', async () => {
    const cases = await (await fetch(base + '/api/cases')).json();
    expect(cases.map((item: { case_id: string }) => item.case_id)).toEqual([
      'IND-001', 'IND-002', 'IND-003', 'IND-004', 'IND-005',
    ]);
    expect(cases.find((item: { case_id: string }) => item.case_id === 'IND-004').metrics)
      .toMatchObject({ temperature_change_pct: null, risk_level: 'UNKNOWN' });
    const snapshot = await (await fetch(base + '/api/cases/IND-003/snapshot')).json();
    expect(snapshot.metrics.risk_level).toBe('MEDIUM');
    expect(snapshot).not.toHaveProperty('maintenance_record');
    const capabilities = await (await fetch(base + '/api/agent/capabilities')).json();
    expect(capabilities.online_available).toBe(false);
    expect((await post('/api/diagnose', { case_id: 'IND-001', question: '诊断产线' })).status).toBe(503);
    const evaluation = await (await fetch(base + '/api/evaluations')).json();
    expect(evaluation.suite.cases).toHaveLength(5);
    expect(evaluation.runs).toEqual([]);
    expect((await post('/api/evaluations', { skill_id: 'line-anomaly-diagnosis' })).status).toBe(503);
    const safety = await (await fetch(base + '/api/safety-lab/scenarios')).json();
    expect(safety.execution).toBe('scripted_fake_model');
    expect(safety.scenarios).toHaveLength(4);
    expect((await post('/api/safety-lab', { scenario_id: 'unknown' })).status).toBe(400);
    const control = await (await post('/api/safety-lab', { scenario_id: 'control-request' })).json();
    expect(control).toMatchObject({ passed: true, observed_stop_reason: 'POLICY_BLOCKED', model_calls: 0 });
    expect(repository.listSessions({}).items).toEqual([]);
  });

  it('replays each case without model or MCP calls and persists filtered history', async () => {
    for (const [caseId, risk] of [
      ['IND-001', 'HIGH'], ['IND-002', 'LOW'], ['IND-003', 'MEDIUM'],
      ['IND-004', 'UNKNOWN'], ['IND-005', 'MEDIUM'],
    ]) {
      const response = await post('/api/replay', { case_id: caseId });
      expect(response.status).toBe(200);
      const session = await response.json();
      expect(session.case_id).toBe(caseId);
      expect(session.mode).toBe('replay');
      expect(session.diagnosis.risk_level).toBe(risk);
      expect(session.model_calls).toBe(0);
      expect(session.tool_calls).toBe(0);
      expect(session.trace.every((item: { run_id: string; stop_reason: string; budget: { tool_calls: number } }) =>
        item.run_id === session.id && item.stop_reason === 'REPLAY_COMPLETED' && item.budget.tool_calls === 0)).toBe(true);
      expect(session.trace.every((item: { started_at: string; ended_at: string; duration_ms: number }) =>
        item.started_at && item.ended_at && item.duration_ms === 0)).toBe(true);
      expect(session.trace.filter((item: { kind: string }) => item.kind === 'tool')
        .every((item: { replayed: boolean }) => item.replayed)).toBe(true);
      const detail = await (await fetch(base + `/api/sessions/${session.id}`)).json();
      expect(detail.diagnosis.evidence_ids).toEqual(session.evidence.map((item: { id: string }) => item.id));
      const report = await (await fetch(base + `/api/reports/${session.id}`)).text();
      expect(report).toContain(caseId);
      expect(report).toContain('离线预录回放');
      expect(report).toContain('合成数据');
      if (caseId === 'IND-004') expect(report).toContain('风险等级未判定');
    }
    const first = await (await fetch(base + '/api/sessions?mode=replay&limit=1')).json();
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toBeTruthy();
    const second = await (await fetch(base + `/api/sessions?mode=replay&limit=1&cursor=${first.next_cursor}`)).json();
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    const filtered = await (await fetch(base + '/api/sessions?case_id=IND-002')).json();
    expect(filtered.items.map((item: { case_id: string }) => item.case_id)).toEqual(['IND-002']);
    repository.db.prepare('INSERT INTO cases VALUES (?, ?)').run('IND-999', JSON.stringify({
      ...repository.getCase('IND-001'), case_id: 'IND-999',
    }));
    repository.seed();
    expect(repository.listCases().map((item) => item.case_id)).not.toContain('IND-999');
    const reopened = new Repository(path);
    expect(reopened.listSessions({}).items).toHaveLength(5);
    reopened.close();
  });

  it('rejects invalid input and escapes report text', async () => {
    expect((await post('/api/replay', {})).status).toBe(400);
    expect((await post('/api/replay', { case_id: 'IND-999' })).status).toBe(400);
    expect((await fetch(base + '/api/sessions?cursor=bad')).status).toBe(400);
    const session = repository.listSessions({ case_id: 'IND-001' }).items[0];
    expect(renderReport({ ...session, question: '<script>alert(1)</script>' })).not.toContain('<script>');
    const unknown = renderReport({ ...session, metrics: { ...session.metrics,
      output_change_pct: null, temperature_change_pct: null, vibration_change_pct: null, risk_level: 'UNKNOWN' } });
    expect(unknown).toContain('产量变化 未知 · 温度偏移 未知 · 振动偏移 未知');
  });

  it('persists an online Pi run with real local and MCP tool routes', async () => {
    const calls: AssistantMessage['content'] = [
      { type: 'toolCall' as const, id: '1', name: 'get_line_snapshot', arguments: { case_id: 'IND-001', line_id: 'LINE-03' } },
      { type: 'toolCall' as const, id: '2', name: 'get_equipment_snapshot', arguments: { case_id: 'IND-001', equipment_id: 'EQ-003' } },
      { type: 'toolCall' as const, id: '3', name: 'get_maintenance_history', arguments: { case_id: 'IND-001', equipment_id: 'EQ-003' } },
    ];
    const response = JSON.stringify({ summary: '需要人工核查设备升温。', risk_level: 'HIGH',
      evidence_ids: ['IND-001:line:2026-09-22', 'IND-001:equipment:2026-09-22', 'IND-001:maintenance:MAINT-003'],
      hypotheses: ['冷却状态待核查'], recommended_checks: ['人工检查冷却回路'], limitations: ['合成数据'] });
    const online = createApp(repository, () => ({ model: fakeModel, streamFn: scriptedStream([
      fakeMessage(calls, 'toolUse'), fakeMessage([{ type: 'text', text: response }], 'stop'),
    ]) }));
    const onlineServer = online.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => onlineServer.once('listening', resolve));
    const address = onlineServer.address();
    if (!address || typeof address === 'string') throw new Error('No online test port');
    try {
      const result = await fetch(`http://127.0.0.1:${address.port}/api/diagnose`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ case_id: 'IND-001', question: '诊断产线' }),
      });
      expect(result.status).toBe(200);
      const session = await result.json();
      expect(session.status).toBe('completed');
      expect(session.mode).toBe('online');
      expect(session.trace.filter((item: { kind: string }) => item.kind === 'tool')
        .map((item: { source: string }) => item.source)).toEqual(['local', 'local', 'mcp']);
      expect(repository.getSession(session.id)?.mode).toBe('online');
    } finally {
      await new Promise<void>((resolve) => onlineServer.close(() => resolve()));
    }
  });
});
