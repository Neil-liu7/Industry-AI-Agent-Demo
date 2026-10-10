export const workOrderAssignees = [
  { id: 'line_operator', name: '产线操作员' },
  { id: 'equipment_technician', name: '设备维修员' },
  { id: 'quality_engineer', name: '质量工程师' },
  { id: 'process_engineer', name: '工艺工程师' },
] as const;

export type WorkOrderAssignee = (typeof workOrderAssignees)[number]['id'];
export type WorkOrderStatus = 'open' | 'in_progress' | 'completed';
export type InspectionFinding = 'normal' | 'abnormal' | 'uncertain';
export type WorkOrder = {
  id: string;
  session_id: string;
  case_id: string;
  equipment_id: string;
  created_at: string;
  updated_at: string;
  assignee: WorkOrderAssignee;
  risk_level: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  status: WorkOrderStatus;
  diagnosis_summary: string;
  evidence_ids: string[];
  checklist: Array<{ id: string; description: string; completed: boolean;
    finding?: InspectionFinding; note?: string; checked_at?: string }>;
  incident?: import('../operations').IncidentContext | null;
  sop?: { id: string; title: string; version: string } | null;
  recheck?: { action_id: string; result: 'PASS' | 'FAIL'; checked_at: string;
    evidence_ids: string[]; checks: Array<{ at: string; evidence_id: string;
      data_complete: boolean; within_limits: boolean }>; message: string } | null;
  resolution?: { confirmed_at: string; note: string; production_confirmed: true;
    quality_confirmed: true } | null;
};
