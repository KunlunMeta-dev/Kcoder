import type { Plugin } from 'vite'

export function mountedLazyImports(): Plugin {
  let base = '/'
  return {
    name: 'kcoder-mounted-lazy-imports',
    apply: 'serve',
    configResolved(config) { base = config.base },
    renderChunk(code, chunk) {
      if (base === '/' || !chunk.moduleIds.some(id => id.includes('?rolldown-lazy='))) return
      // Vite's generated lazy stubs omit base; keep compilation behind the same Gateway mount.
      const mounted = code.replace(/([`"'])\/@vite\/lazy\?/g, `$1${base}@vite/lazy?`)
      return mounted === code ? null : { code: mounted, map: null }
    },
  }
}
