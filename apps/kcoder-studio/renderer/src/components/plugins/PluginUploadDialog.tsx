import { Upload } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { ModalDialog } from '@/components/ui/modal-dialog'

const MAX_PLUGIN_PACKAGE_SIZE_BYTES = 50 * 1024 * 1024

export function PluginUploadDialog({
  isUploading,
  uploadError = null,
  onCancel,
  onErrorReset,
  onUpload,
}: {
  isUploading: boolean
  uploadError?: string | null
  onCancel: () => void
  onErrorReset?: () => void
  onUpload: (file: File) => Promise<void>
}) {
  const { t } = useTranslation('common')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const visibleError = error || uploadError

  const selectFile = (nextFile: File | null) => {
    setError('')
    onErrorReset?.()
    if (!nextFile) {
      setFile(null)
      return
    }
    if (!nextFile.name?.toLowerCase().endsWith('.zip')) {
      setError(t('workbench.plugins_plugin_upload_zip_error', '请选择 .zip 插件包'))
      setFile(null)
      return
    }
    if (nextFile.size > MAX_PLUGIN_PACKAGE_SIZE_BYTES) {
      setError(t('workbench.plugins_plugin_upload_size_error', '插件安装包不能超过 50MB'))
      setFile(null)
      return
    }
    setFile(nextFile)
  }

  return (
    <ModalDialog
      title={t('workbench.plugins_plugin_upload_title')}
      testId="plugin-upload-dialog"
      pending={isUploading}
      onClose={onCancel}
      closeLabel={t('workbench.plugins_uninstall_cancel')}
    >
      <form
        onSubmit={event => {
          event.preventDefault()
          if (!file) {
            setError(t('workbench.plugins_plugin_upload_select_file', '请先选择插件包'))
            return
          }
          onUpload(file).catch(uploadError => {
            setError(
              uploadError instanceof Error
                ? uploadError.message
                : t('workbench.plugins_plugin_upload_failed', '插件上传失败')
            )
          })
        }}
      >
        <p className="mt-1 text-sm text-text-secondary">
          {t(
            'workbench.plugins_plugin_upload_description',
            '选择包含 .codex-plugin/plugin.json 的 ZIP 包。'
          )}
        </p>

        <label className="mt-5 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface px-4 text-center hover:border-primary">
          <Upload className="h-8 w-8 text-text-secondary" />
          <span className="mt-3 text-sm font-semibold">
            {file ? file.name : t('workbench.plugins_plugin_upload_drop_title', '选择插件 ZIP 包')}
          </span>
          <span className="mt-1 text-xs text-text-muted">
            {t(
              'workbench.plugins_plugin_upload_hint',
              '支持插件 ZIP（含 .claude-plugin 清单），最大 50MB'
            )}
          </span>
          <input
            type="file"
            accept=".zip,application/zip"
            data-testid="plugin-upload-file-input"
            className="sr-only"
            disabled={isUploading}
            onChange={event => selectFile(event.target.files?.[0] ?? null)}
          />
        </label>

        {visibleError && <p className="mt-3 text-sm font-semibold text-red-500">{visibleError}</p>}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            className="h-10 rounded-xl border border-border px-4 text-sm font-semibold"
            onClick={onCancel}
            disabled={isUploading}
          >
            {t('workbench.plugins_uninstall_cancel', '取消')}
          </button>
          <button
            type="submit"
            data-testid="plugin-upload-confirm-button"
            disabled={isUploading}
            className="h-10 rounded-xl bg-text-primary px-4 text-sm font-semibold text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {isUploading
              ? t('workbench.plugins_plugin_uploading', '上传中')
              : t('workbench.plugins_skill_upload_confirm', '上传')}
          </button>
        </div>
      </form>
    </ModalDialog>
  )
}
