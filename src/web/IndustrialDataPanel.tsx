import { useEffect, useState } from 'react';
import type { IndustrialOutcome } from '../industrial-evaluation';
import type { TelemetryImport } from '../telemetry-import';

const stateLabel = { NORMAL: '正常', WATCH: '待确认', ALARM: '持续告警', DATA_GAP: '数据不足' };

export function IndustrialDataPanel({ caseId, active }: { caseId: string; active: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [imports, setImports] = useState<TelemetryImport[]>([]);
  const [outcome, setOutcome] = useState<IndustrialOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setFile(null); setImports([]);
    if (!active || !caseId) return;
    const controller = new AbortController();
    void Promise.all([
      fetch(`/api/telemetry/imports?case_id=${encodeURIComponent(caseId)}`, { signal: controller.signal }),
      fetch('/api/industrial-evaluation', { signal: controller.signal }),
    ]).then(async ([importResponse, outcomeResponse]) => {
      if (!importResponse.ok || !outcomeResponse.ok) throw new Error('数据评测加载失败');
      setImports((await importResponse.json() as { items: TelemetryImport[] }).items);
      setOutcome(await outcomeResponse.json() as IndustrialOutcome);
    }).catch((failure) => { if (!controller.signal.aborted) setError(String(failure)); });
    return () => controller.abort();
  }, [caseId, active]);

  async function upload() {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/telemetry/import', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ case_id: caseId, csv: await file.text() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'CSV 导入失败');
      setImports((previous) => [body as TelemetryImport, ...previous]);
      const metrics = await fetch('/api/industrial-evaluation');
      if (metrics.ok) setOutcome(await metrics.json() as IndustrialOutcome);
      setFile(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'CSV 导入失败'); }
    finally { setBusy(false); }
  }

  return <>
    <section className="panel telemetry-import-panel"><div className="panel-title"><span className="eyebrow">03 / DATA QUALITY</span><h2>工业测点 CSV 导入</h2></div>
      <p className="fineprint">选中案例 {caseId || '—'}。导入文件须包含案例、产线、设备、带时区时间、°C、mm/s、L/min 与 GOOD/BAD 标记；示例在 data/telemetry-import-example.csv。导入记录独立保存，不覆盖内置案例，也不触发工单或控制。</p>
      <div className="telemetry-upload"><input aria-label="导入 CSV 文件" type="file" accept=".csv,text/csv"
        onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy}/>
        <button onClick={() => void upload()} disabled={!file || busy}>{busy ? '校验中…' : '导入并校验'}</button></div>
      {error && <p className="knowledge-error" role="alert">{error}</p>}
      {imports.length === 0 ? <p className="fineprint">当前案例还没有导入记录。</p> : <div className="import-history">{imports.map((item) =>
        <article key={item.id}><b>{stateLabel[item.assessment.state]} · {item.points.length} 个样本</b>
          <span>质量 BAD：{item.bad_samples} · {new Date(item.created_at).toLocaleString('zh-CN')}</span>
          <span>{item.assessment.reason}</span><small>证据：{item.assessment.evidence_ids.join(' · ')}</small>
        </article>)}</div>}
    </section>
    <section className="panel industrial-outcome-panel"><div className="panel-title"><span className="eyebrow">04 / INDUSTRIAL OUTCOMES</span><h2>工业效果与约束评测</h2></div>
      <p className="fineprint">以下指标基于固定合成测点与排程规则；与在线模型的 Harness 通过率分开。延期是软指标，设备冲突和不兼容分配才算约束违规。</p>
      {outcome && <><div className="outcome-metrics">
        <span>已确认告警 <b>{outcome.alarms.length}</b></span>
        <span>排程约束违规 <b>{outcome.scheduling.constraint_violations.length}</b></span>
        <span>交期策略少延期 <b>{outcome.scheduling.delay_saved_h} h</b></span>
        <span>额外能耗 <b>{outcome.scheduling.extra_energy_kwh} kWh</b></span>
      </div><p className="fineprint">{outcome.scheduling.case_id} 的设备停用假设：交期优先延期 {outcome.scheduling.deadline_first_late_h} h，能耗优先延期 {outcome.scheduling.energy_first_late_h} h；已保存人工选择 {outcome.scheduling.human_choices} 次。当前案例 CSV 导入 {outcome.imports.find((item) => item.case_id === caseId)?.batches ?? 0} 批。</p>
        <div className="alarm-latencies">{outcome.alarms.map((item) => <span key={item.case_id}>{item.case_id} · 首次待确认到持续告警 {item.confirmation_minutes === null ? '未知' : `${item.confirmation_minutes} 分钟`} · {item.evidence_ids.join(' / ')}</span>)}</div>
      </>}
    </section>
  </>;
}
