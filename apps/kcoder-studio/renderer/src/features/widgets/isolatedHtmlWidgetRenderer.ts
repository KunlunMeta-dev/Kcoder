import { createElement } from 'react'
import { IsolatedHtmlWidgetHost } from './IsolatedHtmlWidgetHost'
import type { InlineWidgetHostProps } from './InlineWidgetHost'

export function isolatedHtmlWidgetRenderer(props: InlineWidgetHostProps) {
  return createElement(IsolatedHtmlWidgetHost, props)
}
