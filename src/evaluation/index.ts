import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { calculateMetrics, type RiskLevel } from '../domain/cases';
import { runDiagnosis, type OnlineEngine, type RunResult } from '../harness/run';
import type { Skill } from '../skills';
import type { Repository } from '../storage/repository';

const suiteSchema = z.object({
  id: z.string().min(1), version: z.string().min(1), question: z.string().min(1),
  cases: z.array(z.object({
    case_id: z.string().min(1), expected_risk: z.enum(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),
  }).strict()).min(1),
}).strict();

export type EvaluationSuite = z.infer<typeof suiteSchema>;
export type EvaluationCase = {
  case_id: string; expected_risk: RiskLevel; session_id: string; passed: boolean;
  status: RunResult['status']; stop_reason: string; risk_consistent: boolean;
  tools_complete: boolean; evidence_complete: boolean; abstained_when_unknown: boolean;
  duration_ms: number; model_calls: number; tool_calls: number; token_usage: number | null;
};
export type EvaluationRun = {
  id: string; created_at: string; data_type: 'synthetic'; suite_id: string; suite_version: string;
  skill: RunResult['skill']; model: { provider: string; name: string };
  passed_count: number; total_count: number; mean_duration_ms: number;
  cases: EvaluationCase[];
};

export function loadEvaluationSuite(repository: Repository): EvaluationSuite {
  const suite = suiteSchema.parse(JSON.parse(readFileSync(join(process.cwd(), 'data', 'evaluation-suite.json'), 'utf8')));
  const actualCases = repository.listCases();
  const declared = new Set(suite.cases.map((item) => item.case_id));
  if (declared.size !== suite.cases.length || declared.size !== actualCases.length ||
    actualCases.some((data) => !declared.has(data.case_id)) ||
    suite.cases.some((item) => calculateMetrics(repository.getCase(item.case_id)!).risk_level !== item.expected_risk)) {
    throw new Error('Evaluation suite does not match the synthetic cases and risk rules');
  }
  return suite;
}

function grade(session: RunResult, expectedRisk: RiskLevel, skill: Skill, durationMs: number): EvaluationCase {
  const completedTools = new Set(session.trace.filter((item) =>
    item.kind === 'tool' && item.status === 'completed' && !item.replayed).map((item) => item.name));
  const toolsComplete = skill.required_tools.every((name) => completedTools.has(name));
  const evidenceComplete = skill.required_tools.every((name) => session.evidence.some((item) =>
    item.tool === name && session.diagnosis?.evidence_ids.includes(item.id)));
  const riskConsistent = session.diagnosis?.risk_level === expectedRisk;
  const abstained = expectedRisk !== 'UNKNOWN' || Boolean(session.diagnosis &&
    session.diagnosis.hypotheses.length === 0 && session.diagnosis.recommended_checks.length > 0);
  return {
    case_id: session.case_id, expected_risk: expectedRisk, session_id: session.id,
    passed: session.status === 'completed' && riskConsistent && toolsComplete && evidenceComplete && abstained,
    status: session.status, stop_reason: session.stop_reason, risk_consistent: riskConsistent,
    tools_complete: toolsComplete, evidence_complete: evidenceComplete, abstained_when_unknown: abstained,
    duration_ms: durationMs, model_calls: session.model_calls, tool_calls: session.tool_calls,
    token_usage: session.token_usage,
  };
}

export async function runEvaluation(
  repository: Repository, suite: EvaluationSuite, skill: Skill, engine: OnlineEngine,
): Promise<EvaluationRun> {
  const cases: EvaluationCase[] = [];
  for (const task of suite.cases) {
    const started = Date.now();
    const session = await runDiagnosis(repository, {
      case_id: task.case_id, question: suite.question, skill_id: skill.id,
    }, engine);
    repository.saveSession(session);
    cases.push(grade(session, task.expected_risk, skill, Date.now() - started));
  }
  return {
    id: randomUUID(), created_at: new Date().toISOString(), data_type: 'synthetic',
    suite_id: suite.id, suite_version: suite.version,
    skill: { id: skill.id, version: skill.version, name: skill.name },
    model: { provider: engine.model.provider, name: engine.model.id },
    passed_count: cases.filter((item) => item.passed).length, total_count: cases.length,
    mean_duration_ms: Math.round(cases.reduce((sum, item) => sum + item.duration_ms, 0) / cases.length),
    cases,
  };
}
