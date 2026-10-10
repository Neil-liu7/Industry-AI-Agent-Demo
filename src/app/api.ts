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
import { loadKnowledgeLibrary, searchKnowledge } from '../knowledge';
import { loadSchedulingDataset, simulateIncidentImpact, simulateSchedule } from '../scheduling';
import { assessOperations, loadOperationsDataset, telemetryEvidence, verifyOperations } from '../operations';
import { importTelemetryCsv } from '../telemetry-import';
import { evaluateIndustrialOutcome } from '../industrial-evaluation';

const diagnosisInput = z.object({
  case_id: z.string().min(1), question: z.string().trim().min(1).max(2000),
  skill_id: z.string().optional(),
}).strict();
const replayInput = z.object({ case_id: z.string().min(1), question: z.string().trim().min(1).max(2000).optional() }).strict();
const evaluationInput = z.object({ skill_id: z.string().min(1) }).strict();
const safetyInput = z.object({
  scenario_id: z.enum(['control-request', 'cross-case', 'forged-evidence', 'mcp-timeout']),
}).strict();
const workOrderInput = z.object({
  session_id: z.string().uuid(), assignee: z.enum(workOrderAssignees.map((item) => item.id)),
}).strict();
const workOrderStatusInput = z.object({ status: z.enum(['in_progress', 'completed']) }).strict();
const checklistInput = z.object({
  completed: z.boolean(), finding: z.enum(['normal', 'abnormal', 'uncertain']).optional(),
  note: z.string().trim().min(3).max(500).optional(),
}).strict();
const resolutionInput = z.object({
  production_confirmed: z.literal(true), quality_confirmed: z.literal(true),
  note: z.string().trim().min(10).max(1000),
}).strict();
const schedulingInput = z.object({ unavailable_machine_id: z.string().nullable() }).strict();
const scheduleDecisionInput = z.object({
  case_id: z.string().min(1), work_order_id: z.string().uuid(),
  strategy: z.enum(['deadline_first', 'energy_first']), note: z.string().trim().min(10).max(500),
}).strict();
const verificationInput = z.object({ case_id: z.string(), action_id: z.string() }).strict();
const telemetryImportInput = z.object({ case_id: z.string().min(1), csv: z.string().min(1).max(12000) }).strict();

export function createApp(repository: Repository, engineFactory: () => OnlineEngine | null = onlineEngineFromEnv) {
  const skills = loadSkills();
  const evaluationSuite = loadEvaluationSuite(repository);
  const knowledgeLibrary = loadKnowledgeLibrary(repository);
  const schedulingDataset = loadSchedulingDataset();
  const operationsDataset = loadOperationsDataset(repository);
  const scheduleEpisode = operationsDataset.episodes.find((item) =>
    item.case_id === schedulingDataset.incident_source.case_id);
  if (!scheduleEpisode || scheduleEpisode.line_id !== schedulingDataset.line_id ||
    scheduleEpisode.equipment_id !== schedulingDataset.incident_source.equipment_id) {
    throw new Error('Scheduling incident source does not match equipment context');
  }
  const scheduleImpact = () => simulateIncidentImpact(schedulingDataset,
    telemetryEvidence(scheduleEpisode, operationsDataset.thresholds).incident);
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
  app.get('/api/knowledge', (req, res) => {
    const caseId = req.query.case_id;
    const query = req.query.query;
    if (typeof caseId !== 'string' || !repository.getCase(caseId) || typeof query !== 'string') {
      return res.status(400).json({ error: 'Valid case_id and query are required' });
    }
    try {
      return res.json({ case_id: caseId, query, version: knowledgeLibrary.version,
        data_type: 'synthetic', results: searchKnowledge(knowledgeLibrary, caseId, query) });
    } catch { return res.status(400).json({ error: 'Query must be 2–100 characters' }); }
  });
  app.get('/api/scheduling', (_req, res) => res.json(schedulingDataset));
  app.post('/api/scheduling/simulate', (req, res) => {
    const parsed = schedulingInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid scheduling scenario' });
    try {
      const unavailable = parsed.data.unavailable_machine_id;
      return res.json({ data_type: 'synthetic', unavailable_machine_id: unavailable,
        deadline_first: simulateSchedule(schedulingDataset, 'deadline_first', unavailable),
        energy_first: simulateSchedule(schedulingDataset, 'energy_first', unavailable) });
    } catch { return res.status(400).json({ error: 'Unavailable machine is unknown or leaves an order unschedulable' }); }
  });
  app.get('/api/scheduling/incident-impact', (req, res) => {
    if (req.query.case_id !== schedulingDataset.incident_source.case_id) {
      return res.status(400).json({ error: 'No mapped scheduling equipment for this case' });
    }
    try { return res.json(scheduleImpact()); }
    catch { return res.status(409).json({ error: 'No confirmed alarm or feasible disruption plan' }); }
  });
  app.get('/api/scheduling/decisions', (req, res) => {
    if (req.query.case_id !== schedulingDataset.incident_source.case_id) {
      return res.status(400).json({ error: 'No mapped scheduling equipment for this case' });
    }
    return res.json({ items: repository.listScheduleDecisions(schedulingDataset.incident_source.case_id) });
  });
  app.post('/api/scheduling/decisions', (req, res) => {
    const parsed = scheduleDecisionInput.safeParse(req.body);
    if (!parsed.success || parsed.data.case_id !== schedulingDataset.incident_source.case_id) {
      return res.status(400).json({ error: 'Invalid schedule decision' });
    }
    const order = repository.getWorkOrder(parsed.data.work_order_id);
    if (!order || order.case_id !== parsed.data.case_id || order.equipment_id !== scheduleEpisode.equipment_id ||
      order.resolution) return res.status(409).json({ error: 'An unresolved linked work order is required' });
    try {
      const impact = scheduleImpact();
      if (order.incident?.telemetry_evidence_id !== impact.incident.telemetry_evidence_id) {
        return res.status(409).json({ error: 'Work order alarm evidence does not match' });
      }
      const decision = { id: randomUUID(), case_id: parsed.data.case_id,
        work_order_id: order.id, created_at: new Date().toISOString(),
        strategy: parsed.data.strategy, note: parsed.data.note, impact };
      repository.saveScheduleDecision(decision);
      return res.status(201).json(decision);
    } catch { return res.status(409).json({ error: 'No confirmed alarm or feasible disruption plan' }); }
  });
  app.get('/api/operations', (req, res) => {
    const episode = operationsDataset.episodes.find((item) => item.case_id === req.query.case_id);
    if (!episode) return res.status(400).json({ error: 'Unknown operations case' });
    return res.json({ version: operationsDataset.version, data_type: 'synthetic',
      thresholds: operationsDataset.thresholds, case_id: episode.case_id,
      line_id: episode.line_id, equipment_id: episode.equipment_id,
      points: episode.points, assessments: episode.points.map((_, index) =>
        assessOperations(episode, operationsDataset.thresholds, index)) });
  });
  app.post('/api/operations/verify', (req, res) => {
    const parsed = verificationInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid verification request' });
    const episode = operationsDataset.episodes.find((item) => item.case_id === parsed.data.case_id);
    if (!episode) return res.status(400).json({ error: 'Unknown operations case' });
    try { return res.json(verifyOperations(episode, operationsDataset.thresholds, parsed.data.action_id)); }
    catch { return res.status(409).json({ error: 'No verified scenario for this action' }); }
  });
  app.get('/api/telemetry/imports', (req, res) => {
    if (typeof req.query.case_id !== 'string' || !repository.getCase(req.query.case_id)) {
      return res.status(400).json({ error: 'Valid case_id is required' });
    }
    return res.json({ items: repository.listTelemetryImports(req.query.case_id) });
  });
  app.post('/api/telemetry/import', (req, res) => {
    const parsed = telemetryImportInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid CSV import request' });
    const selected = repository.getCase(parsed.data.case_id);
    if (!selected) return res.status(400).json({ error: 'Unknown case_id' });
    try {
      const imported = importTelemetryCsv(parsed.data.csv, selected, operationsDataset.thresholds);
      repository.saveTelemetryImport(imported);
      return res.status(201).json(imported);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid CSV data' });
    }
  });
  app.get('/api/industrial-evaluation', (_req, res) =>
    res.json(evaluateIndustrialOutcome(repository, operationsDataset, schedulingDataset)));
  app.get('/api/agent/capabilities', (_req, res) => res.json({
    online_available: engineFactory() !== null, replay_available: true,
    skills: skills.map(({ id, version, name, purpose }) => ({ id, version, name, purpose })),
    tools: [
      { name: 'get_line_snapshot', source: 'local' },
      { name: 'get_equipment_snapshot', source: 'local' },
      { name: 'get_recent_telemetry', source: 'local' },
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
      const session = createReplay(repository, parsed.data.case_id, parsed.data.question);
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
    const episode = operationsDataset.episodes.find((item) => item.case_id === session.case_id)!;
    const incident = session.incident?.telemetry_evidence_id === `${session.case_id}:telemetry:${data.snapshot_date}` &&
      session.diagnosis.evidence_ids.includes(session.incident.telemetry_evidence_id)
      ? session.incident : null;
    const sopDocument = knowledgeLibrary.documents.find((item) => item.id === incident?.recommendation?.sop_id &&
      item.case_ids.includes(session.case_id));
    if (incident?.recommendation && !sopDocument) return res.status(409).json({ error: 'Incident SOP is unavailable' });
    if (incident && (episode.line_id !== data.line_id || episode.equipment_id !== data.equipment_id)) {
      return res.status(409).json({ error: 'Incident scope mismatch' });
    }
    const now = new Date().toISOString();
    const order: WorkOrder = {
      id: randomUUID(), session_id: session.id, case_id: session.case_id, equipment_id: data.equipment_id,
      created_at: now, updated_at: now, assignee: parsed.data.assignee, risk_level: session.metrics.risk_level,
      status: 'open', diagnosis_summary: session.diagnosis.summary,
      evidence_ids: [...session.diagnosis.evidence_ids],
      checklist: session.diagnosis.recommended_checks.map((description) => ({ id: randomUUID(), description, completed: false })),
      incident, sop: sopDocument ? { id: sopDocument.id, title: sopDocument.title, version: sopDocument.version } : null,
      recheck: null, resolution: null,
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
      parsed.data.status === 'completed' && (order.status !== 'in_progress' || order.checklist.some((item) =>
        !item.completed || !item.finding || !item.note || !item.checked_at))) {
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
    if (parsed.data.completed && (!parsed.data.finding || !parsed.data.note)) {
      return res.status(400).json({ error: 'Finding and inspection note are required' });
    }
    const order = repository.getWorkOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Work order not found' });
    const item = order.checklist.find((check) => check.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Checklist item not found' });
    if (order.status !== 'in_progress') return res.status(409).json({ error: 'Start the work order before updating checks' });
    item.completed = parsed.data.completed;
    item.finding = parsed.data.completed ? parsed.data.finding : undefined;
    item.note = parsed.data.completed ? parsed.data.note : undefined;
    item.checked_at = parsed.data.completed ? new Date().toISOString() : undefined;
    order.updated_at = new Date().toISOString();
    repository.updateWorkOrder(order);
    return res.json(order);
  });
  app.post('/api/work-orders/:id/recheck', (req, res) => {
    const order = repository.getWorkOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Work order not found' });
    if (order.status !== 'completed' || !order.incident?.recommendation || order.resolution) {
      return res.status(409).json({ error: 'Complete the incident inspection before recheck' });
    }
    const episode = operationsDataset.episodes.find((item) => item.case_id === order.case_id);
    if (!episode || episode.equipment_id !== order.equipment_id ||
      telemetryEvidence(episode, operationsDataset.thresholds).evidence_id !== order.incident.telemetry_evidence_id) {
      return res.status(409).json({ error: 'Incident scope mismatch' });
    }
    try {
      const result = verifyOperations(episode, operationsDataset.thresholds, order.incident.recommendation.action_id);
      order.recheck = { action_id: result.action_id, result: result.result, checked_at: new Date().toISOString(),
        evidence_ids: result.evidence_ids, checks: result.checks, message: result.message };
      order.updated_at = order.recheck.checked_at;
      repository.updateWorkOrder(order);
      return res.json(order);
    } catch { return res.status(409).json({ error: 'No verified scenario for this action' }); }
  });
  app.post('/api/work-orders/:id/resolve', (req, res) => {
    const parsed = resolutionInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Confirm production and quality with a note' });
    const order = repository.getWorkOrder(req.params.id);
    if (!order) return res.status(404).json({ error: 'Work order not found' });
    if (order.status !== 'completed' || order.recheck?.result !== 'PASS' || order.resolution ||
      order.checklist.some((item) => item.finding !== 'normal')) {
      return res.status(409).json({ error: 'Inspection and passing recheck are required before resolution' });
    }
    order.resolution = { ...parsed.data, confirmed_at: new Date().toISOString() };
    order.updated_at = order.resolution.confirmed_at;
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
