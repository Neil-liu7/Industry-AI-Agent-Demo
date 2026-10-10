import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { IncidentContext } from '../operations';

const machineSchema = z.object({ id: z.string().min(1), name: z.string().min(1), energy_kw: z.number().positive() }).strict();
const orderSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), due_h: z.number().positive(),
  duration_h: z.record(z.string(), z.number().positive()),
}).strict();
const datasetSchema = z.object({
  version: z.string().min(1), data_type: z.literal('synthetic'), line_id: z.string().min(1),
  incident_source: z.object({ case_id: z.string().min(1), equipment_id: z.string().min(1),
    machine_id: z.string().min(1) }).strict(),
  machines: z.array(machineSchema).min(2), orders: z.array(orderSchema).min(1),
}).strict();

export type SchedulingDataset = z.infer<typeof datasetSchema>;
export type SchedulingStrategy = 'deadline_first' | 'energy_first';
export type ScheduleResult = {
  strategy: SchedulingStrategy; unavailable_machine_id: string | null;
  assignments: Array<{ order_id: string; order_title: string; machine_id: string; machine_name: string;
    start_h: number; end_h: number; due_h: number; late_h: number; energy_kwh: number }>;
  kpis: { makespan_h: number; total_late_h: number; late_orders: number; energy_kwh: number };
};
export type IncidentScheduleImpact = {
  data_type: 'synthetic'; case_id: string; line_id: string; equipment_id: string; machine_id: string;
  incident: IncidentContext;
  baseline: Record<SchedulingStrategy, ScheduleResult>;
  disrupted: Record<SchedulingStrategy, ScheduleResult>;
  recommended_strategy: SchedulingStrategy;
};
export type ScheduleDecision = {
  id: string; case_id: string; work_order_id: string; created_at: string;
  strategy: SchedulingStrategy; note: string; impact: IncidentScheduleImpact;
};

export function loadSchedulingDataset(path = join(process.cwd(), 'data', 'scheduling.json')): SchedulingDataset {
  const data = datasetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const machineIds = new Set(data.machines.map((item) => item.id));
  if (machineIds.size !== data.machines.length || !machineIds.has(data.incident_source.machine_id) ||
    new Set(data.orders.map((item) => item.id)).size !== data.orders.length ||
    data.orders.some((order) => Object.keys(order.duration_h).length === 0 ||
      Object.keys(order.duration_h).some((id) => !machineIds.has(id)))) {
    throw new Error('Scheduling dataset has duplicate or incompatible IDs');
  }
  return data;
}

const round = (value: number) => Math.round(value * 10) / 10;

export function simulateSchedule(data: SchedulingDataset, strategy: SchedulingStrategy,
  unavailableMachineId: string | null = null): ScheduleResult {
  if (unavailableMachineId !== null && !data.machines.some((item) => item.id === unavailableMachineId)) {
    throw new Error('Unknown unavailable machine');
  }
  const availableAt = new Map(data.machines.map((item) => [item.id, 0]));
  const assignments: ScheduleResult['assignments'] = [];
  const ordered = [...data.orders].sort((left, right) => left.due_h - right.due_h || left.id.localeCompare(right.id));
  for (const order of ordered) {
    const candidates = data.machines.filter((machine) => machine.id !== unavailableMachineId &&
      order.duration_h[machine.id] !== undefined);
    if (candidates.length === 0) throw new Error(`No compatible machine for ${order.id}`);
    candidates.sort((left, right) => {
      const leftScore = strategy === 'deadline_first'
        ? availableAt.get(left.id)! + order.duration_h[left.id] : left.energy_kw * order.duration_h[left.id];
      const rightScore = strategy === 'deadline_first'
        ? availableAt.get(right.id)! + order.duration_h[right.id] : right.energy_kw * order.duration_h[right.id];
      return leftScore - rightScore || left.id.localeCompare(right.id);
    });
    const machine = candidates[0];
    const start = availableAt.get(machine.id)!;
    const end = round(start + order.duration_h[machine.id]);
    availableAt.set(machine.id, end);
    assignments.push({
      order_id: order.id, order_title: order.title, machine_id: machine.id, machine_name: machine.name,
      start_h: start, end_h: end, due_h: order.due_h,
      late_h: round(Math.max(0, end - order.due_h)), energy_kwh: round(order.duration_h[machine.id] * machine.energy_kw),
    });
  }
  return {
    strategy, unavailable_machine_id: unavailableMachineId, assignments,
    kpis: {
      makespan_h: Math.max(...assignments.map((item) => item.end_h)),
      total_late_h: round(assignments.reduce((sum, item) => sum + item.late_h, 0)),
      late_orders: assignments.filter((item) => item.late_h > 0).length,
      energy_kwh: round(assignments.reduce((sum, item) => sum + item.energy_kwh, 0)),
    },
  };
}

export function simulateIncidentImpact(data: SchedulingDataset, incident: IncidentContext): IncidentScheduleImpact {
  if (incident.state !== 'ALARM') throw new Error('Only a confirmed alarm can disrupt this schedule');
  const { case_id, equipment_id, machine_id } = data.incident_source;
  const baseline = {
    deadline_first: simulateSchedule(data, 'deadline_first'),
    energy_first: simulateSchedule(data, 'energy_first'),
  };
  const disrupted = {
    deadline_first: simulateSchedule(data, 'deadline_first', machine_id),
    energy_first: simulateSchedule(data, 'energy_first', machine_id),
  };
  const deadline = disrupted.deadline_first.kpis;
  const energy = disrupted.energy_first.kpis;
  const recommended_strategy = deadline.total_late_h < energy.total_late_h ||
    (deadline.total_late_h === energy.total_late_h && deadline.energy_kwh <= energy.energy_kwh)
    ? 'deadline_first' : 'energy_first';
  return { data_type: 'synthetic', case_id, line_id: data.line_id, equipment_id, machine_id,
    incident, baseline, disrupted, recommended_strategy };
}
