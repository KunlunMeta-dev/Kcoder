import { lazy } from 'react'

// Terminal, editor, file tree and review code loads only when its panel is rendered.
export const LazyEmbeddedLocalTerminal = lazy(() =>
  import('./EmbeddedLocalTerminal').then(module => ({ default: module.EmbeddedLocalTerminal }))
)
export const LazyRemoteTerminal = lazy(() =>
  import('./RemoteTerminal').then(module => ({ default: module.RemoteTerminal }))
)
export const LazySshTerminalPane = lazy(() =>
  import('@/kcoder/SshTerminalPane').then(module => ({ default: module.SshTerminalPane }))
)
export const LazyFileWorkspacePanel = lazy(() =>
  import('./FileWorkspacePanel').then(module => ({ default: module.FileWorkspacePanel }))
)
export const LazyFileChangesReviewPanel = lazy(() =>
  import('@/components/chat/FileChangesReviewPanel').then(module => ({ default: module.FileChangesReviewPanel }))
)
