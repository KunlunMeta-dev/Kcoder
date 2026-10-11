import { downloadLink } from '@/kcoder/downloadLink'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ModalDialog } from '@/components/ui/modal-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgeApi, type WikiLibrary } from '@/kcoder/knowledgeApi'
import { WikiError } from './WikiError'
import {
  archiveCapability,
  beginArchiveExport,
  cancelArchive,
  importArchiveCollection,
  readArchiveSegment,
  type ArchiveRequest,
  type ArchiveStatus,
} from './wikiArchiveTransport'

type Folder = {
  getDirectoryHandle: (name: string, options: { create: true }) => Promise<Folder>
  getFileHandle: (
    name: string,
    options: { create: true }
  ) => Promise<{
    createWritable: () => Promise<{
      write: (bytes: Uint8Array<ArrayBuffer> | string) => Promise<void>
      close: () => Promise<void>
      abort: () => Promise<void>
    }>
  }>
}
function picker() {
  return (
    window as unknown as {
      showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<Folder>
    }
  ).showDirectoryPicker
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  downloadLink(link)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function WikiArchiveTransfer({
  serverId,
  libraryId,
  mode,
  isCurrent,
  onClose,
  onImported,
}: {
  serverId: string
  libraryId?: string
  mode: 'export' | 'import'
  isCurrent: () => boolean
  onClose: () => void
  onImported: (library: WikiLibrary) => void
}) {
  const { t } = useTranslation('knowledge')
  const [supported, setSupported] = useState<boolean | null>(null)
  const [status, setStatus] = useState<ArchiveStatus | null>(null)
  const [partBytes, setPartBytes] = useState(0)
  const [requested, setRequested] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [importedName, setImportedName] = useState('')
  const [error, setError] = useState('')
  const alive = useRef(true)
  const transfer = useRef<string | null>(null)
  const request: ArchiveRequest = useCallback(
    (method, params) => knowledgeApi.archiveTransfer(serverId, method, params),
    [serverId]
  )
  const current = useCallback(() => alive.current && isCurrent(), [isCurrent])
  const progress = (next: ArchiveStatus) => {
    transfer.current = next.transferId
    if (current()) setStatus(next)
  }
  useEffect(() => {
    const lifetime = alive
    lifetime.current = true
    void archiveCapability(request)
      .then(value => {
        if (current()) setSupported(value.supported)
      })
      .catch(cause => {
        if (current()) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      lifetime.current = false
      if (transfer.current && isCurrent())
        void cancelArchive(request, transfer.current).catch(() => {})
    }
  }, [request, current, isCurrent])
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current()) setBusy(false)
    }
  }
  const exportCollection = async (folder?: Folder) => {
    const ready = await beginArchiveExport(request, libraryId!, current, progress)
    if (!current() || !ready.manifest) return
    if (!folder) return // User requests each download separately; browsers may block bulk downloads.
    // Never overwrite an earlier backup in the directory selected by the user.
    folder = await folder.getDirectoryHandle(`wiki-${ready.manifest.collectionId}`, {
      create: true,
    })
    for (const segment of ready.manifest.segments) {
      if (!current()) throw new Error(t('archiveCancelled'))
      const stream = await (
        await folder.getFileHandle(segment.name, { create: true })
      ).createWritable()
      try {
        await readArchiveSegment(
          request,
          ready,
          segment.index,
          current,
          bytes => stream.write(bytes),
          setPartBytes
        )
        if (!current()) throw new Error(t('archiveCancelled'))
        await stream.close()
      } catch (cause) {
        await stream.abort().catch(() => {})
        throw cause
      }
      if (current()) setRequested(previous => new Set([...previous, segment.index]))
    }
    // The collection manifest is published to the chosen directory only after all parts close.
    if (!current()) throw new Error(t('archiveCancelled'))
    const output = await (
      await folder.getFileHandle('collection.kwiki.json', { create: true })
    ).createWritable()
    try {
      await output.write(JSON.stringify(ready.manifest))
      await output.close()
    } catch (cause) {
      await output.abort().catch(() => {})
      throw cause
    }
    if (current()) setDone(true)
    await cancelArchive(request, ready.transferId)
  }
  const downloadPart = async (index: number) => {
    const parts: Uint8Array<ArrayBuffer>[] = []
    await readArchiveSegment(
      request,
      status!,
      index,
      current,
      async bytes => {
        parts.push(bytes)
      },
      setPartBytes
    )
    if (!current()) return
    download(
      new Blob(parts, { type: 'application/octet-stream' }),
      status!.manifest!.segments[index].name
    )
    setRequested(previous => new Set([...previous, index]))
  }
  const importFiles = async (files: File[]) => {
    if (!current()) return
    let library: WikiLibrary
    if (
      files.length === 1 &&
      files[0].name.endsWith('.kwiki') &&
      files[0].size <= 64 * 1024 * 1024 &&
      (await files[0].slice(0, 8).text()) !== 'KCWIKI3\n'
    ) {
      library = await knowledgeApi.importArchive(serverId, files[0], current)
    } else {
      if (!supported) throw new Error(t('upgradeRequired'))
      library = await importArchiveCollection(request, files, current, progress)
    }
    if (current()) {
      setDone(true)
      setImportedName(library.name)
      onImported(library)
    }
  }
  return (
    <ModalDialog
      title={t(mode === 'export' ? 'exportArchive' : 'importArchive')}
      testId="wiki-archive-transfer"
      wide
      onClose={onClose}
    >
      <p className="my-3 text-sm text-text-secondary">
        {t(supported === false ? 'archiveLegacyHint' : 'archiveCollectionHint')}
      </p>
      {error && <WikiError error={error} />}
      {status && (
        <p
          role="status"
          data-testid="wiki-archive-progress"
          className="my-3 text-xs tabular-nums text-text-secondary"
        >
          {t(`archivePhase.${status.phase}`)} · {(status.completedBytes / 1024 / 1024).toFixed(1)} /{' '}
          {(status.totalBytes / 1024 / 1024).toFixed(1)} MiB
          {partBytes > 0 && ` · ${(partBytes / 1024 / 1024).toFixed(1)} MiB`}
        </p>
      )}
      {done && (
        <p role="status" className="my-3 text-sm">
          {t(mode === 'import' ? 'archiveImported' : 'archiveComplete', { name: importedName })}
        </p>
      )}
      {mode === 'import' && !done && (
        <label className="my-4 block text-sm">
          {t('archiveSelectCollection')}
          <input
            data-testid="wiki-archive-files"
            type="file"
            accept=".kwiki,.json"
            multiple
            disabled={busy || supported === null}
            className="mt-2 block w-full text-sm"
            onChange={event => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) void perform(() => importFiles(files))
            }}
          />
        </label>
      )}
      {mode === 'export' && !status && !done && (
        <div className="my-4 flex flex-wrap gap-2">
          {supported && picker() && (
            <Button
              variant="outline"
              className="max-md:min-h-11"
              disabled={busy}
              data-testid="wiki-archive-save-folder"
              onClick={() =>
                void perform(async () => {
                  const folder = await picker()!({ mode: 'readwrite' })
                  if (current()) await exportCollection(folder)
                })
              }
            >
              {t('archiveSaveFolder')}
            </Button>
          )}
          <Button
            variant="outline"
            className="max-md:min-h-11"
            disabled={busy || supported === null}
            data-testid="wiki-archive-export-start"
            onClick={() =>
              void perform(async () => {
                if (supported) await exportCollection()
                else {
                  const blob = await knowledgeApi.exportArchive(serverId, libraryId!, current)
                  if (current()) {
                    download(blob, 'wiki.kwiki')
                    setDone(true)
                  }
                }
              })
            }
          >
            {t(supported ? 'archiveDownloadParts' : 'exportArchive')}
          </Button>
        </div>
      )}
      {mode === 'export' && status?.phase === 'ready' && !done && (
        <div className="my-4 space-y-2">
          <p className="text-xs text-text-secondary">{t('archiveDownloadHint')}</p>
          {status.manifest?.segments.map(segment => (
            <div key={segment.index} className="flex items-center justify-between gap-3">
              <span className="text-sm">
                {segment.name} · {(segment.size / 1024 / 1024).toFixed(1)} MiB
              </span>
              <Button
                variant="ghost"
                className="max-md:min-h-11"
                disabled={busy}
                data-testid={`wiki-archive-part-${segment.index}`}
                onClick={() => void perform(() => downloadPart(segment.index))}
              >
                {t(requested.has(segment.index) ? 'archiveDownloadAgain' : 'archiveDownloadPart')}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            className="max-md:min-h-11"
            data-testid="wiki-archive-manifest"
            disabled={busy || requested.size !== status.manifest?.segments.length}
            onClick={() => {
              download(
                new Blob([JSON.stringify(status.manifest)], { type: 'application/json' }),
                'collection.kwiki.json'
              )
              setDone(true)
              void cancelArchive(request, status.transferId).catch(() => {})
            }}
          >
            {t('archiveDownloadManifest')}
          </Button>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button
          variant="ghost"
          className="max-md:min-h-11"
          data-testid="wiki-archive-close"
          onClick={onClose}
        >
          {t(busy ? 'cancel' : 'closeSource')}
        </Button>
      </div>
    </ModalDialog>
  )
}
