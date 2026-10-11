import { afterEach, expect, test } from 'vitest'
import { desktopControlImageMetrics, queryDesktopControls } from './desktop-control-query'
afterEach(() => {
  document.body.replaceChildren()
})
test('targets real open shadow controls only through explicit traversal', () => {
  const host = document.createElement('div')
  host.id = 'tree'
  document.body.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = '<button data-item-path="file.txt">file</button>'
  expect(queryDesktopControls('#tree')).toEqual([host])
  expect(queryDesktopControls('button')).toEqual([])
  expect(queryDesktopControls('#tree >>> button[data-item-path="file.txt"]')).toEqual([
    shadow.querySelector('button'),
  ])
  expect(queryDesktopControls('#missing >>> button')).toEqual([])
  expect(() => queryDesktopControls('#tree >>>')).toThrow('Empty')
})

test('image metrics distinguish loading, failed decoding and decoded dimensions', () => {
  const image = document.createElement('img')
  Object.defineProperties(image, {
    complete: { value: false, configurable: true },
    naturalWidth: { value: 0, configurable: true },
    naturalHeight: { value: 0, configurable: true },
  })
  expect(desktopControlImageMetrics(image)).toEqual({
    imageComplete: false,
    naturalWidth: 0,
    naturalHeight: 0,
  })
  Object.defineProperty(image, 'complete', { value: true })
  expect(desktopControlImageMetrics(image)).toEqual({
    imageComplete: true,
    naturalWidth: 0,
    naturalHeight: 0,
  })
  Object.defineProperties(image, { naturalWidth: { value: 64 }, naturalHeight: { value: 64 } })
  expect(desktopControlImageMetrics(image)).toEqual({
    imageComplete: true,
    naturalWidth: 64,
    naturalHeight: 64,
  })
  expect(desktopControlImageMetrics(document.createElement('div'))).toEqual({})
})
