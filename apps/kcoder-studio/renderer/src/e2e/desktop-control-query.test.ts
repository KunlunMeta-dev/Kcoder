import { afterEach, expect, test } from 'vitest'
import { queryDesktopControls } from './desktop-control-query'
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
