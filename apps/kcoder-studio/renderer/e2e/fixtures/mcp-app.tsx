import { createRoot } from 'react-dom/client'
import { useMemo, useState } from 'react'
import i18n from '../../src/i18n'
import '../../src/styles/globals.css'
import {
  WidgetDocumentHost,
  type InlineWidgetHostProps,
} from '../../src/features/widgets/InlineWidgetHost'
import { isolatedHtmlWidgetRenderer } from '../../src/features/widgets'
import { widgetContentSha256 } from '../../src/features/widgets/contentHash'
import { createMcpAppApi } from '../../src/kcoder/mcpAppApi'
import { McpAppWidget } from '../../src/components/chat/widgets/McpAppWidget'
import {
  ConversationWidgetsContext,
  type ConversationWidgetsValue,
} from '../../src/components/chat/widgets/widgetContext'
import type { WidgetRequest } from '../../src/kcoder/widgetApi'
import type { WidgetRef } from '../../../shared/generated/contracts'

// This fixture proves postMessage conformance. Only ?native=1 uses production native leases.
await i18n.changeLanguage('zh-CN')
const native = new URLSearchParams(location.search).get('native') === '1'
const history = new URLSearchParams(location.search).get('history') === '1'
const source = String.raw`<!doctype html><html><body><h2>MCP App</h2>
<div id="capabilities">initializing</div><div id="input"></div><div id="result"></div>
<button id="refresh">Refresh original App tool</button><button id="resource">Read original resource</button>
<button id="draft">Ask in conversation</button><button id="foreign">Try foreign tool</button>
<output id="action"></output><output id="data"></output><output id="draft-result"></output><output id="foreign-result"></output>
<script>
let nextId = 1;
const pending = new Map();
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, {resolve, reject});
  window.parent.postMessage({jsonrpc:'2.0',id,method,params}, '*');
});
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
  const message = event.data;
  if (pending.has(message.id)) {
    const task = pending.get(message.id); pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  }
  if (message.method === 'ui/notifications/tool-input') document.getElementById('input').textContent = 'input:' + JSON.stringify(message.params.arguments);
  if (message.method === 'ui/notifications/tool-result') document.getElementById('result').textContent = 'result:' + JSON.stringify(message.params);
});
request('ui/initialize', {protocolVersion:'2026-01-26',appInfo:{name:'offline-conformance-app',version:'1'},appCapabilities:{availableDisplayModes:['inline']}}).then(result => {
  document.getElementById('capabilities').textContent = JSON.stringify(result.hostCapabilities);
  window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'}, '*');
});
document.getElementById('refresh').onclick = async () => {
  try { document.getElementById('action').textContent = JSON.stringify(await request('tools/call',{name:'refresh',arguments:{value:8}})); }
  catch(error) { document.getElementById('action').textContent = error.message; }
};
document.getElementById('resource').onclick = async () => {
  try { document.getElementById('data').textContent = JSON.stringify(await request('resources/read',{uri:'app://data'})); }
  catch(error) { document.getElementById('data').textContent = error.message; }
};
document.getElementById('draft').onclick = async () => {
  try { await request('ui/message',{role:'user',content:{type:'text',text:'请解释这组数据'}}); document.getElementById('draft-result').textContent = 'drafted'; }
  catch(error) { document.getElementById('draft-result').textContent = error.message; }
};
document.getElementById('foreign').onclick = async () => {
  try { await request('tools/call',{name:'other-server-tool',arguments:{}}); document.getElementById('foreign-result').textContent = 'unexpected'; }
  catch(error) { document.getElementById('foreign-result').textContent = error.message; }
};
</script></body></html>`
const bytes = new TextEncoder().encode(source)
const widget: WidgetRef = {
  widgetId: 'mcp-app',
  threadId: 'fixture-thread',
  turnId: 'fixture-turn',
  attemptId: 'fixture-attempt',
  toolCallId: 'fixture-tool',
  revision: 1,
  title: 'Original server App',
  summary: 'Original retained UI data',
  format: 'html',
  executionMode: 'isolated_html',
  libraries: [],
  bytes: bytes.length,
  sha256: await widgetContentSha256(bytes),
  createdAtMs: 1,
  mcpApp: {
    connectionId: 'original-fixture-connection',
    serverName: 'fixture-server',
    toolName: 'overview',
    resourceUri: 'ui://overview',
    mimeType: 'text/html;profile=mcp-app',
    pluginId: null,
  },
}
const address = { deviceId: 'fixture-target', taskId: 'fixture-task', threadId: widget.threadId }
const resource = {
  contents: [{ uri: 'app://data', mimeType: 'text/plain', text: 'original resource' }],
}
const resourceBytes = new TextEncoder().encode(JSON.stringify(resource))
const resourceHash = await widgetContentSha256(resourceBytes)
function protocolOnlyHost(props: InlineWidgetHostProps) {
  return (
    <WidgetDocumentHost
      {...props}
      sandboxDocumentUrl="/widget-sandbox/isolated-v1.html"
      documentMode="isolated_html"
      authorizeFrame={async () => ({
        release: () => {},
        heartbeat: () => {},
        onRevoked: () => () => {},
      })}
    />
  )
}
export function Fixture() {
  const [draft, setDraft] = useState('保留已有草稿')
  const [actions, setActions] = useState(0)
  const [resourceReads, setResourceReads] = useState(0)
  const api = useMemo(() => {
    const ledger = new Map<string, unknown>()
    const request: WidgetRequest = async <T,>(method: string, params: Record<string, unknown>) => {
      if (
        params.threadId !== widget.threadId ||
        params.connectionId !== widget.mcpApp!.connectionId ||
        params.widgetId !== widget.widgetId ||
        params.revision !== widget.revision
      )
        throw new Error('foreign fixture binding')
      if (method === 'mcp/apps/read')
        return {
          widget,
          live: !history,
          allowedTools: history ? [] : ['refresh'],
          resourcesEnabled: !history,
          protocolVersion: '2026-01-26',
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
          requestedPermissions: {
            camera: false,
            microphone: false,
            geolocation: false,
            clipboardWrite: false,
          },
          toolInput: { value: 7 },
          toolContent: [{ type: 'text', text: 'visible original result' }],
          structuredContent: { series: [1, 2], uiOnly: 8 },
          resultMeta: { original: true },
        } as T
      if (history) throw new Error('history fixture has no live authority')
      if (method === 'mcp/apps/toolCall') {
        if (params.name !== 'refresh') throw new Error('foreign tool')
        if (!ledger.has(String(params.operationId))) {
          setActions(value => value + 1)
          ledger.set(String(params.operationId), {
            operationId: params.operationId,
            status: 'completed',
            result: { content: [{ type: 'text', text: 'refresh:8' }] },
          })
        }
        return ledger.get(String(params.operationId)) as T
      }
      if (method === 'mcp/apps/operationRead') return ledger.get(String(params.operationId)) as T
      if (method === 'mcp/apps/resourceRead') {
        setResourceReads(value => value + 1)
        return {
          resource: {
            resourceId: 'resource',
            sha256: resourceHash,
            bytes: resourceBytes.length,
            uri: params.uri,
            contentCount: 1,
            encoding: 'json',
            mimeType: null,
          },
        } as T
      }
      if (method === 'mcp/apps/resourceContentRead')
        return {
          resourceId: 'resource',
          sha256: resourceHash,
          bytes: resourceBytes.length,
          offset: 0,
          nextOffset: resourceBytes.length,
          dataBase64: btoa(String.fromCharCode(...resourceBytes)),
        } as T
      throw new Error('unsupported fixture RPC')
    }
    return createMcpAppApi(address, widget.threadId, request)
  }, [])
  const value = useMemo(
    () =>
      ({
        mcpApps: api,
        isCurrent: () => true,
        invalidated: false,
        sendPrompt: (text: string) => setDraft(previous => `${previous}\n\n${text}`),
      }) as unknown as ConversationWidgetsValue,
    [api]
  )
  return (
    <div className="mx-auto max-w-3xl p-6 text-base">
      <p data-testid="mcp-proof-kind">
        {native
          ? 'Production native lease is required'
          : 'JSON-RPC conformance only; native authorization is tested separately'}
      </p>
      <ConversationWidgetsContext.Provider value={value}>
        <McpAppWidget
          widget={widget}
          panelId="mcp-app-fixture"
          sandboxDocumentUrl="/widget-sandbox/isolated-v1.html"
          loadContent={async () => source}
          isolatedHtmlHost={native ? isolatedHtmlWidgetRenderer : protocolOnlyHost}
        />
      </ConversationWidgetsContext.Provider>
      <textarea
        aria-label="所属会话草稿"
        value={draft}
        onChange={event => setDraft(event.target.value)}
      />
      <output data-testid="mcp-actions">{actions}</output>
      <output data-testid="mcp-resource-reads">{resourceReads}</output>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
