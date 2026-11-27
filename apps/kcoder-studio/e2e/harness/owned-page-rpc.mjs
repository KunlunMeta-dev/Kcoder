// Use the owned Electron page's actual partition cookies. CDP's default browser
// context cookie jar may differ from Electron's persist partition.
export async function requestOwnedPageRpc(page, { workspace, requests }) {
  return page.evaluate(async ({ workspace, requests }) => {
    const token = document.querySelector('meta[name="kcoder-rpc-token"]')?.content
    if (!token || !location.href.startsWith('http://127.0.0.1:')) throw new Error('Owned Gateway page required')
    const url = new URL(`ws://${location.host}/rpc`)
    url.searchParams.set('token', token); url.searchParams.set('server', 'local'); url.searchParams.set('workspace', workspace)
    const socket = new WebSocket(url)
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Owned page RPC connect timeout')), 10000)
        socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Owned page RPC connect failed')) }, { once: true })
      })
      let next = 0
      const request = (method, params) => new Promise((resolve, reject) => {
        const id = ++next
        const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Owned page RPC reply timeout')) }, 15000)
        const receive = event => {
          const frame = JSON.parse(event.data)
          if (frame.id !== id) return
          clearTimeout(timer); socket.removeEventListener('message', receive); resolve(frame)
        }
        socket.addEventListener('message', receive)
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
      const init = await request('initialize', { protocolVersion: '2026-07-27', clientInfo: { name: 'p11-owned-page-probe', version: '1' }, capabilities: { experimental: { computerUseRecoveryV1: true, computerUseSessionAuthorizationV1: true } } })
      if (init.error) throw new Error('Owned page RPC initialize refused')
      const results = []
      for (const operation of requests) {
        if (!['plugin/install', 'computerUse/recover', 'computerUse/revoke'].includes(operation.method)) throw new Error('Unexpected owned page RPC operation')
        results.push(await request(operation.method, operation.params))
      }
      return results
    } finally { socket.close() }
  }, { workspace, requests })
}
