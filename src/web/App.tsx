import { useEffect, useRef, useState } from 'react';
import { calculateMetrics, RISK_THRESHOLDS, type IndustrialCase, type CaseMetrics, type RiskLevel } from '../domain/cases';
import type { EvaluationRun, EvaluationSuite } from '../evaluation';
import type { RunResult, ToolTrace } from '../harness/run';
import type { SafetyLabResult, SafetyScenario, SafetyScenarioId } from '../safety-lab';
import { workOrderAssignees, type WorkOrder, type WorkOrderAssignee, type WorkOrderStatus } from '../domain/work-orders';
import { KnowledgePanel } from './KnowledgePanel';
import { SchedulingPanel } from './SchedulingPanel';
import { OperationsPanel } from './OperationsPanel';

type CaseSummary = { case_id: string; title: string; snapshot_date: string; data_type: 'synthetic';
  risk_level: RiskLevel; line_id: string; equipment_id: string; metrics: CaseMetrics };
type Snapshot = Omit<IndustrialCase, 'maintenance_record'> & { metrics: CaseMetrics };
type SkillSummary = { id: string; name: string; version: string; purpose: string };
type Capabilities = { online_available: boolean; replay_available: boolean; skills: SkillSummary[]; limits: Record<string, number> };
type SessionPage = { items: RunResult[]; next_cursor: string | null };
type ScenarioValues = { daily_output_units: number; temperature_c: number; vibration_mm_s: number };
type EvaluationOverview = { suite: EvaluationSuite; runs: EvaluationRun[] };
type SafetyLabOverview = { execution: 'scripted_fake_model'; data_type: 'synthetic'; scenarios: SafetyScenario[] };
type WorkOrderOverview = { items: WorkOrder[] };

async function api<T>(path: string, body?: unknown, signal?: AbortSignal, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const response = await fetch(path, body === undefined ? { signal } : {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '请求失败');
  return data as T;
}

const riskLabel: Record<RiskLevel, string> = { HIGH: '高风险', MEDIUM: '中风险', LOW: '低风险', UNKNOWN: '未知' };
const format = (value: number | null, suffix = '%') => value === null ? '未知' : `${value > 0 ? '+' : ''}${value.toFixed(1)}${suffix}`;
const toolLabel: Record<string, string> = {
  get_line_snapshot: '产线快照', get_equipment_snapshot: '设备快照', get_maintenance_history: '维修记录',
};
const assigneeLabel = Object.fromEntries(workOrderAssignees.map((item) => [item.id, item.name])) as Record<WorkOrderAssignee, string>;
const workOrderStatusLabel: Record<WorkOrderStatus, string> = { open: '待开始', in_progress: '处理中', completed: '已完成' };

function MetricCard({ label, value, unit, change, alert }: { label: string; value: number | null; unit: string; change: number | null; alert?: boolean }) {
  return <article className={`metric-card ${alert ? 'metric-alert' : ''}`}>
    <span className="eyebrow">{label}</span><strong>{value === null ? '—' : value.toLocaleString('zh-CN')}<small> {unit}</small></strong>
    <span className="metric-change">较基线 {format(change, label === '不良率' ? ' 个百分点' : '%')}</span>
  </article>;
}

function Trend({ snapshot }: { snapshot: Snapshot }) {
  const entries = [
    ['日产量', snapshot.baseline.daily_output_units, snapshot.current.daily_output_units, '件'],
    ['不良数', snapshot.baseline.defect_units, snapshot.current.defect_units, '件'],
    ['温度', snapshot.baseline.temperature_c, snapshot.current.temperature_c, '°C'],
    ['振动', snapshot.baseline.vibration_mm_s, snapshot.current.vibration_mm_s, 'mm/s'],
  ] as const;
  return <div className="trend-grid">{entries.map(([label, baseline, current, unit]) => {
    const top = Math.max(baseline ?? 0, current ?? 0, 1) * 1.2;
    const y = (value: number) => 72 - value / top * 54;
    return <div className="trend" key={label}>
      <div className="trend-head"><span>{label}</span><b>{current ?? '—'} <small>{unit}</small></b></div>
      <svg viewBox="0 0 180 86" role="img" aria-label={`${label}基线 ${baseline ?? '缺失'}，当前 ${current ?? '缺失'}`}>
        <line x1="15" x2="165" y1="72" y2="72" stroke="#294956"/>
        {baseline !== null && current !== null ? <>
          <line x1="38" x2="142" y1={y(baseline)} y2={y(current)} stroke="#3fc6ad" strokeWidth="3"/>
          <circle cx="38" cy={y(baseline)} r="5" fill="#92aaad"/><circle cx="142" cy={y(current)} r="6" fill="#44d8bb"/>
        </> : <text x="43" y="43">读数缺失，未绘制趋势</text>}
        <text x="20" y="84">基线</text><text x="125" y="84">当前</text>
      </svg>
    </div>;
  })}</div>;
}

export function App() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [caseId, setCaseId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [question, setQuestion] = useState('请分析当前案例的异常并给出人工核查建议。');
  const [skillId, setSkillId] = useState('');
  const [session, setSession] = useState<RunResult | null>(null);
  const [history, setHistory] = useState<RunResult[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyMode, setHistoryMode] = useState('');
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scenario, setScenario] = useState<{ case_id: string; values: ScenarioValues } | null>(null);
  const [evaluations, setEvaluations] = useState<EvaluationOverview | null>(null);
  const [evaluationSkillId, setEvaluationSkillId] = useState('line-anomaly-diagnosis');
  const [evaluationRunId, setEvaluationRunId] = useState('');
  const [evaluationBusy, setEvaluationBusy] = useState(false);
  const [safetyLab, setSafetyLab] = useState<SafetyLabOverview | null>(null);
  const [safetyResult, setSafetyResult] = useState<SafetyLabResult | null>(null);
  const [safetyBusy, setSafetyBusy] = useState<SafetyScenarioId | null>(null);
  const [workOrders, setWorkOrders] = useState<WorkOrder[]>([]);
  const [workOrderAssignee, setWorkOrderAssignee] = useState<WorkOrderAssignee>('equipment_technician');
  const [creatingWorkOrder, setCreatingWorkOrder] = useState(false);
  const [workOrderBusy, setWorkOrderBusy] = useState<string | null>(null);
  const selectedCase = useRef(caseId);
  selectedCase.current = caseId;

  useEffect(() => {
    void Promise.all([api<CaseSummary[]>('/api/cases'), api<Capabilities>('/api/agent/capabilities')])
      .then(([list, caps]) => { setCases(list); setCapabilities(caps); if (list[0]) setCaseId(list[0].case_id); })
      .catch((failure) => setError(String(failure)));
    void api<EvaluationOverview>('/api/evaluations')
      .then((overview) => { setEvaluations(overview); setEvaluationRunId(overview.runs[0]?.id ?? ''); })
      .catch((failure) => setError(String(failure)));
    void api<SafetyLabOverview>('/api/safety-lab/scenarios')
      .then(setSafetyLab).catch((failure) => setError(String(failure)));
  }, []);
  useEffect(() => {
    if (!caseId) return;
    setSession(null); setPlaying(false);
    setSnapshot(null); setScenario(null);
    const controller = new AbortController();
    void api<Snapshot>(`/api/cases/${caseId}/snapshot`, undefined, controller.signal)
      .then(setSnapshot).catch((failure) => {
        if (failure?.name !== 'AbortError') setError(String(failure));
      });
    return () => controller.abort();
  }, [caseId]);
  useEffect(() => {
    if (!caseId) return;
    setHistory([]); setCursor(null); setWorkOrders([]);
    const controller = new AbortController();
    const query = new URLSearchParams({ case_id: caseId, limit: '8' });
    if (historyMode) query.set('mode', historyMode);
    void api<SessionPage>(`/api/sessions?${query}`, undefined, controller.signal)
      .then((page) => { setHistory(page.items); setCursor(page.next_cursor); })
      .catch((failure) => { if (failure?.name !== 'AbortError') setError(String(failure)); });
    void api<WorkOrderOverview>(`/api/work-orders?case_id=${encodeURIComponent(caseId)}`, undefined, controller.signal)
      .then((overview) => setWorkOrders(overview.items))
      .catch((failure) => { if (failure?.name !== 'AbortError') setError(String(failure)); });
    return () => controller.abort();
  }, [caseId, historyMode]);
  useEffect(() => {
    if (!session || session.mode !== 'replay' || !playing) return;
    if (frame >= session.trace.length - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setFrame((value) => value + 1), 1450);
    return () => window.clearTimeout(timer);
  }, [session, frame, playing]);

  async function run(mode: 'online' | 'replay') {
    if (!caseId || busy) return;
    const requestedCase = caseId;
    setBusy(true); setError('');
    try {
      const result = await api<RunResult>(mode === 'online' ? '/api/diagnose' : '/api/replay',
        mode === 'online' ? { case_id: caseId, question, ...(skillId ? { skill_id: skillId } : {}) } : { case_id: caseId });
      if (selectedCase.current === requestedCase) {
        setSession(result); setFrame(0); setPlaying(mode === 'replay');
        setHistory((previous) => [result, ...previous.filter((item) => item.id !== result.id)].slice(0, 8));
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '请求失败'); }
    finally { setBusy(false); }
  }

  async function loadMore() {
    if (!cursor) return;
    const query = new URLSearchParams({ case_id: caseId, limit: '8', cursor });
    if (historyMode) query.set('mode', historyMode);
    try {
      const page = await api<SessionPage>(`/api/sessions?${query}`);
      setHistory((previous) => [...previous, ...page.items]); setCursor(page.next_cursor);
    } catch (failure) { setError(String(failure)); }
  }

  async function startEvaluation() {
    if (!evaluations || !capabilities?.online_available || evaluationBusy) return;
    setEvaluationBusy(true); setError('');
    try {
      const run = await api<EvaluationRun>('/api/evaluations', { skill_id: evaluationSkillId });
      setEvaluations((previous) => previous ? { ...previous, runs: [run, ...previous.runs].slice(0, 10) } : previous);
      setEvaluationRunId(run.id);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '评测失败'); }
    finally { setEvaluationBusy(false); }
  }

  async function runSafety(id: SafetyScenarioId) {
    if (safetyBusy) return;
    setSafetyBusy(id); setSafetyResult(null); setError('');
    try { setSafetyResult(await api<SafetyLabResult>('/api/safety-lab', { scenario_id: id })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '安全实验失败'); }
    finally { setSafetyBusy(null); }
  }

  async function createWorkOrder() {
    if (!session?.diagnosis || session.status !== 'completed' || creatingWorkOrder) return;
    setCreatingWorkOrder(true); setError('');
    try {
      const order = await api<WorkOrder>('/api/work-orders', { session_id: session.id, assignee: workOrderAssignee });
      if (selectedCase.current === order.case_id) setWorkOrders((previous) => [order, ...previous]);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '创建巡检工单失败'); }
    finally { setCreatingWorkOrder(false); }
  }

  async function updateWorkOrderStatus(order: WorkOrder, status: 'in_progress' | 'completed') {
    setWorkOrderBusy(order.id); setError('');
    try {
      const updated = await api<WorkOrder>(`/api/work-orders/${order.id}/status`, { status }, undefined, 'PATCH');
      setWorkOrders((previous) => previous.map((item) => item.id === updated.id ? updated : item));
    } catch (failure) { setError(failure instanceof Error ? failure.message : '更新工单状态失败'); }
    finally { setWorkOrderBusy(null); }
  }

  async function updateWorkOrderCheck(order: WorkOrder, itemId: string, completed: boolean) {
    const optimistic = { ...order, updated_at: new Date().toISOString(),
      checklist: order.checklist.map((item) => item.id === itemId ? { ...item, completed } : item) };
    setWorkOrders((previous) => previous.map((item) => item.id === order.id ? optimistic : item));
    setWorkOrderBusy(order.id); setError('');
    try {
      const updated = await api<WorkOrder>(`/api/work-orders/${order.id}/checklist/${itemId}`, { completed }, undefined, 'PATCH');
      setWorkOrders((previous) => previous.map((item) => item.id === updated.id ? updated : item));
    } catch (failure) {
      setWorkOrders((previous) => previous.map((item) => item.id === order.id ? order : item));
      setError(failure instanceof Error ? failure.message : '更新检查项失败');
    }
    finally { setWorkOrderBusy(null); }
  }

  const active = session?.mode === 'replay' ? session.trace.slice(0, frame + 1) : session?.trace ?? [];
  const showResult = session && (session.mode === 'online' || frame >= session.trace.length - 2);
  const selected = cases.find((item) => item.case_id === caseId);
  const selectedEvaluation = evaluations?.runs.find((item) => item.id === evaluationRunId);
  const originalScenario = snapshot &&
    snapshot.current.daily_output_units !== null &&
    snapshot.current.temperature_c !== null &&
    snapshot.current.vibration_mm_s !== null ? {
      daily_output_units: snapshot.current.daily_output_units,
      temperature_c: snapshot.current.temperature_c,
      vibration_mm_s: snapshot.current.vibration_mm_s,
    } : null;
  const scenarioValues = scenario?.case_id === caseId ? scenario.values : originalScenario;
  const scenarioMetrics = snapshot && scenarioValues ? calculateMetrics({
    baseline_date: snapshot.baseline_date, snapshot_date: snapshot.snapshot_date,
    baseline: snapshot.baseline, current: { ...snapshot.current, ...scenarioValues },
  }) : null;
  function changeScenario(field: keyof ScenarioValues, value: number) {
    if (!scenarioValues || !Number.isFinite(value)) return;
    setScenario({ case_id: caseId, values: { ...scenarioValues, [field]: value } });
  }
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">π</span><div><b>INDUSTRIAL / PI</b><small>智能体辅助诊断工作台</small></div></div>
      <div className="topbar-right"><span className="live-dot"/> 单机演示环境 <span className="top-divider"/> <strong>合成数据 · 非生产系统</strong></div></header>
    <main className="workspace">
      <div className="page-heading"><div><span className="eyebrow green">OPERATIONS INTELLIGENCE / DEMO</span><h1>产线异常辅助诊断</h1>
        <p>观察指标、追踪工具调用、核对证据，再由人员决定下一步检查。</p></div>
        <div className="header-status"><span className="status-dot"/> {capabilities?.online_available ? '在线模型已配置' : '在线模型未配置'}<small>离线回放始终可用</small></div></div>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
      <div className="columns">
        <section className="left-column">
          <div className="panel case-panel"><div className="panel-title"><span className="eyebrow">01 / CASE CONTEXT</span><h2>选择演示案例</h2></div>
            <div className="case-list">{cases.map((item) => <button key={item.case_id} className={`case-item ${caseId === item.case_id ? 'selected' : ''}`} disabled={busy} onClick={() => setCaseId(item.case_id)}>
              <span><b>{item.case_id}</b><small>{item.title}</small></span><span className={`risk risk-${item.risk_level.toLowerCase()}`}>{riskLabel[item.risk_level]}</span>
            </button>)}</div>
            {snapshot && <div className="case-meta"><span>产线 {snapshot.line_id}</span><span>设备 {snapshot.equipment_id}</span><span>快照 {snapshot.snapshot_date}</span><span>合成数据</span></div>}
          </div>
          <div className="panel metrics-panel"><div className="panel-title"><span className="eyebrow">02 / SIGNALS</span><h2>指标与基线</h2></div>
            {snapshot && <><div className="metric-grid">
              <MetricCard label="日产量" value={snapshot.current.daily_output_units} unit="件" change={snapshot.metrics.output_change_pct} alert={(snapshot.metrics.output_change_pct ?? 0) <= -10}/>
              <MetricCard label="不良率" value={snapshot.metrics.current_defect_rate_pct === null ? null : Number(snapshot.metrics.current_defect_rate_pct.toFixed(2))} unit="%" change={snapshot.metrics.defect_rate_change_pp}/>
              <MetricCard label="温度" value={snapshot.current.temperature_c} unit="°C" change={snapshot.metrics.temperature_change_pct} alert={(snapshot.metrics.temperature_change_pct ?? 0) >= 20}/>
              <MetricCard label="振动" value={snapshot.current.vibration_mm_s} unit="mm/s" change={snapshot.metrics.vibration_change_pct} alert={(snapshot.metrics.vibration_change_pct ?? 0) >= 20}/>
            </div><Trend snapshot={snapshot}/><p className="fineprint">基线 {snapshot.baseline_date} → 当前 {snapshot.snapshot_date}。风险由后端规则计算，不能代表已确认故障。</p></>}
          </div>
          {snapshot && scenarioValues && scenarioMetrics && <div className="panel scenario-panel"><div className="panel-title"><span className="eyebrow">02A / WHAT IF</span><h2>假设推演</h2></div>
            <p className="fineprint">调整合成数据，观察风险规则的敏感性。仅在此页面计算，不修改原案例、诊断或历史。</p>
            <div className="scenario-risk"><span>原始风险 <b className={`risk risk-${snapshot.metrics.risk_level.toLowerCase()}`}>{riskLabel[snapshot.metrics.risk_level]}</b></span>
              <span aria-hidden="true">→</span><span>假设风险 <b className={`risk risk-${scenarioMetrics.risk_level.toLowerCase()}`}>{riskLabel[scenarioMetrics.risk_level]}</b></span></div>
            <div className="scenario-controls">{([
              { field: 'daily_output_units', label: '假设日产量', unit: '件', max: Math.max(1500, (snapshot.baseline.daily_output_units ?? 0) * 1.5), step: 10 },
              { field: 'temperature_c', label: '假设温度', unit: '°C', max: Math.max(120, (snapshot.baseline.temperature_c ?? 0) * 1.5), step: 0.5 },
              { field: 'vibration_mm_s', label: '假设振动', unit: 'mm/s', max: Math.max(12, (snapshot.baseline.vibration_mm_s ?? 0) * 2), step: 0.1 },
            ] as const).map(({ field, label, unit, max, step }) => <label key={field}>{label}<strong>{scenarioValues[field]} {unit}</strong>
              <input type="range" min="0" max={max} step={step} value={scenarioValues[field]}
                onChange={(event) => changeScenario(field, Number(event.target.value))}/></label>)}</div>
            <div className="scenario-rules"><span>产量 {format(scenarioMetrics.output_change_pct)}（≤ −{RISK_THRESHOLDS.output_drop_pct}%）</span>
              <span>温度 {format(scenarioMetrics.temperature_change_pct)}（≥ +{RISK_THRESHOLDS.equipment_rise_pct}%）</span>
              <span>振动 {format(scenarioMetrics.vibration_change_pct)}（≥ +{RISK_THRESHOLDS.equipment_rise_pct}%）</span></div>
            <p className="fineprint">高风险：产量越阈且温度或振动越阈；单项越阈为中风险。数据无效时为未知。这是规则推演，不是故障预测。</p>
            <button className="scenario-reset" onClick={() => setScenario(null)} disabled={!scenario || scenario.case_id !== caseId}>恢复原始值</button>
          </div>}
          {snapshot && !scenarioValues && <div className="panel scenario-panel"><div className="panel-title"><span className="eyebrow">02A / WHAT IF</span><h2>假设推演</h2></div>
            <p className="fineprint">当前案例缺少关键读数，无法进行完整推演。请先人工复核数据。</p></div>}
          <OperationsPanel caseId={caseId}/>
        </section>
        <section className="right-column">
          <div className="panel action-panel"><div className="panel-title"><span className="eyebrow">03 / AGENT TASK</span><h2>发起辅助诊断</h2></div>
            <label htmlFor="question">诊断问题</label><textarea id="question" value={question} onChange={(event) => setQuestion(event.target.value)} rows={3}/>
            <div className="action-row"><label htmlFor="skill">Skill</label><select id="skill" value={skillId} onChange={(event) => setSkillId(event.target.value)}>
              <option value="">自动选择</option>{capabilities?.skills.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}
            </select></div>
            <div className="buttons"><button className="primary" onClick={() => void run('replay')} disabled={busy || !caseId}>▶ 一键演示 · 离线回放</button>
              <button className="secondary" onClick={() => void run('online')} disabled={busy || !capabilities?.online_available || !question.trim()}>在线 Pi Agent 诊断</button></div>
            <p className="fineprint">{capabilities?.online_available ? '在线模式会等待真实模型与本地 MCP 工具返回。' : '在线模式需要在服务器本机配置模型 API Key；回放无需密钥或网络。'}</p>
            <details className="config-help"><summary>如何配置模型 API</summary><p>在项目根目录复制 <code>.env.example</code> 为 <code>.env</code>，填写 <code>MODEL_PROVIDER</code>、<code>MODEL_NAME</code> 和对应的 <code>ANTHROPIC_API_KEY</code> 或 <code>OPENAI_API_KEY</code>，然后重启服务。密钥只放服务器本机，不在网页中输入。</p></details>
          </div>
          <div className="panel trace-panel"><div className="panel-title"><span className="eyebrow">04 / HARNESS TRACE</span><h2>执行轨迹</h2></div>
            {!session ? <div className="empty-state"><span>◎</span><b>等待开始演示</b><p>选择案例后点击一键演示，查看 Skill、工具与证据如何衔接。</p></div> : <>
              <div className="session-header"><span className={`mode-tag ${session.mode}`}>{session.mode === 'replay' ? '离线预录回放' : '在线真实执行'}</span>
                <span className={`risk risk-${session.metrics.risk_level.toLowerCase()}`}>{riskLabel[session.metrics.risk_level]}</span><span>{session.skill.name} v{session.skill.version}</span></div>
              <div className="trace-stats"><span>{session.mode === 'replay' ? `实际模型调用 ${session.model_calls}` : `模型调用 ${session.model_calls}/${capabilities?.limits.model_calls ?? 4}`}</span>
                <span>{session.mode === 'replay' ? `实际工具调用 ${session.tool_calls}` : `工具调用 ${session.tool_calls}/${capabilities?.limits.tool_calls ?? 6}`}</span>
                <span>{session.mode === 'replay' ? 'Token 不适用' : session.token_usage === null ? 'Token 用量未知' : `Token 用量 ${session.token_usage}`}</span>
                <span>停止原因 {session.stop_reason}</span></div>
              {session.mode === 'replay' && <div className="playback"><button aria-label="上一步" onClick={() => { setPlaying(false); setFrame((value) => Math.max(0, value - 1)); }}>← 上一步</button>
                <button aria-label={playing ? '暂停' : '继续'} onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ 暂停' : '▶ 继续'}</button>
                <button aria-label="下一步" onClick={() => { setPlaying(false); setFrame((value) => Math.min(session.trace.length - 1, value + 1)); }}>下一步 →</button>
                <button aria-label="退出回放" onClick={() => { setSession(null); setPlaying(false); }}>退出</button><span>{frame + 1} / {session.trace.length}</span></div>}
              <ol className="trace-list">{active.map((item, index) => <li key={index}><span className="trace-number">{String(index + 1).padStart(2, '0')}</span>
                <div><b>{item.kind === 'tool' ? toolLabel[item.name] ?? item.name : item.name}</b>
                  <small>{item.kind === 'tool' ? `${item.replayed ? '预录轨迹' : '真实调用'} · ${item.source.toUpperCase()} · ${item.status}` : item.detail ?? item.status}</small>
                  {item.kind === 'tool' && <><code>{item.evidence_id ?? '未返回证据 ID'}</code><details className="trace-meta"><summary>查看调用记录</summary>
                    <dl><dt>调用 ID</dt><dd>{item.tool_call_id}</dd><dt>参数范围</dt><dd><code>{JSON.stringify(item.args)}</code></dd>
                      <dt>耗时</dt><dd>{item.replayed ? '预录，未现场计时' : item.duration_ms === undefined ? '未知' : `${item.duration_ms} ms`}</dd>
                      <dt>重试</dt><dd>{item.retry_count} 次</dd><dt>预算计数</dt><dd>模型 {item.budget.model_calls} · 工具 {item.budget.tool_calls}</dd>
                      <dt>结果</dt><dd>{item.result_summary ?? item.status}</dd></dl></details></>}</div></li>)}</ol>
              {session.status === 'failed' && <div className="error-banner">安全终止：{session.stop_reason}</div>}
            </>}
          </div>
        </section>
      </div>
      <section className="panel comparison-panel"><div className="panel-title"><span className="eyebrow">04A / CASE COMPARISON</span><h2>跨案例对照</h2></div>
        <p className="fineprint">同一组确定性规则覆盖复合异常、正常对照、单指标异常和数据不足。表中变化均相对各案例基线，点击案例可切换工作台。</p>
        <div className="comparison-scroll"><table><thead><tr><th>案例</th><th>产量变化</th><th>温度偏移</th><th>振动偏移</th><th>风险</th></tr></thead>
          <tbody>{cases.map((item) => <tr key={item.case_id} className={item.case_id === caseId ? 'selected' : ''}>
            <td><button onClick={() => setCaseId(item.case_id)} disabled={busy} aria-label={`查看 ${item.case_id}`}><b>{item.case_id}</b><small>{item.title}</small></button></td>
            <td>{format(item.metrics.output_change_pct)}</td><td>{format(item.metrics.temperature_change_pct)}</td>
            <td>{format(item.metrics.vibration_change_pct)}</td><td><span className={`risk risk-${item.risk_level.toLowerCase()}`}>{riskLabel[item.risk_level]}</span></td>
          </tr>)}</tbody></table></div>
        <p className="fineprint">“未知”表示关键值或比较条件不足，应补采数据；不将其解释为低风险。</p>
      </section>
      {showResult && session && <section className="panel result-panel"><div className="panel-title"><span className="eyebrow">05 / EVIDENCE & DECISION</span><h2>辅助诊断结果</h2></div>
        <div className="result-grid"><div><span className="eyebrow">结论</span><p className="summary">{session.diagnosis?.summary ?? '诊断未通过校验，请检查轨迹与停止原因。'}</p>
          <h3>待核查假设</h3><ul>{session.diagnosis?.hypotheses.map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>建议的人工检查</h3><ul>{session.diagnosis?.recommended_checks.map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>限制</h3><ul>{session.diagnosis?.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div><span className="eyebrow">本次证据</span>{session.evidence.map((item) => <details className="evidence" key={item.id}><summary><b>{toolLabel[item.tool]}</b><small>{item.source.toUpperCase()}</small><code>{item.id}</code></summary><pre>{JSON.stringify(item.data, null, 2)}</pre></details>)}
            <a className="report-link" href={`/api/reports/${session.id}`} target="_blank" rel="noreferrer">打开可打印报告 ↗</a>
            {session.status === 'completed' && session.diagnosis && session.diagnosis.recommended_checks.length > 0 && <div className="work-order-create">
              <label htmlFor="work-order-assignee">巡检责任角色</label><select id="work-order-assignee" value={workOrderAssignee} onChange={(event) => setWorkOrderAssignee(event.target.value as WorkOrderAssignee)} disabled={creatingWorkOrder}>
                {workOrderAssignees.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select><button onClick={() => void createWorkOrder()} disabled={creatingWorkOrder}>{creatingWorkOrder ? '创建中…' : '生成巡检工单'}</button>
              <small>根据本次通过校验的诊断建议创建；只记录人工检查，不控制设备。</small>
            </div>}</div></div>
      </section>}
      <section className="panel history-panel"><div className="panel-title"><span className="eyebrow">06 / SESSION HISTORY</span><h2>诊断历史</h2></div>
        <div className="history-toolbar"><span>{selected?.case_id ?? ''} · 持久化会话</span><select aria-label="筛选模式" value={historyMode} onChange={(event) => setHistoryMode(event.target.value)}>
          <option value="">全部模式</option><option value="replay">离线回放</option><option value="online">在线诊断</option></select></div>
        {history.length === 0 ? <p className="fineprint">此案例还没有历史会话。</p> : <div className="history-list">{history.map((item) => <button key={item.id} onClick={() => { setCaseId(item.case_id); setSession(item); setPlaying(false); setFrame(item.trace.length - 1); }}>
          <span><b>{item.case_id}</b><small>{new Date(item.created_at).toLocaleString('zh-CN')} · {item.skill.name}</small></span>
          <span className={`mode-tag ${item.mode}`}>{item.mode === 'replay' ? '回放' : '在线'}</span><span className={`risk risk-${item.metrics.risk_level.toLowerCase()}`}>{riskLabel[item.metrics.risk_level]}</span><span>查看 →</span>
        </button>)}</div>}{cursor && <button className="more" onClick={() => void loadMore()}>加载更多历史</button>}
      </section>
      <section className="panel work-orders-panel"><div className="panel-title"><span className="eyebrow">07 / HUMAN FOLLOW-UP</span><h2>人工巡检工单</h2></div>
        <p className="fineprint">工单来自已完成的诊断建议，保留来源案例与证据 ID。完成每项检查后勾选记录，全部检查完成后才可关闭工单。</p>
        {workOrders.length === 0 ? <p className="fineprint">当前案例暂无巡检工单。完成一次诊断后，可从诊断结果生成。</p> : <div className="work-order-list">{workOrders.map((order) => {
          const allChecked = order.checklist.every((item) => item.completed);
          return <article className="work-order-card" key={order.id}>
            <header><div><b>{order.case_id} · {order.equipment_id}</b><small>工单 {order.id.slice(0, 8)} · 来源诊断 {order.session_id.slice(0, 8)}</small></div>
              <span className={`risk risk-${order.risk_level.toLowerCase()}`}>{riskLabel[order.risk_level]}</span>
              <span className={`work-order-status ${order.status}`}>{workOrderStatusLabel[order.status]}</span></header>
            <p>{order.diagnosis_summary}</p><div className="work-order-meta"><span>责任角色：{assigneeLabel[order.assignee]}</span><span>更新时间：{new Date(order.updated_at).toLocaleString('zh-CN')}</span></div>
            <ul className="work-order-checklist">{order.checklist.map((item) => <li key={item.id}>
              <label><input type="checkbox" checked={item.completed} disabled={order.status !== 'in_progress' || workOrderBusy === order.id}
                onChange={(event) => void updateWorkOrderCheck(order, item.id, event.target.checked)}/><span>{item.description}</span></label>
            </li>)}</ul>
            <div className="work-order-evidence">关联证据：{order.evidence_ids.join(' · ')}</div>
            {order.status !== 'completed' && <div className="work-order-actions">
              {order.status === 'open' ? <button onClick={() => void updateWorkOrderStatus(order, 'in_progress')} disabled={workOrderBusy === order.id}>开始巡检</button> : <button onClick={() => void updateWorkOrderStatus(order, 'completed')} disabled={!allChecked || workOrderBusy === order.id}>完成工单</button>}
              {order.status === 'in_progress' && !allChecked && <small>完成全部检查项后可关闭工单。</small>}
            </div>}
          </article>;
        })}</div>}
      </section>
      <KnowledgePanel caseId={caseId} checks={session?.diagnosis?.recommended_checks ?? []}/>
      <SchedulingPanel/>
      <section className="panel evaluation-panel"><div className="panel-title"><span className="eyebrow">10 / REPEATABLE EVALUATION</span><h2>在线评测中心</h2></div>
        <p className="fineprint">固定题集 v{evaluations?.suite.version ?? '—'} · {evaluations?.suite.cases.length ?? 0} 个合成案例。逐案检查规则一致、必需工具、证据和数据不足时的弃判，并保存每次真实运行。离线回放不计入成绩；此分数不衡量故障根因准确率。</p>
        <div className="evaluation-controls"><label>评测 Skill <select aria-label="评测 Skill" value={evaluationSkillId} onChange={(event) => setEvaluationSkillId(event.target.value)} disabled={evaluationBusy}>
          {capabilities?.skills.map((item) => <option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}
        </select></label><button onClick={() => void startEvaluation()} disabled={evaluationBusy || !capabilities?.online_available || !evaluations}>
          {evaluationBusy ? '正在运行五案例…' : '运行五案例在线评测'}</button></div>
        <p className="fineprint">每次评测会顺序发起五次真实模型诊断，可能需要数分钟并消耗模型 API 额度。{!capabilities?.online_available && '请先在服务器本机配置模型 API Key。'}</p>
        {evaluationBusy && <p className="evaluation-running" role="status">正在等待五个任务完成，结果返回后统一展示。</p>}
        {!selectedEvaluation ? <p className="fineprint">尚无在线评测记录；五个离线预录案例仅供演示流程。</p> : <>
          <div className="evaluation-summary"><strong>{selectedEvaluation.passed_count} / {selectedEvaluation.total_count}</strong><span>通过 Harness 验收</span>
            <span>模型 {selectedEvaluation.model.provider} / {selectedEvaluation.model.name}</span>
            <span>Skill {selectedEvaluation.skill.name} v{selectedEvaluation.skill.version}</span>
            <span>平均耗时 {selectedEvaluation.mean_duration_ms} ms</span></div>
          <div className="evaluation-toolbar"><label>历史评测 <select aria-label="历史评测" value={evaluationRunId} onChange={(event) => setEvaluationRunId(event.target.value)}>
            {evaluations?.runs.map((item) => <option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleString('zh-CN')} · {item.skill.name} · {item.passed_count}/{item.total_count}</option>)}
          </select></label><a href={`/api/evaluations/${selectedEvaluation.id}`} target="_blank" rel="noreferrer">查看评测 JSON ↗</a></div>
          <div className="evaluation-cases">{selectedEvaluation.cases.map((item) => <article key={item.case_id}>
            <header><b>{item.case_id}</b><span className={`evaluation-mark ${item.passed ? 'passed' : 'failed'}`}>{item.passed ? '通过' : '未通过'}</span></header>
            <div className="evaluation-checks"><span>规则 {item.risk_consistent ? '✓' : '×'}</span><span>工具 {item.tools_complete ? '✓' : '×'}</span>
              <span>证据 {item.evidence_complete ? '✓' : '×'}</span><span>弃判 {item.abstained_when_unknown ? '✓' : '×'}</span></div>
            <small>{item.duration_ms} ms · 模型 {item.model_calls} 次 · 工具 {item.tool_calls} 次 · {item.stop_reason}</small>
            <a href={`/api/reports/${item.session_id}`} target="_blank" rel="noreferrer">查看该案例报告 ↗</a>
          </article>)}</div>
        </>}
      </section>
      <section className="panel safety-panel"><div className="panel-title"><span className="eyebrow">11 / SAFETY LAB</span><h2>安全实验台</h2></div>
        <p className="fineprint">四个固定合成场景使用脚本化假模型触发真实 Harness 边界，无需模型 API Key。结果不写入诊断历史，也不计入在线评测；其中维修工具超时使用模拟挂起的 MCP 客户端。</p>
        <div className="safety-scenarios">{safetyLab?.scenarios.map((item) => <article key={item.id}>
          <div><b>{item.name}</b><p>{item.description}</p></div>
          <button onClick={() => void runSafety(item.id)} disabled={safetyBusy !== null}>{safetyBusy === item.id ? '运行中…' : '运行场景'}</button>
        </article>)}</div>
        {safetyResult && <div className="safety-result" role="status"><header><b>{safetyResult.name}</b>
          <span className={`evaluation-mark ${safetyResult.passed ? 'passed' : 'failed'}`}>{safetyResult.passed ? '符合预期' : '与预期不符'}</span></header>
          <div className="safety-facts"><span>预期停止：{safetyResult.expected_stop_reason}</span><span>实际停止：{safetyResult.observed_stop_reason}</span>
            <span>模型调用：{safetyResult.model_calls}</span><span>工具调用：{safetyResult.tool_calls}</span><span>可信证据：{safetyResult.evidence_ids.length}</span></div>
          <details><summary>查看执行轨迹与证据 ID</summary><ol>{safetyResult.trace.map((item, index) => <li key={index}>
            {item.kind === 'tool' ? `${item.name} · ${item.source.toUpperCase()} · ${item.status}` : `${item.name} · ${item.status}`}
            {item.kind === 'tool' && item.evidence_id ? ` · ${item.evidence_id}` : ''}
            {item.kind === 'step' && item.detail ? ` · ${item.detail}` : ''}
          </li>)}</ol><p>证据：{safetyResult.evidence_ids.join('、') || '无'}</p></details>
        </div>}
      </section>
      <footer>INDUSTRIAL / PI · 所有数值与维修记录均为合成样例 · 仅供人工辅助诊断</footer>
    </main>
  </div>;
}
