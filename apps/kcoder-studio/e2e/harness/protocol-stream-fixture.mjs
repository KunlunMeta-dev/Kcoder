import { createServer } from 'node:http';

// Model-independent protocol fixture. It never stores request bodies or headers.
export async function startProtocolStreamFixture(context) {
  const requests = [];
  const active = new Set();
  const server = createServer((request, response) => {
    const task = (async () => {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('bounded protocol fixture body');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const truncated = JSON.stringify(body).includes('FIXTURE_EOF');
      const hasToolResult = (body.messages ?? []).some(message => message.role === 'tool' ||
        (Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'))) ||
        (Array.isArray(body.input) && body.input.some(item => item.type === 'function_call_output'));
      const tool = JSON.stringify(body).includes('FIXTURE_TOOL') && !hasToolResult;
      requests.push({ path: request.url, truncated });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of tool ? protocolToolFrames(request.url, body.model) : protocolFrames(request.url, body.model, truncated, !JSON.stringify(body).includes('FIXTURE_NO_THINKING'))) response.write(event);
      response.end();
    })().catch(() => response.destroy());
    active.add(task); void task.finally(() => active.delete(task));
  });
  context.addCleanup('stop protocol stream fixture', async () => {
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await Promise.allSettled([...active]); await closed;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.registerPort('protocol-stream-fixture', server.address().port);
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

export function protocolToolFrames(path, model) {
  const args = JSON.stringify({ command: 'printf x >> protocol-tool-count.txt', description: 'Count protocol fixture tool execution' });
  const data = value => `data: ${JSON.stringify(value)}\n\n`;
  const event = (type, value) => `event: ${type}\n${data({ type, ...value })}`;
  if (path === '/v1/messages') return [
    event('message_start', { message: { id: 'tool-fixture', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } }),
    event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'fixture-call', name: 'bash', input: {} } }),
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: args } }),
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }), event('message_stop', {}),
  ];
  if (path === '/v1/responses') return [
    event('response.output_item.added', { output_index: 0, item: { type: 'function_call', id: 'fixture-item', call_id: 'fixture-call', name: 'bash' } }),
    event('response.function_call_arguments.delta', { item_id: 'fixture-item', delta: args }),
    event('response.output_item.done', { item: { id: 'fixture-item', call_id: 'fixture-call' } }),
    event('response.completed', { response: { usage: { input_tokens: 1, output_tokens: 2 } } }),
  ];
  if (path !== '/v1/chat/completions') throw new Error('unexpected fixture protocol');
  return [data({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'bash', arguments: args } }] } }] }),
    data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n'];
}

export function protocolFrames(path, model, truncated, thinking = true) {
  const data = value => `data: ${JSON.stringify(value)}\n\n`;
  const event = (type, value) => `event: ${type}\n${data({ type, ...value })}`;
  if (path === '/v1/messages') return [
    event('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } }),
    ...(thinking ? [event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: 'THINK_' } }),
    event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'TAIL' } }),
    event('content_block_stop', { index: 0 })] : []),
    event('content_block_start', { index: thinking ? 1 : 0, content_block: { type: 'text', text: 'TEXT_' } }),
    event('content_block_delta', { index: thinking ? 1 : 0, delta: { type: 'text_delta', text: 'TAIL' } }),
    ...(truncated ? [] : [event('content_block_stop', { index: thinking ? 1 : 0 }), event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }), event('message_stop', {})]),
  ];
  if (path === '/v1/responses') return [
    ...(thinking ? [event('response.reasoning_summary_text.delta', { delta: 'THINK_' }),
    event('response.reasoning_summary_text.delta', { delta: 'TAIL' })] : []),
    event('response.output_text.delta', { delta: 'TEXT_' }),
    event('response.output_text.delta', { delta: 'TAIL' }),
    ...(truncated ? [] : [event('response.completed', { response: { usage: { input_tokens: 1, output_tokens: 2 } } })]),
  ];
  if (path !== '/v1/chat/completions') throw new Error('unexpected fixture protocol');
  const delta = value => data({ choices: [{ index: 0, delta: value }] });
  return [...(thinking ? [delta({ role: 'assistant', reasoning_content: 'THINK_' }), delta({ reasoning_content: 'TAIL' })] : []),
    delta({ content: 'TEXT_' }), delta({ content: 'TAIL' }),
    ...(truncated ? [] : [data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']),
  ];
}
