import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Repository } from '../storage/repository';

const pointSchema = z.object({
  at: z.iso.datetime({ offset: true }), temperature_c: z.number().nullable(),
  vibration_mm_s: z.number().nonnegative(), cooling_flow_l_min: z.number().nonnegative(),
}).strict();
const episodeSchema = z.object({
  case_id: z.string(), line_id: z.string(), equipment_id: z.string(),
  points: z.array(pointSchema).min(2),
  verification_action_id: z.enum(['cooling_check', 'process_check', 'sensor_check', 'bearing_check']).nullable(),
  verification_points: z.array(pointSchema),
}).strict();
const datasetSchema = z.object({
  version: z.string(), data_type: z.literal('synthetic'),
  thresholds: z.object({ temperature_high_c: z.number(), vibration_high_mm_s: z.number().positive(),
    cooling_flow_low_l_min: z.number().positive() }).strict(),
  episodes: z.array(episodeSchema).min(1),
}).strict();

export type OperationsDataset = z.infer<typeof datasetSchema>;
export type TelemetryPoint = z.infer<typeof pointSchema>;
export type OperationsEpisode = z.infer<typeof episodeSchema>;
export type Assessment = {
  state: 'NORMAL' | 'WATCH' | 'ALARM' | 'DATA_GAP';
  reason: string; evidence_ids: string[];
  recommendation: { action_id: NonNullable<OperationsEpisode['verification_action_id']>;
    title: string; role: string; sop_id: string } | null;
};

const actions = {
  cooling_check: { title: '人工检查冷却回路与流量记录', role: '设备维修员', sop_id: 'SOP-COOL-01' },
  process_check: { title: '人工复核工艺负载与测温链路', role: '工艺工程师', sop_id: 'SOP-COOL-01' },
  sensor_check: { title: '人工核查温度采集链路并补采', role: '仪表/设备维修员', sop_id: 'SOP-DATA-04' },
  bearing_check: { title: '人工检查轴承与润滑状态', role: '设备维修员', sop_id: 'SOP-VIB-02' },
} as const;

export function loadOperationsDataset(repository: Repository,
  path = join(process.cwd(), 'data', 'operations.json')): OperationsDataset {
  const data = datasetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (new Set(data.episodes.map((item) => item.case_id)).size !== data.episodes.length ||
    data.episodes.length !== repository.listCases().length) {
    throw new Error('Operations episodes must cover each case exactly once');
  }
  for (const episode of data.episodes) {
    const source = repository.getCase(episode.case_id);
    const latest = episode.points.at(-1)!;
    if (!source || source.line_id !== episode.line_id || source.equipment_id !== episode.equipment_id ||
      latest.at.slice(0, 10) !== source.snapshot_date ||
      latest.temperature_c !== source.current.temperature_c ||
      latest.vibration_mm_s !== source.current.vibration_mm_s ||
      (episode.verification_action_id === null) !== (episode.verification_points.length === 0) ||
      (episode.verification_action_id !== null && episode.verification_points.length !== 2)) {
      throw new Error(`Invalid operations episode ${episode.case_id}`);
    }
    const allPoints = [...episode.points, ...episode.verification_points];
    if (allPoints.some((point, index) => index > 0 && Date.parse(point.at) <= Date.parse(allPoints[index - 1].at))) {
      throw new Error(`Operations timestamps out of order for ${episode.case_id}`);
    }
    const expectedAction = assessOperations(episode, data.thresholds, episode.points.length - 1)
      .recommendation?.action_id ?? null;
    if (episode.verification_action_id !== expectedAction) {
      throw new Error(`Verification action does not match ${episode.case_id} assessment`);
    }
  }
  return data;
}

function flags(point: TelemetryPoint, thresholds: OperationsDataset['thresholds']) {
  return {
    temperature: point.temperature_c !== null && point.temperature_c >= thresholds.temperature_high_c,
    vibration: point.vibration_mm_s >= thresholds.vibration_high_mm_s,
    flow: point.cooling_flow_l_min <= thresholds.cooling_flow_low_l_min,
  };
}

function evidenceId(caseId: string, index: number) { return `TEL-${caseId}-${String(index + 1).padStart(3, '0')}`; }

export function assessOperations(episode: OperationsEpisode, thresholds: OperationsDataset['thresholds'],
  through: number): Assessment {
  if (!Number.isInteger(through) || through < 0 || through >= episode.points.length) throw new Error('Invalid telemetry index');
  const latest = episode.points[through];
  const previous = through > 0 ? episode.points[through - 1] : null;
  const lastEvidence = [evidenceId(episode.case_id, through)];
  if (latest.temperature_c === null) return {
    state: 'DATA_GAP', reason: '温度测点缺失；不能将缺失值当作正常读数，也不能确认根因。',
    evidence_ids: lastEvidence,
    recommendation: { action_id: 'sensor_check', ...actions.sensor_check },
  };
  const now = flags(latest, thresholds);
  const before = previous && previous.temperature_c !== null ? flags(previous, thresholds) : null;
  const confirmed = {
    temperature: now.temperature && before?.temperature,
    vibration: now.vibration && before?.vibration,
    flow: now.flow && before?.flow,
  };
  const pairEvidence = before ? [evidenceId(episode.case_id, through - 1), ...lastEvidence] : lastEvidence;
  if (confirmed.temperature && confirmed.flow) return {
    state: 'ALARM', reason: '连续两次温度升高且冷却流量偏低；冷却回路是待核查线索，不能据此确认故障。',
    evidence_ids: pairEvidence, recommendation: { action_id: 'cooling_check', ...actions.cooling_check },
  };
  if (confirmed.vibration) return {
    state: 'ALARM', reason: '连续两次振动越阈；轴承和润滑状态需要现场核查。',
    evidence_ids: pairEvidence, recommendation: { action_id: 'bearing_check', ...actions.bearing_check },
  };
  if (confirmed.temperature) return {
    state: 'ALARM', reason: '连续两次温度越阈，冷却流量未同步偏低；需复核负载与测温链路。',
    evidence_ids: pairEvidence, recommendation: { action_id: 'process_check', ...actions.process_check },
  };
  if (now.temperature || now.vibration || now.flow) return {
    state: 'WATCH', reason: '单次越阈，等待下一次同测点采样确认；不据此触发人工处置建议。',
    evidence_ids: lastEvidence, recommendation: null,
  };
  return { state: 'NORMAL', reason: '当前测点未越阈；仅表示本组时序测点正常。',
    evidence_ids: lastEvidence, recommendation: null };
}

export function verifyOperations(episode: OperationsEpisode, thresholds: OperationsDataset['thresholds'],
  actionId: string) {
  const assessment = assessOperations(episode, thresholds, episode.points.length - 1);
  if (!assessment.recommendation || assessment.recommendation.action_id !== actionId ||
    episode.verification_action_id !== actionId) throw new Error('No verification fixture for this action');
  const checks = episode.verification_points.map((point) => ({
    at: point.at, data_complete: point.temperature_c !== null,
    within_limits: point.temperature_c !== null && !Object.values(flags(point, thresholds)).some(Boolean),
  }));
  const passed = checks.length === 2 && checks.every((item) => item.data_complete && item.within_limits);
  return {
    case_id: episode.case_id, action_id: actionId, data_type: 'synthetic' as const,
    result: passed ? 'PASS' as const : 'FAIL' as const,
    points: episode.verification_points, checks,
    message: passed ? '两次连续复测数据完整且未越阈；仍需人员确认设备与产量/质量状态。'
      : '复测仍有缺失或越阈；不能宣称异常解除，需升级人工调查。',
  };
}
