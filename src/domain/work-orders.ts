export const workOrderAssignees = [
  { id: 'line_operator', name: '产线操作员' },
  { id: 'equipment_technician', name: '设备维修员' },
  { id: 'quality_engineer', name: '质量工程师' },
  { id: 'process_engineer', name: '工艺工程师' },
] as const;

export type WorkOrderAssignee = (typeof workOrderAssignees)[number]['id'];
export type WorkOrderStatus = 'open' | 'in_progress' | 'completed';
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
  checklist: Array<{ id: string; description: string; completed: boolean }>;
};
