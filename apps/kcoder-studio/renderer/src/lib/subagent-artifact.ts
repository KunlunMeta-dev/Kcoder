/**
 * Sub-agent reports are published by the app-server as
 * `<project data dir>/<session>/subagents/<agentId>/output.md|transcript.json`.
 *
 * Clicking such a link must open the read-only report drawer instead of treating
 * the path as a workspace file: the report lives inside the client storage tree,
 * which is not a workspace root a gateway app-server connection can be opened on.
 */
export function subagentArtifactKindFromPath(path: string): 'output' | 'transcript' | null {
  const normalized = path.replace(/\\/g, '/').trim()
  if (!normalized.includes('/subagents/')) return null
  if (normalized.endsWith('/output.md')) return 'output'
  if (normalized.endsWith('/transcript.json')) return 'transcript'
  return null
}
