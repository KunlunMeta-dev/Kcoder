import type { FileViewerProps } from '@file-viewer/react'

type ViewerOptions = NonNullable<FileViewerProps['options']>
type RendererPlugin = Extract<NonNullable<ViewerOptions['renderers']>, { definitions?: unknown }>
type Renderer = NonNullable<RendererPlugin['definitions']>[number]
type RendererLoader = NonNullable<Renderer['load']>
type RendererSession = Awaited<ReturnType<RendererLoader>>

function protectSession(session: RendererSession): RendererSession {
  if (!session.destroy) return session
  const destroy = session.destroy.bind(session)
  let disposal: Promise<void> | undefined
  return {
    ...session,
    getAvailability: session.getAvailability?.bind(session),
    destroy() {
      // The core can encounter the same session through replacement, stale
      // completion and unmount. Do not repeat a partially successful disposal.
      return (disposal ??= Promise.resolve()
        .then(destroy)
        .catch(() => {
          // Exceptions can contain document data or URLs. Keep diagnostics
          // static while allowing the core to clear its source and observers.
          console.warn('Workspace document renderer cleanup failed')
        }))
    },
  }
}

/** Guard sessions before installation, using an instance-owned registry. */
export function workspaceViewerOptions(options: FileViewerProps['options']): ViewerOptions {
  return {
    ...options,
    rendererMode: 'replace',
    // Preserve the original extend-mode auto presets. Explicit replace-mode
    // callers retain their original default (false) or configured setting.
    autoRenderers: options?.autoRenderers ?? options?.rendererMode !== 'replace',
    renderers: [
      options?.renderers ?? [],
      {
        id: 'kcoder-workspace-session-disposal',
        install({ registry }) {
          // replace creates a private registry; register clones each definition.
          // Never mutate a preset, shared definition or opaque/frozen session.
          for (const renderer of registry.list()) {
            const load = renderer.load
            if (!load) continue
            registry.register({
              ...renderer,
              async load(context) {
                return protectSession(await load.call(renderer, context))
              },
            })
          }
        },
      },
    ],
  }
}
