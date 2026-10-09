import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

export const fakeModel: Model<'openai-completions'> = {
  id: 'fake', name: 'Fake model', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://localhost', input: ['text'], reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 1024,
};

export function fakeMessage(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', content, stopReason, api: fakeModel.api,
    provider: fakeModel.provider, model: fakeModel.id, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export function scriptedStream(messages: AssistantMessage[], onRequest?: (context: TranscriptContext, index: number) => void): StreamFn {
  let index = 0;
  return (_model, context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const current = index++;
    onRequest?.(context, current);
    const message = messages[current];
    if (!message) throw new Error(`Unexpected model request ${current}`);
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      } else if (message.stopReason === 'pending') {
        throw new Error('Pending response cannot finish a fake stream');
      } else {
        stream.push({ type: 'done', reason: message.stopReason, message });
      }
    });
    return stream;
  };
}
