import type { RunResult } from '../harness/run';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);
const list = (items: string[]) => `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`;
const percent = (value: number | null) => value === null ? '未知' : `${value.toFixed(1)}%`;

export function renderReport(session: RunResult): string {
  const diagnosis = session.diagnosis;
  const mode = session.mode === 'replay' ? '离线预录回放' : '在线 Pi Agent 诊断';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>辅助诊断报告 · ${escape(session.case_id)}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;color:#17252c;max-width:820px;margin:32px auto;padding:0 24px}header{border-bottom:3px solid #147d75}h1,h2{line-height:1.25}section{margin:24px 0}.tag{display:inline-block;background:#e6f3f0;padding:4px 9px;margin-right:8px}li{margin:5px 0}small{color:#52636c}@media print{button{display:none}body{margin:0;max-width:none}}</style>
</head><body><header><h1>工业智能体辅助诊断报告</h1><p><span class="tag">合成数据</span><span class="tag">${mode}</span><span class="tag">${escape(session.status)}</span></p></header>
<section><h2>案例与范围</h2><p>案例 ${escape(session.case_id)} · 快照 ${escape(session.snapshot_date)} · Skill ${escape(session.skill.name)} ${escape(session.skill.version)}</p><p>问题：${escape(session.question)}</p></section>
<section><h2>结论与风险</h2><p><strong>${escape(session.metrics.risk_level)}</strong> · ${diagnosis ? escape(diagnosis.summary) : '诊断未完成；保留已采集轨迹。'}</p><p>产量变化 ${percent(session.metrics.output_change_pct)} · 温度偏移 ${percent(session.metrics.temperature_change_pct)} · 振动偏移 ${percent(session.metrics.vibration_change_pct)}</p>${session.metrics.risk_level === 'UNKNOWN' ? '<p>关键数据或时间窗不可比较；风险等级未判定，请先人工复核数据。</p>' : ''}</section>
<section><h2>证据来源</h2>${list(session.evidence.map((item) => `${item.id} · ${item.source} · ${item.tool}`))}</section>
<section><h2>待核查假设</h2>${list(diagnosis?.hypotheses ?? [])}</section>
<section><h2>建议的人工检查</h2>${list(diagnosis?.recommended_checks ?? [])}</section>
<section><h2>限制</h2>${list(diagnosis?.limitations ?? ['结果校验未通过，不提供故障结论。'])}<p>本报告仅基于合成数据提供辅助诊断，不是已证实的故障原因或设备控制指令。</p></section>
<small>会话 ${escape(session.id)} · 生成 ${escape(session.created_at)} · 停止原因 ${escape(session.stop_reason)}</small>
<p><button onclick="window.print()">打印报告</button></p></body></html>`;
}
