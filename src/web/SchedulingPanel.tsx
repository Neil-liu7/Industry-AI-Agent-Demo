import { useEffect, useState } from 'react';
import type { WorkOrder } from '../domain/work-orders';
import type { IncidentScheduleImpact, ScheduleDecision, ScheduleResult, SchedulingDataset, SchedulingStrategy } from '../scheduling';

type Simulation = { data_type: 'synthetic'; unavailable_machine_id: string | null;
  deadline_first: ScheduleResult; energy_first: ScheduleResult };

const strategyNames = { deadline_first: '交期优先', energy_first: '能耗优先' } as const;

export function SchedulingPanel({ caseId, workOrders }: { caseId: string; workOrders: WorkOrder[] }) {
  const [dataset, setDataset] = useState<SchedulingDataset | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [impact, setImpact] = useState<IncidentScheduleImpact | null>(null);
  const [decisions, setDecisions] = useState<ScheduleDecision[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<SchedulingStrategy>('deadline_first');
  const [decisionNote, setDecisionNote] = useState('');
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function simulate(machineId: string) {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/scheduling/simulate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unavailable_machine_id: machineId || null }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '仿真失败');
      setSimulation(body as Simulation);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '仿真失败'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    void fetch('/api/scheduling').then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '数据加载失败');
      setDataset(body as SchedulingDataset);
      await simulate('');
    }).catch((failure) => setError(failure instanceof Error ? failure.message : '数据加载失败'));
  }, []);

  useEffect(() => {
    setImpact(null); setDecisions([]);
    if (!dataset || caseId !== dataset.incident_source.case_id) return;
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/scheduling/incident-impact?case_id=${encodeURIComponent(caseId)}`, { signal: controller.signal }),
      fetch(`/api/scheduling/decisions?case_id=${encodeURIComponent(caseId)}`, { signal: controller.signal }),
    ]).then(async ([impactResponse, decisionsResponse]) => {
      if (!impactResponse.ok || !decisionsResponse.ok) throw new Error('告警排程数据加载失败');
      const current = await impactResponse.json() as IncidentScheduleImpact;
      const history = await decisionsResponse.json() as { items: ScheduleDecision[] };
      setImpact(current); setSelectedStrategy(current.recommended_strategy); setDecisions(history.items);
    }).catch((failure) => { if (!controller.signal.aborted) setError(String(failure)); });
    return () => controller.abort();
  }, [caseId, dataset]);

  async function saveDecision(order: WorkOrder) {
    setDecisionBusy(true); setError('');
    try {
      const response = await fetch('/api/scheduling/decisions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ case_id: caseId, work_order_id: order.id,
          strategy: selectedStrategy, note: decisionNote.trim() }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '方案保存失败');
      setDecisions((previous) => [body as ScheduleDecision, ...previous]);
      setDecisionNote('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '方案保存失败'); }
    finally { setDecisionBusy(false); }
  }

  const horizon = simulation ? Math.max(simulation.deadline_first.kpis.makespan_h,
    simulation.energy_first.kpis.makespan_h, 1) : 1;
  const linkedOrder = workOrders.find((order) => order.case_id === caseId && !order.resolution &&
    order.incident?.telemetry_evidence_id === impact?.incident.telemetry_evidence_id);
  const resolved = workOrders.some((order) => order.case_id === caseId && order.resolution &&
    order.incident?.telemetry_evidence_id === impact?.incident.telemetry_evidence_id);

  return <section className="panel scheduling-panel"><div className="panel-title"><span className="eyebrow">01 / VIRTUAL DECISION</span><h2>生产排程仿真</h2></div>
    <p className="fineprint">固定合成订单和设备能力。比较交期优先与能耗优先，并模拟一台设备停用；结果仅用于虚拟决策讨论，不下发生产指令。</p>
    {dataset && caseId !== dataset.incident_source.case_id && <p className="fineprint">当前 {caseId || '案例'} 没有与这组排程订单映射的设备；请选择 IND-001 查看告警对排程的影响。手动扰动仿真仍可使用。</p>}
    {impact && <div className="incident-schedule">
      <h3>告警关联排程 · {impact.case_id} / {impact.equipment_id}</h3>
      <p className="fineprint">{impact.incident.state} · {impact.incident.observed_at} · 测点 {impact.incident.evidence_ids.join('、')}。映射到 {impact.line_id} 的 {impact.machine_id}；以下为历史合成告警的停机假设。</p>
      <div className="impact-grid">{(['deadline_first', 'energy_first'] as const).map((strategy) => {
        const baseline = impact.baseline[strategy].kpis;
        const disrupted = impact.disrupted[strategy].kpis;
        return <article key={strategy}><b>{strategyNames[strategy]}</b>
          <span>总延期 {baseline.total_late_h} → {disrupted.total_late_h} h（+{(disrupted.total_late_h - baseline.total_late_h).toFixed(1)} h）</span>
          <span>延期订单 {baseline.late_orders} → {disrupted.late_orders}</span>
          <span>能耗 {baseline.energy_kwh} → {disrupted.energy_kwh} kWh</span>
        </article>;
      })}</div>
      <p className="fineprint">规则建议：{strategyNames[impact.recommended_strategy]}（先比较总延期，再比较能耗）。{resolved ? '已有人工解除记录；恢复设备时以基线方案作虚拟对照。' : '建议只作人工决策参考。'}</p>
      <div className="decision-entry">
        <span>关联工单：{linkedOrder ? linkedOrder.id.slice(0, 8) : '尚无未解除的同源工单'}</span>
        <label>选择仿真方案 <select aria-label="选择仿真方案" value={selectedStrategy}
          onChange={(event) => setSelectedStrategy(event.target.value as SchedulingStrategy)}>
          <option value="deadline_first">交期优先</option><option value="energy_first">能耗优先</option>
        </select></label>
        <textarea aria-label="排程选择说明" value={decisionNote} maxLength={500} rows={2}
          placeholder="记录人工选择依据（至少 10 字）" onChange={(event) => setDecisionNote(event.target.value)}/>
        <button disabled={!linkedOrder || decisionNote.trim().length < 10 || decisionBusy}
          onClick={() => linkedOrder && void saveDecision(linkedOrder)}>保存人工选择（仅仿真）</button>
      </div>
      {decisions.length > 0 && <div className="decision-history"><b>人工选择记录</b>{decisions.map((decision) =>
        <p key={decision.id}>{new Date(decision.created_at).toLocaleString('zh-CN')} · 工单 {decision.work_order_id.slice(0, 8)} · {strategyNames[decision.strategy]} · {decision.note}</p>)}</div>}
    </div>}
    {dataset && <div className="scheduling-inputs"><div><b>{dataset.line_id}</b><span>{dataset.orders.length} 个订单 · {dataset.machines.length} 台设备 · 时间从仿真起点计</span></div>
      <label>设备扰动 <select aria-label="设备扰动" value={unavailable} onChange={(event) => setUnavailable(event.target.value)} disabled={loading}>
        <option value="">全部设备可用</option>{dataset.machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}停用</option>)}
      </select></label><button onClick={() => void simulate(unavailable)} disabled={loading}>{loading ? '计算中…' : '运行仿真'}</button></div>}
    {error && <p className="knowledge-error" role="alert">{error}</p>}
    {dataset && <details className="scheduling-orders"><summary>查看合成订单和设备假设</summary>
      <div className="comparison-scroll"><table><thead><tr><th>订单</th><th>交期</th>{dataset.machines.map((machine) => <th key={machine.id}>{machine.name}工时</th>)}</tr></thead>
        <tbody>{dataset.orders.map((order) => <tr key={order.id}><td>{order.id} · {order.title}</td><td>{order.due_h} h</td>
          {dataset.machines.map((machine) => <td key={machine.id}>{order.duration_h[machine.id] ?? '不兼容'} h</td>)}</tr>)}</tbody></table></div>
      <p className="fineprint">{dataset.machines.map((item) => `${item.name} ${item.energy_kw} kW`).join(' · ')}。每个订单只占用一台兼容设备，能耗 = 工时 × 功率。</p>
    </details>}
    {dataset && simulation && <><p className="fineprint">当前场景：{simulation.unavailable_machine_id
      ? `${dataset.machines.find((item) => item.id === simulation.unavailable_machine_id)?.name}停用` : '全部设备可用'}。以下为规则计算结果。</p>
      <div className="schedule-comparison">{([simulation.deadline_first, simulation.energy_first] as const).map((result) => <article key={result.strategy}>
        <h3>{strategyNames[result.strategy]}</h3><div className="schedule-kpis"><span>完工 <b>{result.kpis.makespan_h} h</b></span>
          <span>总延期 <b>{result.kpis.total_late_h} h</b></span><span>延期订单 <b>{result.kpis.late_orders}</b></span>
          <span>能耗 <b>{result.kpis.energy_kwh} kWh</b></span></div>
        <div className="schedule-lanes">{dataset.machines.map((machine) => <div className="schedule-lane" key={machine.id}>
          <strong>{machine.name}</strong><div className="schedule-track">{result.assignments.filter((item) => item.machine_id === machine.id).map((item) => <span key={item.order_id}
            style={{ left: `${item.start_h / horizon * 100}%`, width: `${(item.end_h - item.start_h) / horizon * 100}%` }}
            title={`${item.order_id} ${item.start_h}–${item.end_h} h`}>{item.order_id}</span>)}</div>
        </div>)}</div>
        <div className="comparison-scroll"><table><thead><tr><th>订单</th><th>设备</th><th>时段</th><th>延期</th></tr></thead><tbody>{result.assignments.map((item) => <tr key={item.order_id}>
          <td>{item.order_id}</td><td>{item.machine_id}</td><td>{item.start_h}–{item.end_h} h</td><td>{item.late_h} h</td>
        </tr>)}</tbody></table></div>
      </article>)}</div></>}
  </section>;
}
