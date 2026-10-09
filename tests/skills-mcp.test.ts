import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkills, selectSkill } from '../src/skills';
import { MaintenanceClient } from '../src/mcp/client';
import { Repository } from '../src/storage/repository';

describe('trusted skills', () => {
  const skills = loadSkills();
  it('loads two versioned declarations and selects by intent', () => {
    expect(skills).toHaveLength(2);
    expect(selectSkill(skills, '设备巡检优先级').id).toBe('equipment-priority-patrol');
    expect(selectSkill(skills, '产量为何下降').id).toBe('line-anomaly-diagnosis');
    expect(() => selectSkill(skills, 'anything', 'missing')).toThrow('Unknown skill');
  });
});

describe('read-only stdio MCP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-industrial-mcp-'));
  let client: MaintenanceClient;
  beforeAll(async () => {
    const repository = new Repository(join(dir, 'demo.sqlite'));
    repository.seed();
    repository.close();
    process.env.DATA_DIR = dir;
    client = new MaintenanceClient();
    await client.connect();
  });
  afterAll(async () => {
    await client?.close();
    delete process.env.DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers and calls a real child-process MCP tool', async () => {
    const history = await client.getHistory('IND-001', 'EQ-003');
    expect(history.evidence_id).toBe('IND-001:maintenance:MAINT-003');
    await expect(client.getHistory('IND-001', 'EQ-002')).rejects.toThrow();
  });

  it('reports a disconnected child and releases the process', async () => {
    const disconnected = new MaintenanceClient();
    await disconnected.connect();
    const pid = disconnected.childPid;
    expect(pid).toBeTypeOf('number');
    process.kill(pid!, 'SIGKILL');
    await expect(disconnected.getHistory('IND-001', 'EQ-003')).rejects.toThrow();
    await disconnected.close();
    expect(disconnected.childPid).toBeNull();
  });

  it('opens the maintenance database in read-only mode', () => {
    const readonly = new Repository(join(dir, 'demo.sqlite'), { readOnly: true });
    expect(readonly.getMaintenance('IND-001', 'EQ-003')?.record_id).toBe('MAINT-003');
    expect(() => readonly.seed()).toThrow();
    readonly.close();
    expect(() => new Repository(join(dir, 'absent.sqlite'), { readOnly: true })).toThrow();
  });
});
