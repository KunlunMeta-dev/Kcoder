import { expect, test } from 'vitest'
import { splitWidgetDirectives } from './widgetDirectives'

test('widget references preserve narrative order and identify repeated references', () => {
  expect(
    splitWidgetDirectives(
      'Before\n::kcoder-widget{widget_id="w-1" revision=2}\nAfter\n::kcoder-widget{widget_id="w-1" revision=2}'
    )
  ).toEqual([
    { kind: 'markdown', content: 'Before' },
    { kind: 'widget', reference: { widgetId: 'w-1', revision: 2 }, duplicate: false },
    { kind: 'markdown', content: 'After' },
    { kind: 'widget', reference: { widgetId: 'w-1', revision: 2 }, duplicate: true },
  ])
})

test('code fences, partial directives and unsafe identities remain text', () => {
  const content =
    '````md\n::kcoder-widget{widget_id="w-1" revision=1}\n```\n````\n::kcoder-widget{widget_id="../../private" revision=1}\n::kcoder-widget{widget_id="w-2" revision='
  expect(splitWidgetDirectives(content)).toEqual([{ kind: 'markdown', content }])
})
