import { describe, expect, it } from 'vitest';
import { runPiSmoke } from '../src/agent/pi-smoke';
import { fakeMessage, fakeModel, scriptedStream } from './helpers/fake-model';

describe('Pi Agent Core package integration', () => {
  it('runs a model-originated tool call and observes the final answer', async () => {
    const result = await runPiSmoke(fakeModel, scriptedStream([
      fakeMessage([{ type: 'toolCall', id: 'call-1', name: 'read_fixed_value', arguments: { key: 'status' } }], 'toolUse'),
      fakeMessage([{ type: 'text', text: 'The status is ok.' }], 'stop'),
    ], (context, index) => {
      if (index === 1) expect(JSON.stringify(context.messages)).toContain('status=status:ok');
    }));
    expect(result.events).toContain('tool_execution_start');
    expect(result.events).toContain('tool_execution_end');
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' });
    expect(result.error).toBeUndefined();
  });

  it('exposes a model failure without manufacturing tool activity', async () => {
    const result = await runPiSmoke(fakeModel, scriptedStream([
      { ...fakeMessage([], 'error'), errorMessage: 'fake provider failed' },
    ]));
    expect(result.events).not.toContain('tool_execution_start');
    expect(result.error).toContain('fake provider failed');
  });
});
