import { expect, test } from 'vitest'
import { toolObservationOutput } from './toolObservationOutput'
test('preserves legacy results and keeps screenshot bytes next to output', () => {
  expect(toolObservationOutput({ output: 'text' })).toBe('text')
  expect(
    toolObservationOutput({
      output: 'text',
      outputImages: [{ mimeType: 'image/png', data: 'YWJj' }],
    })
  ).toEqual({
    output: 'text',
    images: [{ mimeType: 'image/png', data: 'YWJj' }],
    imagesOmitted: false,
  })
})
test('invalid or over-budget observations are explicit without discarding text', () => {
  expect(
    toolObservationOutput({
      output: 'text',
      outputImages: [
        null,
        { mimeType: 'image/svg+xml', data: 'bad' },
        { mimeType: 'image/png', data: 'A'.repeat(1024 * 1024 + 1) },
      ],
    })
  ).toEqual({
    output: 'text',
    images: [],
    imagesOmitted: true,
  })
})
