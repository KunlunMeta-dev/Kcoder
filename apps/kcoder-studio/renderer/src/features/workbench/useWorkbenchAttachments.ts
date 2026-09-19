import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, MultiAttachmentUploadState } from '@/types/api'
import {
  deleteAttachment as defaultDeleteAttachment,
  isValidFileSize,
  uploadAttachment as defaultUploadAttachment,
} from '@/api/attachments'
import { readTextAttachmentMetadata, releaseAttachmentPreview } from '@/lib/attachments'

interface UseWorkbenchAttachmentsOptions {
  uploadAttachment?: (
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal
  ) => Promise<Attachment>
  deleteAttachment?: (attachmentId: number) => Promise<void>
  scopeKey?: string
}

const DEFAULT_ATTACHMENT_SCOPE_KEY = 'default'

function emptyAttachmentState(): MultiAttachmentUploadState {
  return {
    attachments: [],
    uploadingFiles: new Map(),
    errors: new Map(),
  }
}

export function useWorkbenchAttachments(options: UseWorkbenchAttachmentsOptions = {}) {
  const uploadAttachment = options.uploadAttachment ?? defaultUploadAttachment
  const deleteAttachment = options.deleteAttachment ?? defaultDeleteAttachment
  const scopeKey = options.scopeKey ?? DEFAULT_ATTACHMENT_SCOPE_KEY
  const [stateByScope, setStateByScope] = useState<Record<string, MultiAttachmentUploadState>>({})
  const uploadControllersRef = useRef(new Map<string, AbortController>())
  const state = stateByScope[scopeKey] ?? emptyAttachmentState()

  useEffect(
    () => () => {
      uploadControllersRef.current.forEach(controller => controller.abort())
      uploadControllersRef.current.clear()
    },
    []
  )

  const updateScopeState = useCallback(
    (updater: (current: MultiAttachmentUploadState) => MultiAttachmentUploadState) => {
      setStateByScope(currentByScope => {
        const current = currentByScope[scopeKey] ?? emptyAttachmentState()
        const next = updater(current)
        if (next === current) return currentByScope
        return {
          ...currentByScope,
          [scopeKey]: next,
        }
      })
    },
    [scopeKey]
  )

  const isUploading = state.uploadingFiles.size > 0
  const isAttachmentReadyToSend = useMemo(
    () =>
      !isUploading &&
      state.errors.size === 0 &&
      state.attachments.every(attachment => attachment.status === 'ready'),
    [isUploading, state.attachments, state.errors]
  )

  const addExistingAttachment = useCallback(
    (attachment: Attachment) => {
      updateScopeState(current => {
        if (current.attachments.some(item => item.id === attachment.id)) return current
        return {
          ...current,
          attachments: [...current.attachments, attachment],
        }
      })
    },
    [updateScopeState]
  )

  const cancelUpload = useCallback(
    (fileId: string) => {
      const controllerKey = JSON.stringify([scopeKey, fileId])
      uploadControllersRef.current.get(controllerKey)?.abort()
      uploadControllersRef.current.delete(controllerKey)
      updateScopeState(current => {
        if (!current.uploadingFiles.has(fileId) && !current.errors.has(fileId)) return current
        const uploadingFiles = new Map(current.uploadingFiles)
        const errors = new Map(current.errors)
        uploadingFiles.delete(fileId)
        errors.delete(fileId)
        return { ...current, uploadingFiles, errors }
      })
    },
    [scopeKey, updateScopeState]
  )

  const uploadOne = useCallback(
    async (file: File) => {
      const fileId = file.name
      const controllerKey = JSON.stringify([scopeKey, fileId])
      uploadControllersRef.current.get(controllerKey)?.abort()
      const controller = new AbortController()
      uploadControllersRef.current.set(controllerKey, controller)

      updateScopeState(current => {
        const uploadingFiles = new Map(current.uploadingFiles)
        const errors = new Map(current.errors)
        uploadingFiles.set(fileId, {
          file,
          progress: 0,
          cancel: () => cancelUpload(fileId),
        })
        errors.delete(fileId)
        return { ...current, uploadingFiles, errors }
      })

      if (!isValidFileSize(file.size)) {
        updateScopeState(current => {
          const uploadingFiles = new Map(current.uploadingFiles)
          uploadingFiles.delete(fileId)
          const errors = new Map(current.errors)
          errors.set(fileId, 'File is too large')
          return { ...current, uploadingFiles, errors }
        })
        uploadControllersRef.current.delete(controllerKey)
        return
      }

      try {
        // Let React draw the placeholder card before reading and serializing a large file so the main thread does not appear frozen.
        await new Promise<void>(resolve => window.setTimeout(resolve, 0))
        if (controller.signal.aborted) return
        const textMetadataPromise = readTextAttachmentMetadata(file)
        const attachment = await uploadAttachment(
          file,
          progress => {
            if (uploadControllersRef.current.get(controllerKey) !== controller) return
            updateScopeState(current => {
              const uploadingFiles = new Map(current.uploadingFiles)
              const existing = uploadingFiles.get(fileId)
              if (existing) {
                uploadingFiles.set(fileId, { ...existing, progress })
              }
              return { ...current, uploadingFiles }
            })
          },
          controller.signal
        )
        if (controller.signal.aborted) return
        const textMetadata = await textMetadataPromise
        if (controller.signal.aborted) return
        const enrichedAttachment = textMetadata
          ? {
              ...attachment,
              text_preview: attachment.text_preview ?? textMetadata.text_preview,
              text_content: attachment.text_content ?? textMetadata.text_content,
              text_length: attachment.text_length ?? textMetadata.text_length,
            }
          : attachment

        updateScopeState(current => {
          const uploadingFiles = new Map(current.uploadingFiles)
          uploadingFiles.delete(fileId)
          const errors = new Map(current.errors)
          errors.delete(fileId)
          return {
            ...current,
            attachments: [...current.attachments, enrichedAttachment],
            uploadingFiles,
            errors,
          }
        })
      } catch (error) {
        if (controller.signal.aborted) return
        updateScopeState(current => {
          const uploadingFiles = new Map(current.uploadingFiles)
          const errors = new Map(current.errors)
          uploadingFiles.delete(fileId)
          errors.set(fileId, error instanceof Error ? error.message : 'Upload failed')
          return { ...current, uploadingFiles, errors }
        })
      } finally {
        if (uploadControllersRef.current.get(controllerKey) === controller) {
          uploadControllersRef.current.delete(controllerKey)
        }
      }
    },
    [cancelUpload, scopeKey, updateScopeState, uploadAttachment]
  )

  const handleFileSelect = useCallback(
    async (files: File | File[]) => {
      const fileList = Array.isArray(files) ? files : [files]
      await Promise.all(fileList.map(file => uploadOne(file)))
    },
    [uploadOne]
  )

  const removeAttachment = useCallback(
    async (attachmentId: number) => {
      const attachment = state.attachments.find(item => item.id === attachmentId)
      const attachmentsToRemove = attachment?.ui_group_id
        ? state.attachments.filter(item => item.ui_group_id === attachment.ui_group_id)
        : attachment
          ? [attachment]
          : []
      attachmentsToRemove.forEach(releaseAttachmentPreview)
      const idsToRemove = new Set(attachmentsToRemove.map(item => item.id))
      updateScopeState(current => ({
        ...current,
        attachments: current.attachments.filter(attachment => !idsToRemove.has(attachment.id)),
      }))
      await Promise.all(
        attachmentsToRemove.filter(item => item.id > 0).map(item => deleteAttachment(item.id))
      )
    },
    [deleteAttachment, state.attachments, updateScopeState]
  )

  const resetAttachments = useCallback(
    (submittedIds?: readonly number[]) => {
      if (submittedIds) {
        const submitted = new Set(submittedIds)
        state.attachments
          .filter(attachment => submitted.has(attachment.id))
          .forEach(releaseAttachmentPreview)
        updateScopeState(current => ({
          ...current,
          attachments: current.attachments.filter(attachment => !submitted.has(attachment.id)),
        }))
        return
      }
      for (const [key, controller] of uploadControllersRef.current) {
        if (JSON.parse(key)[0] !== scopeKey) continue
        controller.abort()
        uploadControllersRef.current.delete(key)
      }
      state.attachments.forEach(releaseAttachmentPreview)
      updateScopeState(current => ({
        ...current,
        attachments: [],
        uploadingFiles: new Map(),
        errors: new Map(),
      }))
    },
    [scopeKey, state.attachments, updateScopeState]
  )

  return {
    state,
    attachments: state.attachments,
    uploadingFiles: state.uploadingFiles,
    errors: state.errors,
    isUploading,
    isAttachmentReadyToSend,
    handleFileSelect,
    cancelUpload,
    addExistingAttachment,
    removeAttachment,
    resetAttachments,
  }
}
