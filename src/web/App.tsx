import { useEffect, useRef, useState } from 'react';
import type { IndustrialCase, CaseMetrics, RiskLevel } from '../domain/cases';
import type { RunResult, ToolTrace } from '../harness/run';

type CaseSummary = { case_id: string; title: string; snapshot_date: string; data_type: 'synthetic'; risk_level: RiskLevel; line_id: string; equipment_id: string };
type Snapshot = IndustrialCase & { metrics: CaseMetrics };
type SkillSummary = { id: string; name: string; version: string; purpose: string };
type Capabilities = { online_available: boolean; replay_available: boolean; skills: SkillSummary[]; limits: Record<string, number> };
type SessionPage = { items: RunResult[]; next_cursor: string | null };

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, body === undefined ? { signal } : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
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
    const y = (value: number | null) => 72 - (value ?? 0) / top * 54;
    return <div className="trend" key={label}>
      <div className="trend-head"><span>{label}</span><b>{current ?? '—'} <small>{unit}</small></b></div>
      <svg viewBox="0 0 180 86" role="img" aria-label={`${label}基线 ${baseline}，当前 ${current}`}>
        <line x1="15" x2="165" y1="72" y2="72" stroke="#294956"/>
        <line x1="38" x2="142" y1={y(baseline)} y2={y(current)} stroke="#3fc6ad" strokeWidth="3"/>
        <circle cx="38" cy={y(baseline)} r="5" fill="#92aaad"/><circle cx="142" cy={y(current)} r="6" fill="#44d8bb"/>
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
  const selectedCase = useRef(caseId);
  selectedCase.current = caseId;

  useEffect(() => {
    void Promise.all([api<CaseSummary[]>('/api/cases'), api<Capabilities>('/api/agent/capabilities')])
      .then(([list, caps]) => { setCases(list); setCapabilities(caps); if (list[0]) setCaseId(list[0].case_id); })
      .catch((failure) => setError(String(failure)));
  }, []);
  useEffect(() => {
    if (!caseId) return;
    setSession(null); setPlaying(false);
    setSnapshot(null);
    const controller = new AbortController();
    void api<Snapshot>(`/api/cases/${caseId}/snapshot`, undefined, controller.signal)
      .then(setSnapshot).catch((failure) => {
        if (failure?.name !== 'AbortError') setError(String(failure));
      });
    return () => controller.abort();
  }, [caseId]);
  useEffect(() => {
    if (!caseId) return;
    setHistory([]); setCursor(null);
    const controller = new AbortController();
    const query = new URLSearchParams({ case_id: caseId, limit: '8' });
    if (historyMode) query.set('mode', historyMode);
    void api<SessionPage>(`/api/sessions?${query}`, undefined, controller.signal)
      .then((page) => { setHistory(page.items); setCursor(page.next_cursor); })
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

  const active = session?.mode === 'replay' ? session.trace.slice(0, frame + 1) : session?.trace ?? [];
  const showResult = session && (session.mode === 'online' || frame >= session.trace.length - 2);
  const selected = cases.find((item) => item.case_id === caseId);
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
          </div>
          <div className="panel trace-panel"><div className="panel-title"><span className="eyebrow">04 / HARNESS TRACE</span><h2>执行轨迹</h2></div>
            {!session ? <div className="empty-state"><span>◎</span><b>等待开始演示</b><p>选择案例后点击一键演示，查看 Skill、工具与证据如何衔接。</p></div> : <>
              <div className="session-header"><span className={`mode-tag ${session.mode}`}>{session.mode === 'replay' ? '离线预录回放' : '在线真实执行'}</span>
                <span className={`risk risk-${session.metrics.risk_level.toLowerCase()}`}>{riskLabel[session.metrics.risk_level]}</span><span>{session.skill.name} v{session.skill.version}</span></div>
              {session.mode === 'replay' && <div className="playback"><button aria-label="上一步" onClick={() => { setPlaying(false); setFrame((value) => Math.max(0, value - 1)); }}>← 上一步</button>
                <button aria-label={playing ? '暂停' : '继续'} onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ 暂停' : '▶ 继续'}</button>
                <button aria-label="下一步" onClick={() => { setPlaying(false); setFrame((value) => Math.min(session.trace.length - 1, value + 1)); }}>下一步 →</button>
                <button aria-label="退出回放" onClick={() => { setSession(null); setPlaying(false); }}>退出</button><span>{frame + 1} / {session.trace.length}</span></div>}
              <ol className="trace-list">{active.map((item, index) => <li key={index}><span className="trace-number">{String(index + 1).padStart(2, '0')}</span>
                <div><b>{item.kind === 'tool' ? toolLabel[item.name] ?? item.name : item.name}</b>
                  <small>{item.kind === 'tool' ? `${item.replayed ? '预录轨迹' : '真实调用'} · ${item.source.toUpperCase()} · ${item.status}` : item.detail ?? item.status}</small>
                  {item.kind === 'tool' && item.evidence_id && <code>{item.evidence_id}</code>}</div></li>)}</ol>
              {session.status === 'failed' && <div className="error-banner">安全终止：{session.stop_reason}</div>}
            </>}
          </div>
        </section>
      </div>
      {showResult && session && <section className="panel result-panel"><div className="panel-title"><span className="eyebrow">05 / EVIDENCE & DECISION</span><h2>辅助诊断结果</h2></div>
        <div className="result-grid"><div><span className="eyebrow">结论</span><p className="summary">{session.diagnosis?.summary ?? '诊断未通过校验，请检查轨迹与停止原因。'}</p>
          <h3>待核查假设</h3><ul>{session.diagnosis?.hypotheses.map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>建议的人工检查</h3><ul>{session.diagnosis?.recommended_checks.map((item) => <li key={item}>{item}</li>)}</ul>
          <h3>限制</h3><ul>{session.diagnosis?.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>
          <div><span className="eyebrow">本次证据</span>{session.evidence.map((item) => <details className="evidence" key={item.id}><summary><b>{toolLabel[item.tool]}</b><small>{item.source.toUpperCase()}</small><code>{item.id}</code></summary><pre>{JSON.stringify(item.data, null, 2)}</pre></details>)}
            <a className="report-link" href={`/api/reports/${session.id}`} target="_blank" rel="noreferrer">打开可打印报告 ↗</a></div></div>
      </section>}
      <section className="panel history-panel"><div className="panel-title"><span className="eyebrow">06 / SESSION HISTORY</span><h2>诊断历史</h2></div>
        <div className="history-toolbar"><span>{selected?.case_id ?? ''} · 持久化会话</span><select aria-label="筛选模式" value={historyMode} onChange={(event) => setHistoryMode(event.target.value)}>
          <option value="">全部模式</option><option value="replay">离线回放</option><option value="online">在线诊断</option></select></div>
        {history.length === 0 ? <p className="fineprint">此案例还没有历史会话。</p> : <div className="history-list">{history.map((item) => <button key={item.id} onClick={() => { setCaseId(item.case_id); setSession(item); setPlaying(false); setFrame(item.trace.length - 1); }}>
          <span><b>{item.case_id}</b><small>{new Date(item.created_at).toLocaleString('zh-CN')} · {item.skill.name}</small></span>
          <span className={`mode-tag ${item.mode}`}>{item.mode === 'replay' ? '回放' : '在线'}</span><span className={`risk risk-${item.metrics.risk_level.toLowerCase()}`}>{riskLabel[item.metrics.risk_level]}</span><span>查看 →</span>
        </button>)}</div>}{cursor && <button className="more" onClick={() => void loadMore()}>加载更多历史</button>}
      </section>
      <footer>INDUSTRIAL / PI · 所有数值与维修记录均为合成样例 · 仅供人工辅助诊断</footer>
    </main>
  </div>;
}
