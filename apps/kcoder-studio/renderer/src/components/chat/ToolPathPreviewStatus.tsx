import { useEffect, useSyncExternalStore } from 'react'
import { toolPathPreviews } from '@/kcoder/toolPathPreview'

export function ToolPathPreviewStatus({ target, task }: { target?: string; task?: string }) {
  useSyncExternalStore(
    toolPathPreviews.subscribe,
    toolPathPreviews.snapshot,
    toolPathPreviews.snapshot
  )
  useEffect(() => {
    if (target && task) return toolPathPreviews.acquire(target, task)
  }, [target, task])
  const previews = toolPathPreviews.read(target, task)
  if (previews.length === 0) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="tool-path-preview"
      className="px-6 py-2 text-sm text-text-muted"
    >
      {previews.slice(0, 3).map((preview, index) => (
        <div key={`${preview.id}:${index}`} className="truncate">
          准备修改 <bdi title={preview.path}>{preview.path}</bdi>
        </div>
      ))}
      {previews.length > 3 ? <div>另有 {previews.length - 3} 项</div> : null}
    </div>
  )
}
