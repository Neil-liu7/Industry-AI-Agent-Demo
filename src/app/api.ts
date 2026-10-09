import express from 'express';
import { z } from 'zod';
import { calculateMetrics, evidenceIds } from '../domain/cases';
import { loadEvaluationSuite, runEvaluation } from '../evaluation';
import { runDiagnosis, type OnlineEngine } from '../harness/run';
import { createReplay } from '../harness/replay';
import { loadSkills } from '../skills';
import { Repository } from '../storage/repository';
import { onlineEngineFromEnv } from './model';
import { renderReport } from './report';
import { runSafetyScenario, safetyScenarios } from '../safety-lab';
import { randomUUID } from 'node:crypto';
import { workOrderAssignees, type WorkOrder, type WorkOrderStatus } from '../domain/work-orders';

const diagnosisInput = z.object({
  case_id: z.string().min(1), question: z.string().trim().min(1).max(2000),
  skill_id: z.string().optional(),
}).strict();
const replayInput = z.object({ case_id: z.string().min(1) }).strict();
const evaluationInput = z.object({ skill_id: z.string().min(1) }).strict();
const safetyInput = z.object({
  scenario_id: z.enum(['control-request', 'cross-case', 'forged-evidence', 'mcp-timeout']),
}).strict();
const workOrderInput = z.object({
  session_id: z.string().uuid(), assignee: z.enum(workOrderAssignees.map((item) => item.id)),
}).strict();
const workOrderStatusInput = z.object({ status: z.enum(['in_progress', 'completed']) }).strict();
const checklistInput = z.object({ completed: z.boolean() }).strict();

export function createApp(repository: Repository, engineFactory: () => OnlineEngine | null = onlineEngineFromEnv) {
  const skills = loadSkills();
  const evaluationSuite = loadEvaluationSuite(repository);
  let evaluationRunning = false;
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
  app.get('/api/evaluations', (_req, res) => res.json({
    suite: evaluationSuite, runs: repository.listEvaluations(),
  }));
  app.get('/api/evaluations/:id', (req, res) => {
    const run = repository.getEvaluation(req.params.id);
    return run ? res.json(run) : res.status(404).json({ error: 'Evaluation not found' });
  });
  app.post('/api/evaluations', async (req, res) => {
    const parsed = evaluationInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid evaluation request' });
    const skill = skills.find((item) => item.id === parsed.data.skill_id);
    if (!skill) return res.status(400).json({ error: 'Unknown skill' });
    if (evaluationRunning) return res.status(409).json({ error: 'Evaluation already running' });
    const engine = engineFactory();
    if (!engine) return res.status(503).json({ error: 'Online model is not configured' });
    evaluationRunning = true;
    try {
      const run = await runEvaluation(repository, evaluationSuite, skill, engine);
      repository.saveEvaluation(run);
      return res.json(run);
    } catch {
      return res.status(500).json({ error: 'Evaluation failed' });
    } finally { evaluationRunning = false; }
  });
  app.get('/api/safety-lab/scenarios', (_req, res) => res.json({
    execution: 'scripted_fake_model', data_type: 'synthetic', scenarios: safetyScenarios,
  }));
  app.post('/api/safety-lab', async (req, res) => {
    const parsed = safetyInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid safety scenario' });
    return res.json(await runSafetyScenario(repository, parsed.data.scenario_id));
  });
  app.get('/api/work-orders', (req, res) => {
    const caseId = req.query.case_id;
    if (caseId !== undefined && (typeof caseId !== 'string' || !repository.getCase(caseId))) {
      return res.status(400).json({ error: 'Invalid case_id' });
    }
    return res.json({ items: repository.listWorkOrders(caseId as string | undefined) });
  });
  app.post('/api/work-orders', (req, res) => {
    const parsed = workOrderInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid work order request' });
    const session = repository.getSession(parsed.data.session_id);
    if (!session || session.status !== 'completed' || !session.diagnosis || session.diagnosis.recommended_checks.length === 0) {
      return res.status(400).json({ error: 'A completed diagnosis with inspection checks is required' });
    }
    const data = repository.getCase(session.case_id);
    if (!data) return res.status(400).json({ error: 'Case no longer exists' });
    const now = new Date().toISOString();
    const order: WorkOrder = {
      id: randomUUID(), session_id: session.id, case_id: session.case_id, equipment_id: data.equipment_id,
      created_at: now, updated_at: now, assignee: parsed.data.assignee, risk_level: session.metrics.risk_level,
      status: 'open', diagnosis_summary: session.diagnosis.summary,
      evidence_ids: [...session.diagnosis.evidence_ids],
      checklist: session.diagnosis.recommended_checks.map((description) => ({ id: randomUUID(), description, completed: false })),
    };
    repository.saveWorkOrder(order);
    return res.status(201).json(order);
  });
  app.patch('/api/work-orders/:id/status', (req, res) => {
    const parsed = workOrderStatusInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid work order status' });
    const order = repository.getWorkOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Work order not found' });
    if (order.status === 'completed' || parsed.data.status === 'in_progress' && order.status !== 'open' ||
      parsed.data.status === 'completed' && (order.status !== 'in_progress' || order.checklist.some((item) => !item.completed))) {
      return res.status(409).json({ error: 'Work order transition is not allowed' });
    }
    order.status = parsed.data.status as WorkOrderStatus;
    order.updated_at = new Date().toISOString();
    repository.updateWorkOrder(order);
    return res.json(order);
  });
  app.patch('/api/work-orders/:id/checklist/:itemId', (req, res) => {
    const parsed = checklistInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid checklist update' });
    const order = repository.getWorkOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Work order not found' });
    const item = order.checklist.find((check) => check.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });
    if (order.status !== 'in_progress') return res.status(409).json({ error: 'Start the work order before updating checks' });
    item.completed = parsed.data.completed;
    order.updated_at = new Date().toISOString();
    repository.updateWorkOrder(order);
    return res.json(order);
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
