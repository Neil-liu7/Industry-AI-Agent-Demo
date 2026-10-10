import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { Type, type Model } from '@earendil-works/pi-ai';

export async function runPiSmoke(model: Model<any>, streamFn: StreamFn, getApiKey?: (provider: string) => string | undefined) {
  const events: string[] = [];
  const parameters = Type.Object({ key: Type.Literal('status') }, { additionalProperties: false });
  const tool: AgentTool<typeof parameters> = {
    name: 'read_fixed_value',
    label: 'Read fixed value',
    description: 'Return a fixed read-only value for integration verification.',
    parameters,
    execute: async (_id, params) => ({
      content: [{ type: 'text', text: `status=${params.key}:ok` }],
      details: { value: 'ok' },
    }),
  };
  const agent = new Agent({
    initialState: { systemPrompt: 'Use read_fixed_value to answer status questions.', model, tools: [tool] },
    streamFn, getApiKey,
  });
  agent.subscribe((event) => { events.push(event.type); });
  await agent.prompt('What is the status?');
  return { events, messages: agent.state.messages, error: agent.state.errorMessage };
}
