import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ConfigEnv, Plugin } from 'vite'

/** Restore local appearance independently from the workbench's module downloads. */
export function bootLoading(startupId: string, base: string, command: ConfigEnv['command']): Plugin {
  return {
    name: 'kcoder-boot-loading',
    buildStart() {
      if (command === 'build') this.emitFile({ type: 'chunk', id: startupId, name: 'startup' })
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!html.includes('id="kcoder-boot-loading"')) return
        if (!html.includes('<!-- kcoder-startup -->')) throw new Error('Missing independent startup placeholder')
        const startup = Object.values(context.bundle ?? {}).find(chunk =>
          chunk.type === 'chunk' && chunk.facadeModuleId === startupId)
        if (command === 'build' && !startup) throw new Error('Missing independent startup chunk')
        return {
          html: html.replace('<!-- kcoder-startup -->', ''),
          tags: [
            { tag: 'style', attrs: { id: 'kcoder-boot-loading-style' },
              children: readFileSync(resolve(dirname(startupId), 'styles/page-loading.css'), 'utf8'), injectTo: 'head' },
            { tag: 'script', attrs: { type: 'module', async: true, crossorigin: true,
              src: `${base}${startup ? startup.fileName : 'src/startup.ts'}` }, injectTo: 'head' },
          ],
        }
      },
    },
  }
}
