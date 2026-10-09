import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { caseSchema, type IndustrialCase } from '../domain/cases';
import type { RunResult } from '../harness/run';

export function databasePath() {
  return join(process.env.DATA_DIR ?? 'data', 'demo.sqlite');
}

export class Repository {
  readonly db: DatabaseSync;

  constructor(path = databasePath()) {
    if (path !== ':memory:') mkdirSync(join(path, '..'), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cases (case_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_records (
        case_id TEXT PRIMARY KEY, equipment_id TEXT NOT NULL,
        record_id TEXT NOT NULL, date TEXT NOT NULL, summary TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, mode TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_filter ON sessions(case_id, mode, created_at DESC, id DESC);
    `);
  }

  seed(path = join(process.cwd(), 'data', 'cases.json')) {
    const cases = zCases(readFileSync(path, 'utf8'));
    const insertCase = this.db.prepare('INSERT OR REPLACE INTO cases (case_id, payload) VALUES (?, ?)');
    const insertMaintenance = this.db.prepare('INSERT OR REPLACE INTO maintenance_records VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const data of cases) {
        insertCase.run(data.case_id, JSON.stringify(data));
        insertMaintenance.run(data.case_id, data.equipment_id, data.maintenance_record.record_id,
          data.maintenance_record.date, data.maintenance_record.summary);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listCases(): IndustrialCase[] {
    return this.db.prepare('SELECT payload FROM cases ORDER BY case_id').all()
      .map((row) => caseSchema.parse(JSON.parse(String(row.payload))));
  }

  getCase(caseId: string): IndustrialCase | null {
    const row = this.db.prepare('SELECT payload FROM cases WHERE case_id = ?').get(caseId);
    return row ? caseSchema.parse(JSON.parse(String(row.payload))) : null;
  }

  getMaintenance(caseId: string, equipmentId: string) {
    const row = this.db.prepare('SELECT record_id, date, summary FROM maintenance_records WHERE case_id = ? AND equipment_id = ?')
      .get(caseId, equipmentId);
    return row ? { record_id: String(row.record_id), date: String(row.date), summary: String(row.summary) } : null;
  }

  saveSession(session: RunResult) {
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
      session.id, session.case_id, session.mode, session.status, session.created_at, JSON.stringify(session));
  }

  getSession(id: string): RunResult | null {
    const row = this.db.prepare('SELECT payload FROM sessions WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.payload)) as RunResult : null;
  }

  listSessions(filters: { case_id?: string; mode?: 'online' | 'replay'; limit?: number; cursor?: string }) {
    const limit = Math.max(1, Math.min(filters.limit ?? 20, 50));
    let cursor: { created_at: string; id: string } | null = null;
    if (filters.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(filters.cursor, 'base64url').toString('utf8'));
        if (typeof decoded.created_at !== 'string' || typeof decoded.id !== 'string') throw new Error();
        cursor = decoded;
      } catch { throw new Error('Invalid cursor'); }
    }
    const where = ['1=1'];
    const params: (string | number)[] = [];
    if (filters.case_id) { where.push('case_id = ?'); params.push(filters.case_id); }
    if (filters.mode) { where.push('mode = ?'); params.push(filters.mode); }
    if (cursor) { where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.created_at, cursor.created_at, cursor.id); }
    const rows = this.db.prepare(`SELECT payload, created_at, id FROM sessions WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ?`).all(...params, limit + 1);
    const items = rows.slice(0, limit).map((row) => JSON.parse(String(row.payload)) as RunResult);
    const last = rows[limit - 1];
    const next_cursor = rows.length > limit && last ? Buffer.from(JSON.stringify({
      created_at: last.created_at, id: last.id,
    })).toString('base64url') : null;
    return { items, next_cursor };
  }

  close() { this.db.close(); }
}

function zCases(raw: string) {
  return caseSchema.array().min(3).parse(JSON.parse(raw));
}
