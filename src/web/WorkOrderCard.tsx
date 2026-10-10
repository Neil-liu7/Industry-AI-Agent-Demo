import { useState } from 'react';
import { workOrderAssignees, type InspectionFinding, type WorkOrder, type WorkOrderStatus } from '../domain/work-orders';

const assigneeLabel = Object.fromEntries(workOrderAssignees.map((item) => [item.id, item.name]));
const statusLabel: Record<WorkOrderStatus, string> = {
  open: '待开始', in_progress: '巡检中', completed: '检查已完成',
};
const findingLabel: Record<InspectionFinding, string> = {
  normal: '正常', abnormal: '异常', uncertain: '待确认',
};
const incidentLabel = { NORMAL: '正常', WATCH: '待确认', ALARM: '持续告警', DATA_GAP: '数据缺失' };

export function WorkOrderCard({ order, busy, onStatus, onCheck, onRecheck, onResolve }: {
  order: WorkOrder; busy: boolean;
  onStatus: (status: 'in_progress' | 'completed') => void;
  onCheck: (itemId: string, completed: boolean, finding?: InspectionFinding, note?: string) => void;
  onRecheck: () => void; onResolve: (note: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, { finding: InspectionFinding | ''; note: string }>>({});
  const [productionConfirmed, setProductionConfirmed] = useState(false);
  const [qualityConfirmed, setQualityConfirmed] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');
  const allRecorded = order.checklist.every((item) => item.completed && item.finding && item.note && item.checked_at);
  const canResolve = order.status === 'completed' && order.recheck?.result === 'PASS' &&
    order.checklist.every((item) => item.finding === 'normal') && !order.resolution;

  return <article className="work-order-card">
    <header><div><b>{order.case_id} · {order.equipment_id}</b><small>工单 {order.id.slice(0, 8)} · 来源诊断 {order.session_id.slice(0, 8)}</small></div>
      <span className={`risk risk-${order.risk_level.toLowerCase()}`}>{order.risk_level}</span>
      <span className={`work-order-status ${order.status}`}>{statusLabel[order.status]}</span></header>
    <p>{order.diagnosis_summary}</p>
    <div className="work-order-meta"><span>责任角色：{assigneeLabel[order.assignee]}</span>
      <span>更新时间：{new Date(order.updated_at).toLocaleString('zh-CN')}</span></div>
    {order.incident?.recommendation && <div className="work-order-incident">
      <b>{incidentLabel[order.incident.state]} · {order.incident.observed_at}</b>
      <span>测点证据：{order.incident.evidence_ids.join(' · ')}</span>
      <span>诊断时序证据：{order.incident.telemetry_evidence_id}</span>
      <span>人工建议：{order.incident.recommendation.title} · {order.incident.recommendation.role}</span>
      <span>依据 SOP：{order.sop ? `${order.sop.id} · ${order.sop.title} · v${order.sop.version}` : order.incident.recommendation.sop_id}</span>
    </div>}
    <ul className="work-order-checklist">{order.checklist.map((item, index) => {
      const draft = drafts[item.id] ?? { finding: '', note: '' };
      return <li key={item.id}>
        <b>{index + 1}. {item.description}</b>
        {item.completed ? <div className="inspection-record">人工记录：{item.finding ? findingLabel[item.finding] : '旧记录未分类'}
          {item.note ? ` · ${item.note}` : ''} {item.checked_at ? `· ${new Date(item.checked_at).toLocaleString('zh-CN')}` : ''}
          {order.status === 'in_progress' && <button disabled={busy} onClick={() => onCheck(item.id, false)}>撤销记录</button>}
        </div> : order.status === 'in_progress' && <div className="inspection-entry">
          <select aria-label={`检查结果 ${index + 1}`} value={draft.finding} disabled={busy}
            onChange={(event) => setDrafts((previous) => ({ ...previous, [item.id]: {
              ...draft, finding: event.target.value as InspectionFinding | '',
            } }))}>
            <option value="">选择检查结果</option><option value="normal">正常</option>
            <option value="abnormal">异常</option><option value="uncertain">待确认</option>
          </select>
          <input aria-label={`检查记录 ${index + 1}`} value={draft.note} maxLength={500} disabled={busy}
            placeholder="记录人员观察到的情况" onChange={(event) => setDrafts((previous) => ({
              ...previous, [item.id]: { ...draft, note: event.target.value },
            }))}/>
          <button disabled={busy || !draft.finding || draft.note.trim().length < 3}
            onClick={() => onCheck(item.id, true, draft.finding as InspectionFinding, draft.note.trim())}>记录检查</button>
        </div>}
      </li>;
    })}</ul>
    <div className="work-order-evidence">诊断引用证据：{order.evidence_ids.join(' · ')}</div>
    {order.status === 'open' && <div className="work-order-actions"><button disabled={busy}
      onClick={() => onStatus('in_progress')}>开始巡检</button></div>}
    {order.status === 'in_progress' && <div className="work-order-actions"><button disabled={busy || !allRecorded}
      onClick={() => onStatus('completed')}>完成检查记录</button>
      {!allRecorded && <small>逐项填写检查结果和观察记录后才能完成。</small>}</div>}
    {order.status === 'completed' && <div className="work-order-resolution">
      <b>{order.resolution ? '异常解除已由人工确认' : order.incident?.recommendation ? '检查已完成 · 异常尚未确认解除' : '常规检查已完成 · 无关联告警'}</b>
      {!allRecorded && <p>这张历史工单缺少逐项检查结果，不能直接复测或确认解除。请从新版诊断重新生成工单。</p>}
      {order.incident?.recommendation && <>
        <p>复测采用固定合成样本；通过只代表测点达标，仍需人工核对产量和质量。</p>
        {!order.resolution && <button disabled={busy || !allRecorded} onClick={onRecheck}>保存虚拟复测证据</button>}
        {order.recheck && <div className="recheck-record"><strong>{order.recheck.result === 'PASS' ? '测点复测通过' : '复测未通过'}</strong>
          <span>复测时间：{new Date(order.recheck.checked_at).toLocaleString('zh-CN')}</span>
          <span>测点证据：{order.recheck.evidence_ids.join(' · ')}</span>
          {order.recheck.checks.map((check) => <span key={check.evidence_id}>{check.at} · {check.evidence_id} · {check.within_limits ? '在界内' : '未达标或缺失'}</span>)}
          <small>{order.recheck.message}</small></div>}
        {canResolve && <div className="resolution-entry">
          <label><input type="checkbox" checked={productionConfirmed} onChange={(event) => setProductionConfirmed(event.target.checked)}/> 已人工复核产量状态</label>
          <label><input type="checkbox" checked={qualityConfirmed} onChange={(event) => setQualityConfirmed(event.target.checked)}/> 已人工复核质量状态</label>
          <textarea aria-label="异常解除确认记录" value={resolutionNote} rows={2} maxLength={1000}
            placeholder="记录产量和质量的人工复核结论（演示）" onChange={(event) => setResolutionNote(event.target.value)}/>
          <button disabled={busy || !productionConfirmed || !qualityConfirmed || resolutionNote.trim().length < 10}
            onClick={() => onResolve(resolutionNote.trim())}>人工确认异常解除（演示）</button>
        </div>}
        {order.recheck?.result === 'FAIL' && <p>测点未达标，须继续调查；本工单不能确认异常解除。</p>}
        {order.recheck?.result === 'PASS' && !canResolve && !order.resolution &&
          <p>检查记录仍含异常或待确认项，须继续调查；本工单不能确认异常解除。</p>}
        {order.resolution && <p>人工复核记录：{order.resolution.note} · {new Date(order.resolution.confirmed_at).toLocaleString('zh-CN')}</p>}
      </>}
    </div>}
  </article>;
}
