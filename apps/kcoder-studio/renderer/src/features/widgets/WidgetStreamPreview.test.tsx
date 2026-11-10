import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import '@/i18n'
import { WidgetStreamPreview } from './WidgetStreamPreview'
import { safeWidgetPreviewSvg } from './widgetPreviewSvg'

test('partial SVG prefixes show real graphics while executable elements and resources are removed', () => {
  const source =
    '<svg viewBox="0 0 100 100"><script>alert(1)</script><foreignObject><iframe src="https://invalid"></iframe></foreignObject><style>body{}</style><rect width="20" height="30" onclick="alert(1)" fill="url(https://invalid)"/><text>实际数据'
  const safe = safeWidgetPreviewSvg(source)!
  expect(safe).toContain('<rect')
  expect(safe).toContain('实际数据')
  expect(safe).not.toMatch(/script|foreignObject|iframe|style|onclick|https:\/\/invalid/)
  render(
    <WidgetStreamPreview
      title="Diagram"
      summary=""
      source={source}
      format="svg"
      receivedBytes={256}
    />
  )
  expect(screen.getByTestId('widget-svg-prefix')).toHaveAttribute(
    'src',
    expect.stringContaining('data:image/svg+xml,')
  )
})
