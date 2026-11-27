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

test('retains the extended desktop budget for live and restored tool results only', () => {
  const image = { mimeType: 'image/jpeg', data: 'A'.repeat(1536 * 1024) }
  for (const names of [
    { name: 'mcp__kcoder_computer_use__Screenshot' },
    { tool_name: 'mcp__kcoder_computer_use__Snapshot' },
  ]) {
    expect(toolObservationOutput({ ...names, outputImages: [image] })).toMatchObject({
      images: [image],
      imagesOmitted: false,
    })
    expect(
      toolObservationOutput({ ...names, outputImages: [{ ...image, data: image.data + 'AAAA' }] })
    ).toMatchObject({ images: [], imagesOmitted: true })
  }
  expect(
    toolObservationOutput({ name: 'mcp__external__Screenshot', outputImages: [image] })
  ).toMatchObject({ images: [], imagesOmitted: true })
})
