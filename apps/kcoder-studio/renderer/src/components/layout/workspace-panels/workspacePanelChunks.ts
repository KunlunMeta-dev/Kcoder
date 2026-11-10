import { lazy } from 'react'

// Terminal (xterm), file tree, editor (CodeMirror) and diff review are about
// 1.4 MB of the startup bundle but are not needed for the first screen. They
// load on demand. Packaged builds prefetch their small chunks once idle; Vite
// must not eagerly expand the entire editor/viewer dependency graph over Relay.
const loaders = {
  terminal: () => import('./EmbeddedLocalTerminal'),
  remoteTerminal: () => import('./RemoteTerminal'),
  sshTerminal: () => import('@/kcoder/SshTerminalPane'),
  files: () => import('./FileWorkspacePanel'),
  changes: () => import('@/components/chat/FileChangesReviewPanel'),
}

export const LazyEmbeddedLocalTerminal = lazy(() =>
  loaders.terminal().then(module => ({ default: module.EmbeddedLocalTerminal }))
)
export const LazyRemoteTerminal = lazy(() =>
  loaders.remoteTerminal().then(module => ({ default: module.RemoteTerminal }))
)
export const LazySshTerminalPane = lazy(() =>
  loaders.sshTerminal().then(module => ({ default: module.SshTerminalPane }))
)
export const LazyFileWorkspacePanel = lazy(() =>
  loaders.files().then(module => ({ default: module.FileWorkspacePanel }))
)
export const LazyFileChangesReviewPanel = lazy(() =>
  loaders.changes().then(module => ({ default: module.FileChangesReviewPanel }))
)

let prefetched = false

/** Prefetch bundled panel chunks without flooding Vite's unbundled transport. */
export function prefetchWorkspacePanelChunks(): () => void {
  if (!import.meta.env.PROD || prefetched || typeof window === 'undefined') return () => {}
  const run = () => {
    prefetched = true
    for (const load of Object.values(loaders)) void load().catch(() => undefined)
  }
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 5_000 })
    return () => window.cancelIdleCallback(handle)
  }
  const timer = window.setTimeout(run, 2_000)
  return () => window.clearTimeout(timer)
}
