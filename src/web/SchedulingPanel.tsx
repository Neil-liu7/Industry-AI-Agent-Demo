import { useEffect, useState } from 'react';
import type { ScheduleResult, SchedulingDataset } from '../scheduling';

type Simulation = { data_type: 'synthetic'; unavailable_machine_id: string | null;
  deadline_first: ScheduleResult; energy_first: ScheduleResult };

const strategyNames = { deadline_first: '交期优先', energy_first: '能耗优先' } as const;

export function SchedulingPanel() {
  const [dataset, setDataset] = useState<SchedulingDataset | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [simulation, setSimulation] = useState<Simulation | null>(null);
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

  const horizon = simulation ? Math.max(simulation.deadline_first.kpis.makespan_h,
    simulation.energy_first.kpis.makespan_h, 1) : 1;

  return <section className="panel scheduling-panel"><div className="panel-title"><span className="eyebrow">01 / VIRTUAL DECISION</span><h2>生产排程仿真</h2></div>
    <p className="fineprint">固定合成订单和设备能力。比较交期优先与能耗优先，并模拟一台设备停用；结果仅用于虚拟决策讨论，不下发生产指令。</p>
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
