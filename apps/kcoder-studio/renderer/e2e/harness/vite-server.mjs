import { createServer as createHttpServer } from 'node:http'
import { cp, mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createServer as createViteServer } from 'vite'

const publicDir = process.env.KCODER_STUDIO_E2E_VITE_PUBLIC_DIR
if (!publicDir || !isAbsolute(publicDir)) {
  throw new Error('KCODER_STUDIO_E2E_VITE_PUBLIC_DIR must be an absolute run-owned path')
}
await mkdir(publicDir, { recursive: true, mode: 0o700 })
await cp(new URL('../../public', import.meta.url), publicDir, { recursive: true })
const vite = await createViteServer({
  configFile: new URL('../../vite.config.ts', import.meta.url).pathname,
  mode: 'e2e',
  appType: 'spa',
  publicDir,
  server: { middlewareMode: true },
})

const server = createHttpServer(vite.middlewares)
await new Promise((resolveListen, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolveListen)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Vite E2E address unavailable')
console.log(
  JSON.stringify({ event: 'READY', service: 'vite', host: '127.0.0.1', port: address.port })
)

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await new Promise(resolveClose => server.close(resolveClose))
  await vite.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
