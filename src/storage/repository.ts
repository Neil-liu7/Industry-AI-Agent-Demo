import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { caseSchema, type IndustrialCase } from '../domain/cases';

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

  close() { this.db.close(); }
}

function zCases(raw: string) {
  return caseSchema.array().min(3).parse(JSON.parse(raw));
}
