import {
  type WikiFileCapability,
  wikiFileIssue,
  WIKI_BATCH_MAX_BYTES,
  WIKI_BATCH_MAX_FILES,
} from './wikiFileCapabilities'
import { runWikiBatch, type BatchEntry } from './wikiBatch'
import { useEffect, useRef, useState } from 'react'
import { DeviceFolderPicker } from '@/components/projects/DeviceFolderPicker'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiSource } from '@/kcoder/knowledgeApi'
import { WikiError } from './WikiError'

type Staged = Awaited<ReturnType<typeof knowledgeApi.stageDirectory>>['items']
type Candidates = Awaited<ReturnType<typeof knowledgeApi.previewDirectory>>['items']
export function WikiDirectoryImport({
  serverId,
  libraryId,
  isCurrent,
  onChanged,
  onClose,
}: {
  serverId: string
  libraryId: string
  isCurrent: () => boolean
  onChanged: () => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation('knowledge')
  const workbench = useWorkbench()
  const device = workbench.state.devices.find(item => item.device_id === serverId)
  const [files, setFiles] = useState<Candidates | null>(null)
  const staged = useRef<Staged>([])
  const [directory, setDirectory] = useState('')
  const [capabilities, setCapabilities] = useState<WikiFileCapability[] | undefined>()
  const alive = useRef(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<BatchEntry<Staged[number], WikiSource>[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    const lifetime = alive
    const owned = staged
    lifetime.current = true
    return () => {
      lifetime.current = false
      if (isCurrent())
        void Promise.allSettled(
          owned.current.map(file => knowledgeApi.discardStaged(serverId, file.attachmentPath))
        )
    }
  }, [isCurrent, serverId])
  const preview = async (directory: string) => {
    setBusy(true)
    setError('')
    try {
      const description = await knowledgeApi.fileCapabilities(serverId)
      if (!alive.current || !isCurrent()) return
      const targetCapabilities = description.supported === false ? undefined : description.items
      setCapabilities(targetCapabilities)
      const result = await knowledgeApi.previewDirectory(serverId, directory)
      if (!alive.current || !isCurrent()) return
      setDirectory(directory)
      if (alive.current && isCurrent()) {
        setFiles(result.items)
        setSelected(
          new Set(
            result.items
              .filter(
                file =>
                  file.available &&
                  !wikiFileIssue({ name: file.title, size: file.size }, targetCapabilities)
              )
              .slice(0, WIKI_BATCH_MAX_FILES)
              .map(file => file.title)
          )
        )
      }
    } catch (cause) {
      if (alive.current && isCurrent())
        setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (alive.current && isCurrent()) setBusy(false)
    }
  }
  const importFiles = async () => {
    setBusy(true)
    setError('')
    try {
      const snapshots = await knowledgeApi.stageDirectory(serverId, directory, [...selected])
      if (!alive.current || !isCurrent()) {
        if (isCurrent())
          await Promise.allSettled(
            snapshots.items.map(file => knowledgeApi.discardStaged(serverId, file.attachmentPath))
          )
        return
      }
      const previous = staged.current
      staged.current = snapshots.items
      await Promise.allSettled(
        previous.map(file => knowledgeApi.discardStaged(serverId, file.attachmentPath))
      )
      if (!alive.current || !isCurrent()) return
      const entries = snapshots.items.map(
        item =>
          batch.find(
            entry =>
              entry.item.title === item.title && entry.item.idempotencyKey === item.idempotencyKey
          ) ?? {
            item,
            status: 'pending' as const,
          }
      )
      const result = await runWikiBatch(entries, {
        current: () => alive.current && isCurrent(),
        upload: item => knowledgeApi.importStaged(serverId, libraryId, item),
        organize: source => knowledgeApi.startJob(serverId, libraryId, source, i18n.language),
        changed: entries => {
          setBatch(entries)
          onChanged()
        },
      })
      if (alive.current && isCurrent()) {
        onChanged()
        if (result.every(entry => entry.status === 'queued')) onClose()
      }
    } catch (cause) {
      if (alive.current && isCurrent())
        setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      if (alive.current && isCurrent()) setBusy(false)
    }
  }
  return (
    <ModalDialog
      title={t('importDirectory')}
      testId="wiki-directory-import"
      wide
      pending={busy}
      onClose={onClose}
    >
      <p className="my-3 text-sm text-text-secondary">{t('directoryHint')}</p>
      {error && <WikiError error={error} />}
      {batch.length > 0 && (
        <p role="status" className="text-xs text-text-muted">
          {t('batchProgress', {
            done: batch.filter(entry => entry.status === 'queued').length,
            total: batch.length,
          })}
        </p>
      )}
      {batch
        .filter(entry => entry.error)
        .map(entry => (
          <WikiError
            key={entry.item.attachmentPath}
            error={`${entry.item.title}: ${entry.error}`}
          />
        ))}
      {!files && device && (
        <DeviceFolderPicker
          device={device}
          mode="select"
          variant="remoteDark"
          disabled={busy}
          confirmLabel={t('previewDirectory')}
          onGetDeviceHomeDirectory={workbench.getDeviceHomeDirectory}
          onListDeviceDirectories={workbench.listDeviceDirectories}
          onCreateDeviceDirectory={workbench.createDeviceDirectory}
          onConfirm={({ path }) => preview(path)}
          onCancel={onClose}
        />
      )}
      {files && (
        <>
          <div className="max-h-[45vh] space-y-1 overflow-y-auto">
            {files.map(file => (
              <label
                key={file.title}
                className="flex min-h-12 items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface"
              >
                <Checkbox
                  checked={selected.has(file.title)}
                  disabled={
                    busy ||
                    !file.available ||
                    !!wikiFileIssue({ name: file.title, size: file.size }, capabilities) ||
                    (!selected.has(file.title) && selected.size >= WIKI_BATCH_MAX_FILES)
                  }
                  onChange={event => {
                    const checked = event.target.checked
                    setSelected(current => {
                      const next = new Set(current)
                      if (checked) next.add(file.title)
                      else next.delete(file.title)
                      return next
                    })
                  }}
                />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate">{file.title}</span>
                  {wikiFileIssue({ name: file.title, size: file.size }, capabilities) && (
                    <span className="mt-1 block text-xs text-text-muted">
                      {t(wikiFileIssue({ name: file.title, size: file.size }, capabilities)!)}
                    </span>
                  )}
                </span>
                <span className="text-xs tabular-nums text-text-muted">
                  {file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KiB`}
                </span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={
                busy ||
                !selected.size ||
                (files ?? [])
                  .filter(file => selected.has(file.title))
                  .reduce((sum, file) => sum + file.size, 0) > WIKI_BATCH_MAX_BYTES
              }
              data-testid="wiki-directory-confirm"
              onClick={() => void importFiles()}
            >
              {t('importSelected', { count: selected.size })}
            </Button>
          </div>
        </>
      )}
    </ModalDialog>
  )
}
