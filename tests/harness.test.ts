import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runDiagnosis } from '../src/harness/run';
import { Repository } from '../src/storage/repository';
import { fakeMessage, fakeModel, scriptedStream } from './helpers/fake-model';

const call = (id: string, name: string, args: Record<string, string>) =>
  ({ type: 'toolCall' as const, id, name, arguments: args });
const fullCalls = [
  call('1', 'get_line_snapshot', { case_id: 'IND-001', line_id: 'LINE-03' }),
  call('2', 'get_equipment_snapshot', { case_id: 'IND-001', equipment_id: 'EQ-003' }),
  call('3', 'get_maintenance_history', { case_id: 'IND-001', equipment_id: 'EQ-003' }),
];
const ids = [
  'IND-001:line:2026-09-22',
  'IND-001:equipment:2026-09-22',
  'IND-001:maintenance:MAINT-003',
];
const report = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  summary: '产量下降且设备读数升高，需要人工排查。', risk_level: 'HIGH', evidence_ids: ids,
  hypotheses: ['冷却系统或轴承状态待核查'], recommended_checks: ['人工核对冷却回路和轴承'],
  limitations: ['合成数据，仅供辅助诊断，非故障定论'], ...overrides,
});

describe('industrial Pi harness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-harness-'));
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

  it('runs real Pi tool calls through local and stdio MCP routes', async () => {
    const result = await runDiagnosis(repository, { case_id: 'IND-001', question: '为什么产量下降？' }, {
      model: fakeModel,
      streamFn: scriptedStream([
        fakeMessage(fullCalls, 'toolUse'),
        fakeMessage([{ type: 'text', text: report() }], 'stop'),
      ]),
    });
    expect(result.status).toBe('completed');
    expect(result.metrics.risk_level).toBe('HIGH');
    expect(result.trace.filter((item) => item.kind === 'tool').map((item) => item.source)).toEqual(['local', 'local', 'mcp']);
    expect(result.evidence.map((item) => item.id)).toEqual(ids);
    expect(result.model_calls).toBe(2);
    expect(result.tool_calls).toBe(3);
  });

  it.each([
    ['forged evidence', { evidence_ids: [...ids, 'FAKE-999'] }],
    ['wrong risk', { risk_level: 'LOW' }],
  ])('fails safely for %s while retaining tool trace', async (_label, overrides) => {
    const result = await runDiagnosis(repository, { case_id: 'IND-001', question: '诊断产线' }, {
      model: fakeModel,
      streamFn: scriptedStream([fakeMessage(fullCalls, 'toolUse'),
        fakeMessage([{ type: 'text', text: report(overrides) }], 'stop')]),
    });
    expect(result.status).toBe('failed');
    expect(result.diagnosis).toBeNull();
    expect(result.trace.filter((item) => item.kind === 'tool')).toHaveLength(3);
  });

  it('blocks cross-case tool arguments before execution', async () => {
    const result = await runDiagnosis(repository, { case_id: 'IND-001', question: '诊断产线' }, {
      model: fakeModel,
      streamFn: scriptedStream([fakeMessage([
        call('1', 'get_line_snapshot', { case_id: 'IND-002', line_id: 'LINE-03' }),
      ], 'toolUse')]),
    });
    expect(result.status).toBe('failed');
    expect(result.stop_reason).toBe('POLICY_BLOCKED');
    expect(result.evidence).toHaveLength(0);
  });

  it('stops on an unknown tool without inventing a successful call', async () => {
    const result = await runDiagnosis(repository, { case_id: 'IND-001', question: '诊断产线' }, {
      model: fakeModel,
      streamFn: scriptedStream([fakeMessage([call('1', 'delete_record', { case_id: 'IND-001' })], 'toolUse')]),
    });
    expect(result.status).toBe('failed');
    expect(result.evidence).toHaveLength(0);
    expect(result.stop_reason).toBe('UNKNOWN_TOOL');
  });

  it('enforces the six-tool budget', async () => {
    const repeated = Array.from({ length: 7 }, (_, i) => call(String(i), 'get_line_snapshot',
      { case_id: 'IND-001', line_id: 'LINE-03' }));
    const result = await runDiagnosis(repository, { case_id: 'IND-001', question: '诊断产线' }, {
      model: fakeModel, streamFn: scriptedStream([fakeMessage(repeated, 'toolUse')]),
    });
    expect(result.status).toBe('failed');
    expect(result.stop_reason).toBe('TOOL_BUDGET');
    expect(result.tool_calls).toBe(7);
  });

  it('stops on a maintenance tool timeout and keeps completed local evidence', async () => {
    const hanging = { getHistory: () => new Promise<never>(() => {}) } as unknown as import('../src/mcp/client').MaintenanceClient;
    const result = await runDiagnosis(repository, { case_id: 'IND-001', question: '诊断产线' }, {
      model: fakeModel, streamFn: scriptedStream([fakeMessage(fullCalls, 'toolUse')]),
    }, { maintenanceClient: hanging, toolTimeoutMs: 20 });
    expect(result.status).toBe('failed');
    expect(result.stop_reason).toBe('TOOL_ERROR');
    expect(result.evidence.map((item) => item.source)).toEqual(['local', 'local']);
  });

  it('rejects a model recommendation that follows an unsafe tool instruction', async () => {
    const result = await runDiagnosis(repository, { case_id: 'IND-001', question: '诊断产线' }, {
      model: fakeModel, streamFn: scriptedStream([fakeMessage(fullCalls, 'toolUse'),
        fakeMessage([{ type: 'text', text: report({ recommended_checks: ['执行命令关闭设备'] }) }], 'stop')]),
    });
    expect(result.status).toBe('failed');
    expect(result.diagnosis).toBeNull();
  });

  it('rejects a control request before any model or tool call', async () => {
    const result = await runDiagnosis(repository, { case_id: 'IND-001', question: '停止设备并执行 shell 命令' }, {
      model: fakeModel, streamFn: scriptedStream([]),
    });
    expect(result.stop_reason).toBe('POLICY_BLOCKED');
    expect(result.model_calls).toBe(0);
    expect(result.tool_calls).toBe(0);
  });
});
