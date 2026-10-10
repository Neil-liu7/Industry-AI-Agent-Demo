import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IndustrialCase } from '../domain/cases';
import { assessOperations, type Assessment, type OperationsDataset, type OperationsEpisode } from '../operations';

const header = 'case_id,line_id,equipment_id,at,temperature_c,vibration_mm_s,cooling_flow_l_min,quality';
export type ImportedPoint = {
  evidence_id: string; at: string; temperature_c: number | null;
  vibration_mm_s: number | null; cooling_flow_l_min: number | null; quality: 'GOOD' | 'BAD';
};
export type TelemetryImport = {
  id: string; case_id: string; line_id: string; equipment_id: string; created_at: string;
  data_type: 'uploaded_csv'; units: { temperature: '°C'; vibration: 'mm/s'; cooling_flow: 'L/min' };
  points: ImportedPoint[]; bad_samples: number; assessment: Assessment;
};

function readNumber(value: string): number | null {
  if (value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('CSV contains a nonnumeric measurement');
  return parsed;
}

export function importTelemetryCsv(csv: string, selected: IndustrialCase,
  thresholds: OperationsDataset['thresholds']): TelemetryImport {
  const lines = csv.trim().replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0] !== header || lines.length < 3 || lines.length > 51 || csv.includes('"')) {
    throw new Error('Expected the documented CSV header and 2–50 unquoted samples');
  }
  const id = randomUUID();
  const points: ImportedPoint[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const fields = line.split(',').map((item) => item.trim());
    if (fields.length !== 8 || fields[0] !== selected.case_id || fields[1] !== selected.line_id ||
      fields[2] !== selected.equipment_id || !z.iso.datetime({ offset: true }).safeParse(fields[3]).success ||
      (fields[7] !== 'GOOD' && fields[7] !== 'BAD')) {
      throw new Error(`CSV row ${index + 2} has invalid asset scope, timestamp or quality`);
    }
    if (points.length && Date.parse(fields[3]) <= Date.parse(points.at(-1)!.at)) {
      throw new Error(`CSV row ${index + 2} is not later than the previous sample`);
    }
    const [temperature_c, vibration_mm_s, cooling_flow_l_min] = fields.slice(4, 7).map(readNumber);
    if (vibration_mm_s !== null && vibration_mm_s < 0 || cooling_flow_l_min !== null && cooling_flow_l_min < 0 ||
      fields[7] === 'GOOD' && (temperature_c === null || vibration_mm_s === null || cooling_flow_l_min === null)) {
      throw new Error(`CSV row ${index + 2} has incomplete or invalid measurements`);
    }
    points.push({ evidence_id: `${id}:${String(index + 1).padStart(3, '0')}`, at: fields[3],
      temperature_c, vibration_mm_s, cooling_flow_l_min, quality: fields[7] as 'GOOD' | 'BAD' });
  }
  const bad_samples = points.filter((point) => point.quality === 'BAD').length;
  let assessment: Assessment;
  if (bad_samples) {
    assessment = { state: 'DATA_GAP', reason: `${bad_samples} 个样本标为 BAD；整批数据不能用于告警确认，请复核并补采。`,
      evidence_ids: points.filter((point) => point.quality === 'BAD').map((point) => point.evidence_id),
      recommendation: null };
  } else {
    const episode: OperationsEpisode = {
      case_id: selected.case_id, line_id: selected.line_id, equipment_id: selected.equipment_id,
      points: points.map((point) => ({ at: point.at, temperature_c: point.temperature_c!,
        vibration_mm_s: point.vibration_mm_s!, cooling_flow_l_min: point.cooling_flow_l_min! })),
      verification_action_id: null, verification_points: [],
    };
    const result = assessOperations(episode, thresholds, episode.points.length - 1);
    assessment = { ...result, evidence_ids: result.evidence_ids.map((evidenceId) =>
      points[Number(evidenceId.slice(-3)) - 1].evidence_id) };
  }
  return { id, case_id: selected.case_id, line_id: selected.line_id, equipment_id: selected.equipment_id,
    created_at: new Date().toISOString(), data_type: 'uploaded_csv',
    units: { temperature: '°C', vibration: 'mm/s', cooling_flow: 'L/min' },
    points, bad_samples, assessment };
}
