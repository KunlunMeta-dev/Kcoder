import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createWidgetDrawingReadiness } from './chart-readiness.js'

const source = path.dirname(fileURLToPath(import.meta.url))
const resources = path.join(source, 'resources')
const renderer = path.resolve(source, '../../..')
const output = path.join(renderer, 'public/widget-sandbox')
const checking = process.argv.includes('--check')
const digest = value => createHash('sha256').update(value).digest('hex')
const scriptHash = value => `'sha256-${createHash('sha256').update(value).digest('base64')}'`
const manifest = JSON.parse(await readFile(path.join(resources, 'manifest.json'), 'utf8'))
for (const asset of manifest) {
  const vendored = await readFile(path.join(resources, asset.file))
  const installed = await readFile(path.join(renderer, 'node_modules', asset.package, asset.source))
  const installedPackage = JSON.parse(await readFile(path.join(renderer, 'node_modules', asset.package, 'package.json'), 'utf8'))
  if (installedPackage.version !== asset.version) throw new Error(`Widget dependency version mismatch: ${asset.package}`)
  if (digest(vendored) !== asset.sha256 || vendored.length !== asset.bytes || !vendored.equals(installed)) throw new Error(`Widget resource identity mismatch: ${asset.id}`)
  const licenseContent = await readFile(path.join(resources, asset.license))
  if (digest(licenseContent) !== asset.licenseSha256 || !licenseContent.equals(await readFile(path.join(renderer, 'node_modules', asset.package, asset.licenseSource)))) throw new Error(`Widget resource license identity mismatch: ${asset.id}`)
  for (const license of asset.bundledLicenses || []) {
    const content = await readFile(path.join(resources, license.file))
    const dependencyRoot = path.join(path.dirname(await realpath(path.join(renderer, 'node_modules', asset.package))), license.package)
    if (JSON.parse(await readFile(path.join(dependencyRoot, 'package.json'), 'utf8')).version !== license.version) throw new Error(`Bundled dependency version mismatch: ${license.package}`)
    if (digest(content) !== license.sha256 || !content.equals(await readFile(path.join(dependencyRoot, license.packageFile)))) throw new Error(`Bundled license identity mismatch: ${license.package}`)
  }
}
if (!(await readFile(path.join(resources, 'noble_hashes.LICENSE'))).equals(await readFile(path.join(renderer, 'node_modules/@noble/hashes/LICENSE')))) throw new Error('noble-hashes license identity mismatch')
if (JSON.parse(await readFile(path.join(renderer, 'node_modules/@noble/hashes/package.json'), 'utf8')).version !== '2.0.1') throw new Error('noble-hashes dependency version mismatch')
const runtime = `(() => { ${createWidgetDrawingReadiness.toString()};\n${await readFile(path.join(source, 'sandbox-runtime.js'), 'utf8')}\n})()`
const isolatedRuntime = `(() => { ${createWidgetDrawingReadiness.toString()};\n${await readFile(path.join(source, 'isolated-runtime.js'), 'utf8')}\n})()`
const styles = await readFile(path.join(source, 'sandbox.css'), 'utf8')
const scripts = await Promise.all(manifest.filter(asset => asset.file.endsWith('.js')).map(asset => readFile(path.join(resources, asset.file))))
const csp = `default-src 'none'; script-src ${[runtime, ...scripts].map(scriptHash).join(' ')}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>KCoder widget sandbox</title><style>${styles}</style></head><body><main id="widget-root"></main><script>${runtime}</script></body></html>\n`
const isolatedCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
const isolatedHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${isolatedCsp}"><title>KCoder isolated widget</title><style>${styles}</style></head><body><main id="widget-root"></main><script>${isolatedRuntime}</script></body></html>\n`
const generated = {
  'host-v1.html': html, 'policy-v1.json': JSON.stringify({ version: 1, csp, documentSha256: digest(html), runtimeSha256: digest(runtime), libraries: manifest }, null, 2) + '\n',
  'isolated-v1.html': isolatedHtml, 'isolated-policy-v1.json': JSON.stringify({ version: 1, csp: isolatedCsp, documentSha256: digest(isolatedHtml), runtimeSha256: digest(isolatedRuntime), requiresNativeProcessAuthorization: true }, null, 2) + '\n',
}
await mkdir(output, { recursive: true })
for (const [name, content] of Object.entries(generated)) {
  const file = path.join(output, name)
  if (checking) {
    if (await readFile(file, 'utf8') !== content) throw new Error(`Generated widget resource is stale: ${name}`)
  } else await writeFile(file, content)
}
console.log(JSON.stringify({ checked: checking, documentSha256: digest(html), resources: manifest.length }))
