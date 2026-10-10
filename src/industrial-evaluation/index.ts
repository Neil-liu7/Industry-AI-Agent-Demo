import { assessOperations, telemetryEvidence, type OperationsDataset } from '../operations';
import { simulateIncidentImpact, type ScheduleResult, type SchedulingDataset } from '../scheduling';
import type { Repository } from '../storage/repository';

export function scheduleConstraintViolations(data: SchedulingDataset, result: ScheduleResult): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const assignment of result.assignments) {
    const order = data.orders.find((item) => item.id === assignment.order_id);
    const machine = data.machines.find((item) => item.id === assignment.machine_id);
    if (seen.has(assignment.order_id)) violations.push(`Duplicate order ${assignment.order_id}`);
    seen.add(assignment.order_id);
    if (!order || !machine || order.duration_h[assignment.machine_id] === undefined ||
      assignment.machine_id === result.unavailable_machine_id || assignment.start_h < 0 ||
      assignment.end_h <= assignment.start_h ||
      Math.abs((assignment.end_h - assignment.start_h) - order.duration_h[assignment.machine_id]) > 0.05) {
      violations.push(`Invalid assignment ${assignment.order_id}`);
    }
  }
  for (const order of data.orders) if (!seen.has(order.id)) violations.push(`Missing order ${order.id}`);
  for (const machine of data.machines) {
    const lane = result.assignments.filter((item) => item.machine_id === machine.id)
      .sort((left, right) => left.start_h - right.start_h);
    for (let index = 1; index < lane.length; index++) {
      if (lane[index].start_h < lane[index - 1].end_h) violations.push(`Machine overlap ${machine.id}`);
    }
  }
  return violations;
}

export function evaluateIndustrialOutcome(repository: Repository, operations: OperationsDataset,
  scheduling: SchedulingDataset) {
  const alarms = operations.episodes.flatMap((episode) => {
    const states = episode.points.map((_, index) => assessOperations(episode, operations.thresholds, index));
    const alarmIndex = states.findIndex((state) => state.state === 'ALARM');
    if (alarmIndex < 0) return [];
    const watchIndex = states.findIndex((state, index) => index < alarmIndex && state.state === 'WATCH');
    return [{ case_id: episode.case_id, equipment_id: episode.equipment_id,
      first_watch_at: watchIndex < 0 ? null : episode.points[watchIndex].at,
      confirmed_at: episode.points[alarmIndex].at,
      confirmation_minutes: watchIndex < 0 ? null :
        (Date.parse(episode.points[alarmIndex].at) - Date.parse(episode.points[watchIndex].at)) / 60000,
      evidence_ids: states[alarmIndex].evidence_ids }];
  });
  const episode = operations.episodes.find((item) => item.case_id === scheduling.incident_source.case_id)!;
  const impact = simulateIncidentImpact(scheduling, telemetryEvidence(episode, operations.thresholds).incident);
  const violations = [impact.disrupted.deadline_first, impact.disrupted.energy_first]
    .flatMap((result) => scheduleConstraintViolations(scheduling, result));
  return { data_type: 'synthetic' as const, alarms,
    scheduling: { case_id: impact.case_id, machine_id: impact.machine_id,
      constraint_violations: violations,
      deadline_first_late_h: impact.disrupted.deadline_first.kpis.total_late_h,
      energy_first_late_h: impact.disrupted.energy_first.kpis.total_late_h,
      delay_saved_h: Number((impact.disrupted.energy_first.kpis.total_late_h -
        impact.disrupted.deadline_first.kpis.total_late_h).toFixed(1)),
      extra_energy_kwh: Number((impact.disrupted.deadline_first.kpis.energy_kwh -
        impact.disrupted.energy_first.kpis.energy_kwh).toFixed(1)),
      human_choices: repository.listScheduleDecisions(impact.case_id).length },
    imports: repository.listCases().map((item) => ({ case_id: item.case_id,
      batches: repository.listTelemetryImports(item.case_id).length,
      bad_samples: repository.listTelemetryImports(item.case_id).reduce((sum, record) => sum + record.bad_samples, 0) })),
  };
}

export type IndustrialOutcome = ReturnType<typeof evaluateIndustrialOutcome>;
