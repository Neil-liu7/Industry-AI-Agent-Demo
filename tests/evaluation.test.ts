import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { createApp } from '../src/app/api';
import { calculateMetrics, evidenceIds } from '../src/domain/cases';
import { loadEvaluationSuite } from '../src/evaluation';
import { Repository } from '../src/storage/repository';
import { fakeMessage, fakeModel, scriptedStream } from './helpers/fake-model';
import type { AssistantMessage } from '@earendil-works/pi-ai';

describe('repeatable online evaluation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-evaluation-'));
  const path = join(dir, 'demo.sqlite');
  let repository: Repository;
  let server: Server;
  let base: string;
  let wrongRiskCase: string | null = null;
  let patrolSkill = false;

  function messages(): AssistantMessage[] {
    return repository.listCases().flatMap((data) => {
      const ids = evidenceIds(data);
      const toolCalls: AssistantMessage['content'] = [
        ...(!patrolSkill ? [{ type: 'toolCall' as const, id: `${data.case_id}-line`, name: 'get_line_snapshot',
          arguments: { case_id: data.case_id, line_id: data.line_id } }] : []),
        { type: 'toolCall', id: `${data.case_id}-equipment`, name: 'get_equipment_snapshot',
          arguments: { case_id: data.case_id, equipment_id: data.equipment_id } },
        { type: 'toolCall', id: `${data.case_id}-maintenance`, name: 'get_maintenance_history',
          arguments: { case_id: data.case_id, equipment_id: data.equipment_id } },
      ];
      const diagnosis = {
        summary: '仅供人工核查的合成案例诊断。',
        risk_level: data.case_id === wrongRiskCase ? 'LOW' : calculateMetrics(data).risk_level,
        evidence_ids: patrolSkill ? [ids.equipment, ids.maintenance] : [ids.line, ids.equipment, ids.maintenance],
        hypotheses: [], recommended_checks: ['人工复核设备和数据'], limitations: ['合成数据'],
      };
      return [fakeMessage(toolCalls, 'toolUse'),
        fakeMessage([{ type: 'text', text: JSON.stringify(diagnosis) }], 'stop')];
    });
  }

  beforeAll(async () => {
    process.env.DATA_DIR = dir;
    repository = new Repository(path);
    repository.seed();
    server = createApp(repository, () => ({ model: fakeModel, streamFn: scriptedStream(messages()) }))
      .listen(0, '127.0.0.1');
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

  const post = (body: unknown) => fetch(base + '/api/evaluations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it('validates the versioned suite against all synthetic cases', () => {
    const suite = loadEvaluationSuite(repository);
    expect(suite.cases.map((item) => item.case_id)).toEqual([
      'IND-001', 'IND-002', 'IND-003', 'IND-004', 'IND-005',
    ]);
    const original = repository.getCase('IND-001')!;
    repository.db.prepare('UPDATE cases SET payload = ? WHERE case_id = ?')
      .run(JSON.stringify({ ...original, current: { ...original.current, daily_output_units: 1000 } }), 'IND-001');
    expect(() => loadEvaluationSuite(repository)).toThrow('does not match');
    repository.seed();
  });

  it('records real Pi and MCP runs for each fixed case without counting replay', async () => {
    const empty = await (await fetch(base + '/api/evaluations')).json();
    expect(empty.suite.version).toBe('1.0.0');
    expect(empty.runs).toEqual([]);
    expect((await post({ skill_id: 'missing' })).status).toBe(400);
    const response = await post({ skill_id: 'line-anomaly-diagnosis' });
    expect(response.status).toBe(200);
    const run = await response.json();
    expect(run.data_type).toBe('synthetic');
    expect(run.model).toEqual({ provider: 'openai', name: 'fake' });
    expect(run.passed_count).toBe(5);
    expect(run.total_count).toBe(5);
    expect(run.cases.every((item: { passed: boolean; tools_complete: boolean; evidence_complete: boolean }) =>
      item.passed && item.tools_complete && item.evidence_complete)).toBe(true);
    expect(run.cases.find((item: { case_id: string }) => item.case_id === 'IND-004').abstained_when_unknown).toBe(true);
    for (const item of run.cases) {
      const session = repository.getSession(item.session_id)!;
      expect(session.mode).toBe('online');
      expect(session.tool_calls).toBe(3);
      expect(session.trace.filter((trace) => trace.kind === 'tool').map((trace) => trace.source))
        .toEqual(['local', 'local', 'mcp']);
    }
    expect((await (await fetch(base + `/api/evaluations/${run.id}`)).json()).id).toBe(run.id);
  }, 15000);

  it('evaluates the equipment patrol Skill with its narrower tool allowlist', async () => {
    patrolSkill = true;
    try {
      const response = await post({ skill_id: 'equipment-priority-patrol' });
      expect(response.status).toBe(200);
      const run = await response.json();
      expect(run.skill.id).toBe('equipment-priority-patrol');
      expect(run.passed_count).toBe(5);
      expect(run.cases.every((item: { tool_calls: number }) => item.tool_calls === 2)).toBe(true);
      for (const item of run.cases) {
        const session = repository.getSession(item.session_id)!;
        expect(session.trace.filter((trace) => trace.kind === 'tool').map((trace) => trace.source))
          .toEqual(['local', 'mcp']);
      }
    } finally { patrolSkill = false; }
  });

  it('keeps failed model output in the denominator and persists all runs', async () => {
    wrongRiskCase = 'IND-003';
    const response = await post({ skill_id: 'line-anomaly-diagnosis' });
    expect(response.status).toBe(200);
    const run = await response.json();
    expect(run.passed_count).toBe(4);
    const failed = run.cases.find((item: { case_id: string }) => item.case_id === 'IND-003');
    expect(failed).toMatchObject({ passed: false, status: 'failed', risk_consistent: false,
      tools_complete: true, evidence_complete: false });
    expect(repository.getSession(failed.session_id)?.diagnosis).toBeNull();
    const reopened = new Repository(path);
    try {
      expect(reopened.listEvaluations()).toHaveLength(3);
      expect(reopened.listSessions({ mode: 'online' }).items).toHaveLength(15);
    } finally { reopened.close(); }
  });
});
