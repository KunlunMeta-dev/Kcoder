import { requestLocalExecutor } from '@/tauri/localExecutor'

export interface WikiModeStatus {
  enabled: boolean
  retrievalEnabled: boolean
  organizationEnabled: boolean
}

export interface WikiJob {
  id: string
  sourceId: string
  status: string
  afterChunk: number
  errorCode?: string | null
}

export interface WikiLibrary {
  revision: number
  id: string
  name: string
  purpose: string
  archived: boolean
}
export interface WikiSource {
  removed?: boolean
  sourceId: string
  revisionId: string
  title: string
  bodyHash: string
}
export interface WikiPageSummary {
  pageId: string
  revisionId: string
  title: string
  kind: string
  humanEdited: boolean
}
export interface WikiPage {
  revisionId: string
  humanEdited: boolean
  draft: {
    pageId: string
    title: string
    markdown: string
    citations: Array<{ sourceId: string; revisionId: string; chunkId: string; quote: string }>
  }
}
export interface WikiPageList<T> {
  items: T[]
  nextAfterId?: string | null
}
const request = <T>(serverId: string, method: string, params: object = {}) =>
  requestLocalExecutor<T>('runtime.knowledge.request', { serverId, method, params })

async function uploadWikiFile<T>(
  serverId: string,
  file: File,
  isCurrent: () => boolean,
  finish: (path: string, key: string) => Promise<T>
): Promise<T> {
  const check = () => {
    if (!isCurrent()) throw new Error('Wiki target changed')
  }
  check()
  const started = await request<{ upload_id: string }>(serverId, 'attachment/upload/start', {
    filename: file.name,
    size: file.size,
  })
  let path: string | undefined
  try {
    for (let offset = 0, index = 0; offset < file.size; offset += 192 * 1024, index++) {
      check()
      const bytes = new Uint8Array(await file.slice(offset, offset + 192 * 1024).arrayBuffer())
      let binary = ''
      for (let at = 0; at < bytes.length; at += 8192)
        binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
      await request(serverId, 'attachment/upload/chunk', {
        upload_id: started.upload_id,
        index,
        content_base64: btoa(binary),
      })
    }
    check()
    const saved = await request<{ path: string }>(serverId, 'attachment/upload/finish', {
      upload_id: started.upload_id,
    })
    path = saved.path
    check()
    const { key } = await request<{ key: string }>(serverId, 'knowledge/attachment/digest', {
      attachmentPath: path,
      title: file.name,
    })
    return await finish(path, key)
  } finally {
    // Cleanup is scoped to the same target; never retry an import on another target.
    if (isCurrent()) {
      try {
        if (path) await request(serverId, 'attachment/delete', { path })
        else await request(serverId, 'attachment/upload/cancel', { upload_id: started.upload_id })
      } catch {
        /* Connection cleanup also removes owned staging files. */
      }
    }
  }
}

export const knowledgeApi = {
  previewDirectory: (serverId: string, directory: string) =>
    request<{ items: Array<{ title: string; size: number; available: boolean }> }>(
      serverId,
      'knowledge/source/directoryPreview',
      { directory }
    ),
  stageDirectory: (serverId: string, directory: string, selectedTitles?: string[]) =>
    request<{
      items: Array<{ title: string; size: number; attachmentPath: string; idempotencyKey: string }>
      totalBytes: number
    }>(serverId, 'knowledge/source/directoryStage', {
      directory,
      ...(selectedTitles ? { selectedTitles } : {}),
    }),
  importStaged: (
    serverId: string,
    libraryId: string,
    item: { title: string; attachmentPath: string; idempotencyKey: string }
  ) =>
    request<WikiSource>(serverId, 'knowledge/source/importAttachment', {
      libraryId,
      title: item.title,
      attachmentPath: item.attachmentPath,
      idempotencyKey: item.idempotencyKey,
    }),
  discardStaged: (serverId: string, path: string) =>
    request(serverId, 'attachment/delete', { path }),

  originalFile: async (
    serverId: string,
    libraryId: string,
    source: WikiSource,
    isCurrent: () => boolean
  ) => {
    if (!isCurrent()) throw new Error('Wiki target changed')
    const artifact = await request<{
      path: string
      size: number
      filename: string
      mimeType: string
    }>(serverId, 'knowledge/source/original/export', {
      libraryId,
      sourceId: source.sourceId,
      revisionId: source.revisionId,
    })
    try {
      if (
        !Number.isSafeInteger(artifact.size) ||
        artifact.size < 0 ||
        artifact.size > 32 * 1024 * 1024
      )
        throw new Error('Original file exceeds 32 MiB')
      const parts: Uint8Array<ArrayBuffer>[] = []
      let offset = 0
      while (offset < artifact.size) {
        if (!isCurrent()) throw new Error('Wiki target changed')
        const chunk = await request<{
          contentBase64: string
          nextOffset: number
          size: number
          eof: boolean
        }>(serverId, 'knowledge/export/read', { attachmentPath: artifact.path, offset })
        const bytes = Uint8Array.from(atob(chunk.contentBase64), c => c.charCodeAt(0))
        if (
          chunk.size !== artifact.size ||
          chunk.nextOffset !== offset + bytes.length ||
          !bytes.length ||
          chunk.nextOffset > artifact.size
        )
          throw new Error('Invalid original file chunk')
        parts.push(bytes)
        offset = chunk.nextOffset
      }
      if (!isCurrent()) throw new Error('Wiki target changed')
      return { filename: artifact.filename, blob: new Blob(parts, { type: artifact.mimeType }) }
    } finally {
      if (isCurrent())
        await request(serverId, 'attachment/delete', { path: artifact.path }).catch(() => {})
    }
  },

  configureMode: (
    serverId: string,
    mode: 'retrievalEnabled' | 'organizationEnabled',
    value: boolean
  ) => request<WikiModeStatus>(serverId, 'knowledge/configure', { [mode]: value }),

  links: (serverId: string, libraryId: string, pageId: string) =>
    request<{
      outgoing: Array<{ pageId: string; title: string }>
      incoming: Array<{ pageId: string; title: string }>
      outgoingTruncated: boolean
      incomingTruncated: boolean
    }>(serverId, 'knowledge/page/links', { libraryId, pageId }),

  cancelJob: (serverId: string, libraryId: string, jobId: string) =>
    request(serverId, 'knowledge/job/cancel', { libraryId, jobId }),
  library: (serverId: string, libraryId: string) =>
    request<WikiLibrary>(serverId, 'knowledge/read', { libraryId }),
  defaultLibrary: (serverId: string) =>
    request<{ libraryId: string | null }>(serverId, 'knowledge/default/read'),
  selectLibrary: (serverId: string, libraryId: string) =>
    request(serverId, 'knowledge/default/set', { libraryId }),

  importMarkdown: (serverId: string, libraryId: string, file: File, isCurrent: () => boolean) =>
    uploadWikiFile(serverId, file, isCurrent, (path, key) =>
      request(serverId, 'knowledge/markdown/import', {
        libraryId,
        attachmentPath: path,
        idempotencyKey: `markdown:${key}`,
      })
    ),

  extendBudget: async (serverId: string, libraryId: string, jobId: string) => {
    const current = await request<{ callLimit: number | null }>(serverId, 'knowledge/job/budget', {
      libraryId,
      jobId,
    })
    if (current.callLimit == null || current.callLimit >= 4096)
      throw new Error('Wiki budget limit reached')
    return request(serverId, 'knowledge/job/budget/extend', {
      libraryId,
      jobId,
      expectedLimit: current.callLimit,
      newLimit: Math.min(current.callLimit + 64, 4096),
    })
  },

  removeSource: (serverId: string, libraryId: string, source: WikiSource, removed: boolean) =>
    request(serverId, 'knowledge/source/remove', {
      libraryId,
      sourceId: source.sourceId,
      expectedRevision: source.revisionId,
      removed,
    }),
  removedSources: (serverId: string, libraryId: string, afterId?: string) =>
    request<WikiPageList<WikiSource>>(serverId, 'knowledge/source/removed', {
      libraryId,
      afterId,
      limit: 50,
    }),
  updateSourceFile: (
    serverId: string,
    libraryId: string,
    source: WikiSource,
    file: File,
    isCurrent: () => boolean
  ) =>
    uploadWikiFile(serverId, file, isCurrent, (path, key) =>
      request<WikiSource>(serverId, 'knowledge/source/importAttachment', {
        libraryId,
        sourceId: source.sourceId,
        expectedRevision: source.revisionId,
        idempotencyKey: `update:${source.sourceId}:${key}`,
        title: file.name,
        attachmentPath: path,
      })
    ),

  search: (serverId: string, libraryId: string, query: string) =>
    request<{
      items: Array<{ documentId: string; revisionId: string; title: string; excerpt: string }>
    }>(serverId, 'knowledge/search', { libraryId, query, limit: 20 }),
  source: (serverId: string, libraryId: string, source: WikiSource, afterChunk = 0) =>
    request<{
      items: Array<{
        chunkId: string
        firstLine: number
        lastLine: number
        page?: number
        text: string
      }>
      nextAfterChunk?: number | null
    }>(serverId, 'knowledge/source/read', {
      libraryId,
      sourceId: source.sourceId,
      revisionId: source.revisionId,
      afterChunk,
      limit: 4,
    }),

  archive: (serverId: string, library: WikiLibrary, archived: boolean) =>
    request<WikiLibrary>(serverId, 'knowledge/archive', {
      libraryId: library.id,
      expectedRevision: library.revision,
      archived,
    }),
  reindex: (serverId: string, libraryId: string) =>
    request(serverId, 'knowledge/reindex', { libraryId }),

  importFile: (serverId: string, libraryId: string, file: File, isCurrent: () => boolean) =>
    uploadWikiFile(serverId, file, isCurrent, (path, key) =>
      request<WikiSource>(serverId, 'knowledge/source/importAttachment', {
        libraryId,
        idempotencyKey: `file:${key}`,
        title: file.name,
        attachmentPath: path,
      })
    ),
  importArchive: (serverId: string, file: File, isCurrent: () => boolean) =>
    uploadWikiFile(serverId, file, isCurrent, (path, key) =>
      request<WikiLibrary>(serverId, 'knowledge/importArchive', {
        idempotencyKey: `archive:${key}`,
        attachmentPath: path,
      })
    ),
  exportArchive: async (
    serverId: string,
    libraryId: string,
    isCurrent: () => boolean,
    markdown = false
  ) => {
    const artifact = await request<{ path: string; size: number }>(
      serverId,
      markdown ? 'knowledge/markdown/export' : 'knowledge/export',
      {
        libraryId,
      }
    )
    try {
      const parts: Uint8Array<ArrayBuffer>[] = []
      let offset = 0
      do {
        if (!isCurrent()) throw new Error('Wiki target changed')
        const chunk = await request<{
          contentBase64: string
          nextOffset: number
          size: number
          eof: boolean
        }>(serverId, 'knowledge/export/read', { attachmentPath: artifact.path, offset })
        const binary = atob(chunk.contentBase64)
        parts.push(Uint8Array.from(binary, character => character.charCodeAt(0)))
        if (chunk.nextOffset <= offset || chunk.nextOffset > artifact.size)
          throw new Error('Invalid Wiki export chunk')
        offset = chunk.nextOffset
      } while (offset < artifact.size)
      return new Blob(parts, { type: 'application/json' })
    } finally {
      if (isCurrent())
        await request(serverId, 'attachment/delete', { path: artifact.path }).catch(() => {})
    }
  },
  updateLibrary: (serverId: string, library: WikiLibrary, name: string, purpose: string) =>
    request<WikiLibrary>(serverId, 'knowledge/update', {
      libraryId: library.id,
      expectedRevision: library.revision,
      name,
      purpose,
    }),
  editPage: (
    serverId: string,
    libraryId: string,
    page: WikiPage,
    idempotencyKey: string,
    title: string,
    markdown: string
  ) =>
    request<{ pageId: string; revisionId: string }>(serverId, 'knowledge/page/edit', {
      libraryId,
      pageId: page.draft.pageId,
      expectedRevision: page.revisionId,
      idempotencyKey,
      title,
      markdown,
    }),
  history: (serverId: string, libraryId: string, pageId: string, beforeSequence?: number) =>
    request<{
      items: Array<{
        revisionId: string
        sequence: number
        title: string
        author: string
        restoredFrom: string | null
      }>
      nextBeforeSequence: number | null
    }>(serverId, 'knowledge/page/history', { libraryId, pageId, beforeSequence, limit: 20 }),
  restorePage: (
    serverId: string,
    libraryId: string,
    page: WikiPage,
    revisionId: string,
    idempotencyKey: string
  ) =>
    request<{ pageId: string; revisionId: string }>(serverId, 'knowledge/page/restore', {
      libraryId,
      pageId: page.draft.pageId,
      expectedRevision: page.revisionId,
      revisionId,
      idempotencyKey,
    }),
  review: (serverId: string, libraryId: string, jobId: string) =>
    request<{
      token: string
      notes: string[]
      pages: Array<{ pageId: string; title: string; updating: boolean }>
    }>(serverId, 'knowledge/review/read', { libraryId, jobId }),
  reviewPage: (
    serverId: string,
    libraryId: string,
    jobId: string,
    token: string,
    pageId: string,
    offset: number
  ) =>
    request<{ proposed: string; current: string | null; nextOffset: number | null }>(
      serverId,
      'knowledge/review/page',
      { libraryId, jobId, token, pageId, offset }
    ),
  decideReview: (
    serverId: string,
    libraryId: string,
    jobId: string,
    token: string,
    decision: 'accept' | 'reject'
  ) => request<WikiJob>(serverId, 'knowledge/review/decide', { libraryId, jobId, token, decision }),
  citation: (
    serverId: string,
    libraryId: string,
    citation: WikiPage['draft']['citations'][number]
  ) =>
    request<{
      source: WikiSource
      chunk: { firstLine: number; lastLine: number; text: string; page?: number }
    }>(serverId, 'knowledge/citation/resolve', {
      libraryId,
      sourceId: citation.sourceId,
      revisionId: citation.revisionId,
      chunkId: citation.chunkId,
    }),
  jobs: (serverId: string, libraryId: string) =>
    request<WikiPageList<WikiJob>>(serverId, 'knowledge/job/overview', { libraryId }),
  startJob: (
    serverId: string,
    libraryId: string,
    source: WikiSource,
    language: string,
    requestKey?: string
  ) =>
    request<WikiJob>(serverId, 'knowledge/job/start', {
      libraryId,
      sourceId: source.sourceId,
      revisionId: source.revisionId,
      idempotencyKey: requestKey ?? `organize:${source.sourceId}:${source.revisionId}`,
      language,
    }),
  pauseJob: (serverId: string, libraryId: string, jobId: string) =>
    request<WikiJob>(serverId, 'knowledge/job/pause', { libraryId, jobId }),
  resumeJob: (serverId: string, libraryId: string, jobId: string) =>
    request<WikiJob>(serverId, 'knowledge/job/resume', { libraryId, jobId }),
  status: (serverId: string) => request<WikiModeStatus>(serverId, 'knowledge/status'),
  configure: (serverId: string, enabled: boolean) =>
    request<WikiModeStatus>(serverId, 'knowledge/configure', { enabled }),
  libraries: (serverId: string, afterId?: string) =>
    request<WikiPageList<WikiLibrary>>(serverId, 'knowledge/list', { afterId, limit: 50 }),
  create: (serverId: string, idempotencyKey: string, name: string, purpose = '') =>
    request<WikiLibrary>(serverId, 'knowledge/create', { idempotencyKey, name, purpose }),
  sources: (serverId: string, libraryId: string, afterId?: string) =>
    request<WikiPageList<WikiSource>>(serverId, 'knowledge/source/list', {
      libraryId,
      afterId,
      limit: 50,
    }),
  importText: (
    serverId: string,
    libraryId: string,
    idempotencyKey: string,
    title: string,
    text: string
  ) =>
    request<WikiSource>(serverId, 'knowledge/source/importText', {
      libraryId,
      idempotencyKey,
      title,
      text,
    }),
  pages: (serverId: string, libraryId: string, afterId?: string) =>
    request<WikiPageList<WikiPageSummary>>(serverId, 'knowledge/page/list', {
      libraryId,
      afterId,
      limit: 50,
    }),
  page: (serverId: string, libraryId: string, pageId: string, revisionId?: string) =>
    request<WikiPage>(serverId, 'knowledge/page/read', { libraryId, pageId, revisionId }),
}
