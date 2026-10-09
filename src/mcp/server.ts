import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Repository } from '../storage/repository';

const repository = new Repository();
const server = new McpServer({ name: 'industrial-maintenance-readonly', version: '1.0.0' });

server.registerTool('get_maintenance_history', {
  description: 'Read synthetic maintenance history for one case and equipment. No writes.',
  inputSchema: { case_id: z.string(), equipment_id: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ case_id, equipment_id }) => {
  const data = repository.getMaintenance(case_id, equipment_id);
  if (!data) return { isError: true, content: [{ type: 'text', text: 'Maintenance record not found' }] };
  return { content: [{ type: 'text', text: JSON.stringify({
    case_id, equipment_id, data_type: 'synthetic',
    evidence_id: `${case_id}:maintenance:${data.record_id}`, ...data,
  }) }] };
});

await server.connect(new StdioServerTransport());
process.on('SIGTERM', () => { void server.close().finally(() => repository.close()); });
