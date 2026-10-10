import { useEffect, useRef, useState } from 'react';
import type { Assessment, TelemetryPoint } from '../operations';

type OperationsView = {
  version: string; data_type: 'synthetic'; case_id: string; line_id: string; equipment_id: string;
  thresholds: { temperature_high_c: number; vibration_high_mm_s: number; cooling_flow_low_l_min: number };
  points: TelemetryPoint[]; assessments: Assessment[];
};
type Verification = {
  case_id: string; action_id: string; result: 'PASS' | 'FAIL'; message: string;
  points: TelemetryPoint[]; checks: Array<{ at: string; data_complete: boolean; within_limits: boolean }>;
};
const stateLabel: Record<Assessment['state'], string> = {
  NORMAL: '正常', WATCH: '待确认', ALARM: '持续告警', DATA_GAP: '数据缺失',
};
const clock = (value: string) => value.slice(11, 16);

export function OperationsPanel({ caseId }: { caseId: string }) {
  const [view, setView] = useState<OperationsView | null>(null);
  const [step, setStep] = useState(0);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const verifyRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    verifyRequest.current?.abort();
    setView(null); setVerification(null); setError(''); setBusy(false);
    void fetch(`/api/operations?case_id=${encodeURIComponent(caseId)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? '测点加载失败');
        if (!controller.signal.aborted) {
          setView(body as OperationsView); setStep((body as OperationsView).points.length - 1);
        }
      }).catch((failure) => { if (!controller.signal.aborted) setError(String(failure)); });
    return () => { controller.abort(); verifyRequest.current?.abort(); };
  }, [caseId]);

  async function verify(actionId: string) {
    const controller = new AbortController();
    verifyRequest.current = controller;
    setBusy(true); setError(''); setVerification(null);
    try {
      const response = await fetch('/api/operations/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ case_id: caseId, action_id: actionId }), signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '复测失败');
      if (!controller.signal.aborted) setVerification(body as Verification);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '复测失败'); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  const assessment = view?.assessments[step];
  const point = view?.points[step];
  const atEnd = view ? step === view.points.length - 1 : false;
  return <section className="panel operations-panel"><div className="panel-title"><span className="eyebrow">02B / INDUSTRIAL EVENT LOOP</span><h2>设备事件与复测台</h2></div>
    <p className="fineprint">按 5 分钟采样的固定合成测点回看事件。告警需连续两次越阈；温度缺失阻断正常判定。处置只生成带 SOP 来源的人工建议，复测也是预设的虚拟分支。</p>
    {error && <p className="knowledge-error" role="alert">{error}</p>}
    {view && point && assessment && <>
      <div className="operations-head"><div><b>{view.case_id} · {view.line_id} · {view.equipment_id}</b><small>合成时序 v{view.version} · 采样日期 {point.at.slice(0, 10)} · 北京时间</small></div>
        <span className={`operations-state ${assessment.state.toLowerCase()}`}>{stateLabel[assessment.state]}</span></div>
      <div className="operations-steps" aria-label="事件时间轴">{view.points.map((item, index) => <button key={item.at} type="button"
        className={step === index ? 'selected' : ''} onClick={() => { setStep(index); setVerification(null); }}>
        <b>{clock(item.at)}</b><small>{stateLabel[view.assessments[index].state]}</small></button>)}</div>
      <div className="operations-readings">
        <article><span>温度</span><b>{point.temperature_c === null ? '缺失' : `${point.temperature_c} °C`}</b><small>告警 ≥ {view.thresholds.temperature_high_c} °C</small></article>
        <article><span>振动</span><b>{point.vibration_mm_s} mm/s</b><small>告警 ≥ {view.thresholds.vibration_high_mm_s} mm/s</small></article>
        <article><span>冷却流量</span><b>{point.cooling_flow_l_min} L/min</b><small>告警 ≤ {view.thresholds.cooling_flow_low_l_min} L/min</small></article>
      </div>
      <div className="operations-decision"><b>规则判定 · {stateLabel[assessment.state]}</b><p>{assessment.reason}</p>
        <small>原始测点证据：{assessment.evidence_ids.join(' · ')}。阈值用于本演示，未经现场校准。</small></div>
      {assessment.recommendation && <div className="operations-action"><div><span className="eyebrow">HUMAN ACTION / READ ONLY</span>
        <h3>{assessment.recommendation.title}</h3><p>建议责任角色：{assessment.recommendation.role} · 知识来源：{assessment.recommendation.sop_id}</p></div>
        <button onClick={() => void verify(assessment.recommendation!.action_id)} disabled={!atEnd || busy}>
          {busy ? '复测中…' : '模拟人工检查后复测'}</button></div>}
      {assessment.recommendation && !atEnd && <p className="fineprint">请切到最后一个采样点，再运行对应的虚拟复测分支。</p>}
      {verification && <div className={`operations-verification ${verification.result.toLowerCase()}`} role="status">
        <b>{verification.result === 'PASS' ? '测点复测通过' : '复测未通过'}</b><p>{verification.message}</p>
        <div>{verification.points.map((item, index) => <span key={item.at}>{clock(item.at)} · 温度 {item.temperature_c ?? '缺失'} °C · 振动 {item.vibration_mm_s} mm/s · 流量 {item.cooling_flow_l_min} L/min · {verification.checks[index].within_limits ? '测点在界内' : '测点未达标'}</span>)}</div>
        <small>仅对预设测点做两次连续复测；不解除生产告警、不关闭工单，也不代表产量和质量恢复。</small></div>}
    </>}
  </section>;
}
