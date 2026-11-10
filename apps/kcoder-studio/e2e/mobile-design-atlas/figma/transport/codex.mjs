import { createInterface } from 'node:readline';

/** Deterministic RPC transport; never starts a model turn or reads credential files. */
export class FigmaSyncRpc {
  constructor(child, { timeoutMs = 180000 } = {}) {
    this.child = child; this.timeoutMs = timeoutMs; this.sequence = 0; this.pending = new Map(); this.closed = false;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && message.method) {
        // Authentication/elicitation requires explicit user handling, not automatic approval.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Interactive requests are not supported by the sync runner' } }) + '\n');
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(`RPC ${pending.method}: ${message.error.message}`)) : pending.resolve(message.result);
    });
    const fail = () => this.rejectPending();
    child.on('exit', fail); child.on('error', fail);
    child.stdin.on('error', fail);
  }
  rejectPending() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`RPC connection closed during ${p.method}`)); }
    this.pending.clear();
  }
  request(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (this.closed || this.child.exitCode != null || this.child.signalCode != null) return Promise.reject(new Error(`RPC connection closed before ${method}`));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout during ${method}; do not blindly replay a write`)); }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  notify(method, params) { this.child.stdin.write(JSON.stringify({ method, ...(params ? { params } : {}) }) + '\n'); }
  close() { this.rejectPending(); this.lines.close(); if (!this.child.stdin.destroyed) this.child.stdin.end(); }
}

export async function connectFigmaSync(run, { command = process.env.KCODER_FIGMA_CODEX_BIN || 'codex', server } = {}) {
  const args = ['app-server', '--stdio'];
  // This is an authorized live MCP client, not an app test with a synthetic HOME.
  // Codex owns OAuth. Only this run's RPC process/context is cleaned up.
  const child = run.spawnOwned('figma-mcp-proxy', command, args, { stdin: 'pipe', env: { ...process.env } });
  const rpc = new FigmaSyncRpc(child);
  run.addCleanup('close sync RPC', async () => rpc.close());
  await rpc.request('initialize', { clientInfo: { name: 'kcoder_figma_sync', version: '1.0.0' }, capabilities: { experimentalApi: true, explicitGatewayOauth: true } });
  rpc.notify('initialized');
  const started = await rpc.request('thread/start', { cwd: run.stateDir, ephemeral: true });
  const threadId = started.thread?.id;
  if (!threadId) throw new Error('Codex did not return an ephemeral MCP context');
  run.addCleanup('release owned ephemeral MCP context', async () => {
    // Abort may already have stopped the owned app-server; do not wait for a
    // response from a dead process or outlive RunContext's cleanup deadline.
    try { if (!rpc.closed) await rpc.request('thread/unsubscribe', { threadId }, { timeoutMs: 4000 }); } finally { rpc.close(); }
  });
  const inventory = await rpc.request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', ...(server ? { serverName: server } : {}) });
  const candidates = inventory.data?.filter(s => /figma/i.test(s.name) && Object.values(s.tools || {}).some(t => t.name === 'use_figma')) || [];
  if (candidates.length !== 1) throw new Error(`Expected one authenticated Figma MCP server; found ${candidates.length}. Set KCODER_FIGMA_MCP_SERVER explicitly.`);
  const selected = candidates[0];
  return {
    server: selected.name,
    call: (tool, args) => rpc.request('mcpServer/tool/call', { threadId, server: selected.name, tool, arguments: args }),
  };
}
