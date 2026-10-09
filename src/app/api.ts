import express from 'express';
import { z } from 'zod';
import { calculateMetrics, evidenceIds } from '../domain/cases';
import { runDiagnosis, type OnlineEngine } from '../harness/run';
import { createReplay } from '../harness/replay';
import { loadSkills } from '../skills';
import { Repository } from '../storage/repository';
import { onlineEngineFromEnv } from './model';
import { renderReport } from './report';

const diagnosisInput = z.object({
  case_id: z.string().min(1), question: z.string().trim().min(1).max(2000),
  skill_id: z.string().optional(),
}).strict();
const replayInput = z.object({ case_id: z.string().min(1) }).strict();

export function createApp(repository: Repository, engineFactory: () => OnlineEngine | null = onlineEngineFromEnv) {
  const skills = loadSkills();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true, data_type: 'synthetic' }));
  app.get('/api/cases', (_req, res) => res.json(repository.listCases().map((data) => {
    const metrics = calculateMetrics(data);
    return {
      case_id: data.case_id, title: data.title, snapshot_date: data.snapshot_date,
      data_type: data.data_type, line_id: data.line_id, equipment_id: data.equipment_id,
      metrics, risk_level: metrics.risk_level,
    };
  })));
  app.get('/api/cases/:case_id/snapshot', (req, res) => {
    const data = repository.getCase(req.params.case_id);
    if (!data) return res.status(404).json({ error: 'Case not found' });
    const { maintenance_record: _maintenance, ...snapshot } = data;
    return res.json({ ...snapshot, metrics: calculateMetrics(data), evidence_ids: evidenceIds(data) });
  });
  app.get('/api/agent/capabilities', (_req, res) => res.json({
    online_available: engineFactory() !== null, replay_available: true,
    skills: skills.map(({ id, version, name, purpose }) => ({ id, version, name, purpose })),
    tools: [
      { name: 'get_line_snapshot', source: 'local' },
      { name: 'get_equipment_snapshot', source: 'local' },
      { name: 'get_maintenance_history', source: 'mcp' },
    ],
    limits: { model_calls: 4, tool_calls: 6, tool_timeout_ms: 5000, task_timeout_ms: 30000 },
  }));
  app.post('/api/diagnose', async (req, res) => {
    const parsed = diagnosisInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid diagnosis request' });
    if (!repository.getCase(parsed.data.case_id)) return res.status(404).json({ error: 'Case not found' });
    const engine = engineFactory();
    if (!engine) return res.status(503).json({ error: 'Online model is not configured; use replay mode' });
    try {
      const session = await runDiagnosis(repository, parsed.data, engine);
      repository.saveSession(session);
      return res.json(session);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' });
    }
  });
  app.post('/api/replay', (req, res) => {
    const parsed = replayInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid replay request' });
    try {
      const session = createReplay(repository, parsed.data.case_id);
      repository.saveSession(session);
      return res.json(session);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Replay unavailable' });
    }
  });
  app.get('/api/sessions', (req, res) => {
    const mode = req.query.mode;
    if (mode !== undefined && mode !== 'online' && mode !== 'replay') return res.status(400).json({ error: 'Invalid mode' });
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) return res.status(400).json({ error: 'Invalid limit' });
    try {
      return res.json(repository.listSessions({
        case_id: typeof req.query.case_id === 'string' ? req.query.case_id : undefined,
        mode, limit, cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      }));
    } catch { return res.status(400).json({ error: 'Invalid cursor' }); }
  });
  app.get('/api/sessions/:id', (req, res) => {
    const session = repository.getSession(req.params.id);
    return session ? res.json(session) : res.status(404).json({ error: 'Session not found' });
  });
  app.get('/api/reports/:id', (req, res) => {
    const session = repository.getSession(req.params.id);
    return session ? res.type('html').send(renderReport(session)) : res.status(404).json({ error: 'Session not found' });
  });
  return app;
}
