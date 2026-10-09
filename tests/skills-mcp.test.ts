import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSkills, selectSkill } from '../src/skills';
import { MaintenanceClient } from '../src/mcp/client';
import { Repository } from '../src/storage/repository';
import { createApp } from '../src/app/api';

describe('trusted skills', () => {
  const skills = loadSkills();
  it('loads two versioned declarations and selects by intent', () => {
    expect(skills).toHaveLength(2);
    expect(skills.every((skill) => skill.inputs.includes('case_id') && skill.outputs.includes('evidence_ids'))).toBe(true);
    expect(selectSkill(skills, '设备巡检优先级').id).toBe('equipment-priority-patrol');
    expect(selectSkill(skills, '产量为何下降').id).toBe('line-anomaly-diagnosis');
    expect(() => selectSkill(skills, 'anything', 'missing')).toThrow('Unknown skill');
  });

  it('refuses to start the API with malformed skill declarations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-invalid-skills-'));
    const previous = process.cwd();
    const repository = new Repository(':memory:');
    try {
      mkdirSync(join(dir, 'src', 'skills'), { recursive: true });
      writeFileSync(join(dir, 'src', 'skills', 'line-diagnosis.json'), '{}');
      writeFileSync(join(dir, 'src', 'skills', 'equipment-patrol.json'), '{}');
      process.chdir(dir);
      expect(() => createApp(repository, () => null)).toThrow();
    } finally {
      process.chdir(previous);
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('times out a live stdio MCP request and rejects forged output', async () => {
    const fixture = resolve('tests/fixtures/mcp-behavior.ts');
    const hanging = new MaintenanceClient(['--import', 'tsx', fixture, 'hang']);
    await hanging.connect();
    await expect(hanging.getHistory('IND-001', 'EQ-003', 30)).rejects.toThrow();
    await hanging.close();
    expect(hanging.childPid).toBeNull();

    const forged = new MaintenanceClient(['--import', 'tsx', fixture, 'forged']);
    await forged.connect();
    await expect(forged.getHistory('IND-001', 'EQ-003')).rejects.toThrow('mismatched evidence');
    await forged.close();
  });
});
