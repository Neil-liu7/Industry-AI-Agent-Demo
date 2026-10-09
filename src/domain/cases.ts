import { z } from 'zod';

const readings = z.object({
  daily_output_units: z.number().nonnegative().nullable(),
  defect_units: z.number().nonnegative().nullable(),
  temperature_c: z.number().nullable(),
  vibration_mm_s: z.number().nonnegative().nullable(),
}).strict();

export const caseSchema = z.object({
  case_id: z.string().regex(/^IND-\d{3}$/),
  title: z.string().min(1),
  snapshot_date: z.iso.date(),
  baseline_date: z.iso.date(),
  data_type: z.literal('synthetic'),
  line_id: z.string().min(1),
  equipment_id: z.string().min(1),
  baseline: readings,
  current: readings,
  maintenance_record: z.object({
    record_id: z.string().min(1), date: z.iso.date(), summary: z.string().min(1),
  }).strict(),
}).strict();

export type IndustrialCase = z.infer<typeof caseSchema>;
export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export type CaseMetrics = {
  output_change_pct: number | null;
  baseline_defect_rate_pct: number | null;
  current_defect_rate_pct: number | null;
  defect_rate_change_pp: number | null;
  temperature_change_pct: number | null;
  vibration_change_pct: number | null;
  risk_level: RiskLevel;
};

function percentChange(baseline: number | null, current: number | null): number | null {
  if (baseline === null || current === null || baseline <= 0) return null;
  return (current - baseline) / baseline * 100;
}

function defectRate(output: number | null, defects: number | null): number | null {
  if (output === null || defects === null || output <= 0 || defects > output) return null;
  return defects / output * 100;
}

export function calculateMetrics(data: IndustrialCase): CaseMetrics {
  const output = percentChange(data.baseline.daily_output_units, data.current.daily_output_units);
  const baselineDefects = defectRate(data.baseline.daily_output_units, data.baseline.defect_units);
  const currentDefects = defectRate(data.current.daily_output_units, data.current.defect_units);
  const temperature = percentChange(data.baseline.temperature_c, data.current.temperature_c);
  const vibration = percentChange(data.baseline.vibration_mm_s, data.current.vibration_mm_s);
  const comparable = data.baseline_date < data.snapshot_date;
  const complete = comparable && [output, baselineDefects, currentDefects, temperature, vibration].every((value) => value !== null);
  let risk: RiskLevel = 'UNKNOWN';
  if (complete) {
    if (output! <= -10 && (temperature! >= 20 || vibration! >= 20)) risk = 'HIGH';
    else if (output! <= -10 || temperature! >= 20 || vibration! >= 20) risk = 'MEDIUM';
    else risk = 'LOW';
  }
  return {
    output_change_pct: output,
    baseline_defect_rate_pct: baselineDefects,
    current_defect_rate_pct: currentDefects,
    defect_rate_change_pp: baselineDefects === null || currentDefects === null ? null : currentDefects - baselineDefects,
    temperature_change_pct: temperature,
    vibration_change_pct: vibration,
    risk_level: risk,
  };
}

export function evidenceIds(data: IndustrialCase) {
  return {
    line: `${data.case_id}:line:${data.snapshot_date}`,
    equipment: `${data.case_id}:equipment:${data.snapshot_date}`,
    maintenance: `${data.case_id}:maintenance:${data.maintenance_record.record_id}`,
  };
}
