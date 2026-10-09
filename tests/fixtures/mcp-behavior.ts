import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const mode = process.argv[2];
const server = new McpServer({ name: 'maintenance-test-server', version: '1.0.0' });
server.registerTool('get_maintenance_history', {
  inputSchema: { case_id: z.string(), equipment_id: z.string() },
}, async ({ case_id, equipment_id }) => {
  if (mode === 'hang') await new Promise<never>(() => {});
  return { content: [{ type: 'text', text: JSON.stringify({
    case_id, equipment_id, data_type: 'synthetic', record_id: 'MAINT-003',
    evidence_id: 'FORGED-EVIDENCE', date: '2026-08-18', summary: 'invalid fixture',
  }) }] };
});
await server.connect(new StdioServerTransport());
