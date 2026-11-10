import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import { WikiFileImportControls } from './WikiFileImportControls'
import { wikiFileCapabilities } from './wikiFileCapabilities'

test('browse and drop use the same import owner and disabled controls reject drops', () => {
  const onFiles = vi.fn()
  const onDirectory = vi.fn()
  const view = render(
    <WikiFileImportControls busy={false} onFiles={onFiles} onDirectory={onDirectory} />
  )
  const picker = screen.getByTestId('wiki-import-files') as HTMLInputElement
  const openPicker = vi.spyOn(picker, 'click')
  const upload = screen.getByRole('button', { name: '上传' })
  expect(upload).toHaveAttribute('data-testid', 'wiki-upload-browse')
  fireEvent.click(upload)
  expect(openPicker).toHaveBeenCalledOnce()
  const file = new File(['fixture'], 'source.md', { type: 'text/markdown' })
  fireEvent.drop(screen.getByTestId('wiki-upload-dropzone'), { dataTransfer: { files: [file] } })
  expect(onFiles).toHaveBeenLastCalledWith([file])
  fireEvent.change(screen.getByTestId('wiki-import-files'), { target: { files: [file] } })
  expect(onFiles).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByTestId('wiki-directory-open'))
  expect(onDirectory).toHaveBeenCalledTimes(1)
  view.rerender(<WikiFileImportControls busy onFiles={onFiles} onDirectory={onDirectory} />)
  fireEvent.drop(screen.getByTestId('wiki-upload-dropzone'), { dataTransfer: { files: [file] } })
  expect(onFiles).toHaveBeenCalledTimes(2)
  expect(screen.getByTestId('wiki-upload-browse')).toBeDisabled()
  fireEvent.click(screen.getByTestId('wiki-upload-browse'))
  expect(openPicker).toHaveBeenCalledOnce()
})

test('upload limits and accepted extensions follow the selected target capabilities', () => {
  render(
    <WikiFileImportControls
      busy={false}
      onFiles={vi.fn()}
      onDirectory={vi.fn()}
      capabilities={[{ ...wikiFileCapabilities[0], maxFileBytes: 4 * 1024 * 1024 }]}
    />
  )
  expect(screen.getByTestId('wiki-import-files')).toHaveAttribute('accept', '.txt')
  expect(screen.getByTestId('wiki-upload-dropzone')).toHaveTextContent('文档最大 4 MiB')
  expect(screen.getByTestId('wiki-upload-dropzone')).not.toHaveTextContent('图片最大')
})

test('the import card keeps the real toolbar and target-reported size hints together', () => {
  render(
    <WikiFileImportControls
      busy={false}
      onFiles={vi.fn()}
      onDirectory={vi.fn()}
      actions={<button>Existing library controls</button>}
    />
  )
  const card = screen.getByTestId('knowledge-import-card')
  expect(card).toContainElement(screen.getByTestId('wiki-file-import'))
  expect(card).toContainElement(screen.getByTestId('wiki-directory-open'))
  expect(card).toContainElement(screen.getByRole('button', { name: 'Existing library controls' }))
  const zone = screen.getByTestId('wiki-upload-dropzone')
  expect(zone).toHaveTextContent('32 MiB')
  expect(zone).toHaveTextContent('10 MiB')
  expect(zone).toHaveTextContent('不自动 OCR')
})
