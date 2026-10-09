import { z } from 'zod';
import type { RiskLevel } from '../domain/cases';

export const diagnosisSchema = z.object({
  summary: z.string().min(1),
  risk_level: z.enum(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),
  evidence_ids: z.array(z.string().min(1)).min(1),
  hypotheses: z.array(z.string()),
  recommended_checks: z.array(z.string()),
  limitations: z.array(z.string()).min(1),
}).strict();

export type Diagnosis = z.infer<typeof diagnosisSchema>;

export function validateDiagnosis(text: string, risk: RiskLevel, availableIds: string[], requiredIds: string[]): Diagnosis {
  const diagnosis = diagnosisSchema.parse(JSON.parse(text));
  if (diagnosis.risk_level !== risk) throw new Error('Model risk differs from deterministic rule');
  if (new Set(diagnosis.evidence_ids).size !== diagnosis.evidence_ids.length ||
    !diagnosis.evidence_ids.every((id) => availableIds.includes(id)) ||
    !requiredIds.every((id) => diagnosis.evidence_ids.includes(id))) {
    throw new Error('Model evidence IDs are missing, duplicated or unverified');
  }
  const prose = [diagnosis.summary, ...diagnosis.hypotheses, ...diagnosis.recommended_checks].join(' ');
  if (/执行命令|运行脚本|自动提交|自动启动|自动停止|停止设备|启动设备|关闭阀门|写入设备|修改设定|run shell|execute command|start machine|stop machine/i.test(prose)) {
    throw new Error('Model recommendation exceeds read-only scope');
  }
  return diagnosis;
}
