import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { resolve } from 'node:path';

const resultSchema = z.object({
  case_id: z.string(), equipment_id: z.string(), data_type: z.literal('synthetic'),
  evidence_id: z.string(), record_id: z.string(), date: z.iso.date(), summary: z.string(),
}).strict();

export class MaintenanceClient {
  private client = new Client({ name: 'industrial-demo', version: '1.0.0' });
  private transport: StdioClientTransport;

  constructor(serverArgs = process.env.NODE_ENV === 'production'
    ? [resolve('dist/mcp-server.js')] : ['--import', 'tsx', resolve('src/mcp/server.ts')]) {
    this.transport = new StdioClientTransport({
      command: process.execPath, args: serverArgs, cwd: process.cwd(), stderr: 'inherit',
      env: { PATH: process.env.PATH ?? '', DATA_DIR: resolve(process.env.DATA_DIR ?? 'data') },
    });
  }

  async connect() {
    await this.client.connect(this.transport);
    const tools = await this.client.listTools(undefined, { timeout: 5000 });
    if (!tools.tools.some((tool) => tool.name === 'get_maintenance_history')) {
      throw new Error('Required maintenance MCP tool not discovered');
    }
  }

  async getHistory(caseId: string, equipmentId: string, timeout = 5000) {
    const result = await this.client.callTool({ name: 'get_maintenance_history',
      arguments: { case_id: caseId, equipment_id: equipmentId } }, undefined, { timeout });
    if (result.isError) throw new Error('Maintenance MCP tool returned an error');
    const content = z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).parse(result.content);
    const text = content.find((item) => item.type === 'text');
    if (!text?.text) throw new Error('Maintenance MCP returned no text');
    const data = resultSchema.parse(JSON.parse(text.text));
    if (data.case_id !== caseId || data.equipment_id !== equipmentId ||
        data.evidence_id !== `${caseId}:maintenance:${data.record_id}`) {
      throw new Error('Maintenance MCP returned mismatched evidence');
    }
    return data;
  }

  async close() {
    await this.client.close();
    await this.transport.close();
  }
}
