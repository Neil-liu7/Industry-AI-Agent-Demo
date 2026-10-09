import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculateMetrics, evidenceIds } from '../domain/cases';
import { Repository } from '../storage/repository';
import { loadSkills, selectSkill } from '../skills';
import { validateDiagnosis } from './diagnosis';
import type { Evidence, RunResult, ToolTrace, Trace } from './run';

export function createReplay(repository: Repository, caseId: string, question = '请演示此案例的辅助诊断流程'): RunResult {
  const data = repository.getCase(caseId);
  if (!data) throw new Error('Unknown case_id');
  const skill = selectSkill(loadSkills(), question, 'line-anomaly-diagnosis');
  const metrics = calculateMetrics(data);
  const recordings = JSON.parse(readFileSync(join(process.cwd(), 'data', 'replays.json'), 'utf8')) as Record<string, unknown>;
  const ids = evidenceIds(data);
  const sourceData = {
    get_line_snapshot: { id: ids.line, source: 'local' as const, data: { baseline: data.baseline, current: data.current } },
    get_equipment_snapshot: { id: ids.equipment, source: 'local' as const, data: { baseline: data.baseline, current: data.current } },
    get_maintenance_history: { id: ids.maintenance, source: 'mcp' as const, data: { ...data.maintenance_record } },
  };
  const evidence: Evidence[] = skill.required_tools.map((tool) => ({
    id: sourceData[tool].id, source: sourceData[tool].source, tool, data: sourceData[tool].data,
  }));
  const diagnosis = validateDiagnosis(JSON.stringify(recordings[caseId]), metrics.risk_level,
    evidence.map((item) => item.id), evidence.map((item) => item.id));
  const id = randomUUID();
  const now = new Date().toISOString();
  const traceContext = { run_id: id, skill_id: skill.id, skill_version: skill.version,
    budget: { model_calls: 0, tool_calls: 0 }, stop_reason: 'REPLAY_COMPLETED' };
  const trace: Trace[] = [
    { ...traceContext, kind: 'step', name: '案例概览（预录回放）', status: 'completed',
      started_at: now, ended_at: now, duration_ms: 0,
      detail: `${data.case_id} · ${data.snapshot_date} · 合成数据` },
    { ...traceContext, kind: 'step', name: 'Skill 与 Harness（预录回放）', status: 'completed',
      started_at: now, ended_at: now, duration_ms: 0,
      detail: `${skill.name} ${skill.version} · 只读工具与证据校验` },
  ];
  for (const item of evidence) {
    const tool: ToolTrace = { ...traceContext, kind: 'tool', tool_call_id: `replay-${item.tool}`, name: item.tool,
      source: item.source, status: 'completed', replayed: true, started_at: now, ended_at: now,
      duration_ms: 0, args: { case_id: caseId }, result_summary: '预录工具结果，未现场执行',
      evidence_id: item.id, retry_count: 0 };
    trace.push(tool);
  }
  trace.push({ ...traceContext, kind: 'step', name: '诊断证据（预录回放）', status: 'completed',
    started_at: now, ended_at: now, duration_ms: 0,
    detail: diagnosis.evidence_ids.join(', ') });
  trace.push({ ...traceContext, kind: 'step', name: '报告（预录回放）', status: 'completed',
    started_at: now, ended_at: now, duration_ms: 0 });
  return {
    id, case_id: caseId, mode: 'replay', status: 'completed', created_at: now,
    question, snapshot_date: data.snapshot_date, data_type: 'synthetic',
    skill: { id: skill.id, version: skill.version, name: skill.name }, metrics, diagnosis,
    evidence, trace, stop_reason: 'REPLAY_COMPLETED', model_calls: 0, tool_calls: 0, token_usage: null,
  };
}
