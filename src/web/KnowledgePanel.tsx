import { useEffect, useRef, useState } from 'react';
import type { KnowledgeMatch } from '../knowledge';

type SearchResponse = { case_id: string; query: string; version: string; data_type: 'synthetic'; results: KnowledgeMatch[] };

function defaultQuery(caseId: string) {
  if (caseId === 'IND-004') return '缺失';
  if (caseId === 'IND-005') return '振动';
  if (caseId === 'IND-002') return '产量';
  return '温度';
}

export function KnowledgePanel({ caseId, checks }: { caseId: string; checks: string[] }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);

  async function search(term: string, currentCase = caseId) {
    if (term.trim().length < 2 || term.length > 100) { setError('请输入 2–100 字的检索词。'); return; }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ case_id: currentCase, query: term });
      const response = await fetch(`/api/knowledge?${params}`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '检索失败');
      if (!controller.signal.aborted) setResult(body as SearchResponse);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '检索失败');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }

  useEffect(() => {
    const term = defaultQuery(caseId);
    setQuery(term); setResult(null);
    void search(term, caseId);
    return () => request.current?.abort();
  }, [caseId]);

  return <section className="panel knowledge-panel"><div className="panel-title"><span className="eyebrow">08 / ASSET KNOWLEDGE</span><h2>设备知识检索</h2></div>
    <p className="fineprint">按案例从固定合成 SOP 卡片中查找人工核查步骤。每张卡片显示文档 ID、版本和日期；检索为确定性关键词匹配。</p>
    <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); void search(query); }}>
      <label htmlFor="knowledge-query">检索设备知识</label><input id="knowledge-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：温度、振动、维修" maxLength={100}/>
      <button disabled={loading || !caseId}>{loading ? '检索中…' : '检索'}</button>
    </form>
    {checks.length > 0 && <div className="knowledge-suggestions"><span>从诊断建议查阅：</span>{checks.slice(0, 3).map((check) => <button key={check} onClick={() => { setQuery(check); void search(check); }}>{check}</button>)}</div>}
    {error && <p className="knowledge-error" role="alert">{error}</p>}
    {result && <><p className="fineprint">{result.case_id} · 检索词“{result.query}” · 命中 {result.results.length} 张合成卡片 · 知识库 v{result.version}</p>
      {result.results.length === 0 ? <p className="knowledge-empty">没有匹配的知识卡片，请换用设备或指标关键词。</p> : <div className="knowledge-results">{result.results.map((item) => <article key={item.id}>
        <header><b>{item.title}</b><code>{item.id}</code></header><small>合成 SOP · v{item.version} · {item.updated_at} · 命中：{item.matched_terms.join('、')}</small>
        <p>{item.summary}</p><ol>{item.checks.map((check) => <li key={check}>{check}</li>)}</ol>
      </article>)}</div>}</>}
  </section>;
}
