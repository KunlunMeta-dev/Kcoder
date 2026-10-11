import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { SkillUploadDialog } from './SkillUploadDialog'
import { readSkillPackageInfo, type SkillPackageInfo } from './skill-upload-utils'
vi.mock('./skill-upload-utils', () => ({ readSkillPackageInfo: vi.fn() }))
test.each(['success', 'failure'])(
  'the latest selected package survives an earlier read %s',
  async outcome => {
    let resolve!: (value: SkillPackageInfo) => void, reject!: (cause: Error) => void
    const first = new Promise<SkillPackageInfo>((yes, no) => {
      resolve = yes
      reject = no
    })
    vi.mocked(readSkillPackageInfo)
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ name: 'new', version: '', description: '', author: '', tags: [] })
    const upload = vi.fn(async () => {})
    render(<SkillUploadDialog isUploading={false} onCancel={vi.fn()} onUpload={upload} />)
    const oldFile = new File(['old'], 'old.zip'),
      newFile = new File(['new'], 'new.zip')
    fireEvent.change(screen.getByTestId('skill-upload-file-input'), {
      target: { files: [oldFile] },
    })
    fireEvent.change(screen.getByTestId('skill-upload-file-input'), {
      target: { files: [newFile] },
    })
    expect(await screen.findByTestId('skill-upload-name-input')).toHaveValue('new')
    await act(async () =>
      outcome === 'success'
        ? resolve({ name: 'old', version: '', description: '', author: '', tags: [] })
        : reject(new Error('old read error'))
    )
    expect(screen.getByTestId('skill-upload-name-input')).toHaveValue('new')
    expect(screen.queryByText('old read error')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('skill-upload-confirm-button'))
    expect(upload).toHaveBeenCalledWith(newFile, 'new')
  }
)
