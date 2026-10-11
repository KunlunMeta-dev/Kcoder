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
