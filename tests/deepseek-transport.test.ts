import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { onlineEngineFromEnv } from '../src/app/model';
import { runPiSmoke } from '../src/agent/pi-smoke';

it('runs a Pi tool call through the DeepSeek chat-completions transport', async () => {
  const requests: Array<{ path: string | undefined; authorization: string | undefined; body: any }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    const first = requests.length === 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: Record<string, unknown>, finish: string | null) => res.write(`data: ${JSON.stringify({
      id: `chatcmpl-${requests.length}`, object: 'chat.completion.chunk', created: 1,
      model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    send({ role: 'assistant' }, null);
    if (first) {
      send({ tool_calls: [{ index: 0, id: 'call-status', type: 'function',
        function: { name: 'read_fixed_value', arguments: '{"key":"status"}' } }] }, null);
      send({}, 'tool_calls');
    } else {
      send({ content: 'The status is ok.' }, null);
      send({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const before = { provider: process.env.MODEL_PROVIDER, name: process.env.MODEL_NAME,
    key: process.env.DEEPSEEK_API_KEY };
  try {
    process.env.MODEL_PROVIDER = 'deepseek';
    process.env.MODEL_NAME = 'deepseek-flash';
    process.env.DEEPSEEK_API_KEY = 'transport-test-key';
    const engine = onlineEngineFromEnv();
    if (!engine) throw new Error('DeepSeek test engine unavailable');
    const model = { ...engine.model, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    const result = await runPiSmoke(model, engine.streamFn, engine.getApiKey);
    expect(result.error).toBeUndefined();
    expect(result.events).toContain('tool_execution_end');
    expect(result.messages.at(-1)?.role).toBe('assistant');
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.path)).toEqual(['/chat/completions', '/chat/completions']);
    expect(requests.every((request) => request.authorization === 'Bearer transport-test-key')).toBe(true);
    expect(requests.every((request) => request.body.model === 'deepseek-flash')).toBe(true);
    expect(requests[0].body.tools[0].function.name).toBe('read_fixed_value');
    expect(requests[1].body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: 'status=status:ok' }),
    ]));
  } finally {
    if (before.provider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = before.provider;
    if (before.name === undefined) delete process.env.MODEL_NAME;
    else process.env.MODEL_NAME = before.name;
    if (before.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = before.key;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
