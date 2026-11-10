import { useState } from 'react'
import { InlineWidgetHost, WidgetStreamPreview } from '../../src/features/widgets/InlineWidgetHost'
import { widgetContentSha256 } from '../../src/features/widgets/contentHash'
import type { InlineWidgetReference } from '../../src/features/widgets/types'

// This fixture measures the production renderer with immutable synthetic data;
// it does not substitute for Provider, Gateway or native acceptance.
const source = '<div id="savings" data-kcoder-recipe="compound-interest"><script type="application/json" data-kcoder-config>{"principal":560000,"annualRate":8.5,"years":7}</script></div>'
const bytes = new TextEncoder().encode(source)
const hash = await widgetContentSha256(bytes)
const widgets: InlineWidgetReference[] = Array.from({ length: 100 }, (_, index) => ({
  widgetId: `performance-widget-${index}`, threadId: 'performance-thread', turnId: `performance-turn-${index}`,
  attemptId: 'performance-attempt', toolCallId: `performance-call-${index}`, revision: 1,
  title: `Performance widget ${index}`, summary: 'Independent compound-interest calculation',
  format: 'html', executionMode: 'managed', libraries: [], sha256: hash, bytes: bytes.byteLength,
}))
const loadContent = async () => source

export function WidgetPerformanceFixture() {
  const [delta, setDelta] = useState(0)
  const prefix = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 60">${Array.from({length:delta},(_,index)=>`<circle cx="${index*5}" cy="30" r="2"/>`).join('')}`
  return (
    <main data-testid="widget-performance" className="mx-auto max-w-3xl px-5">
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-surface py-3">
        <button data-testid="performance-delta" className="rounded-md border border-border px-3 py-1" onClick={() => setDelta(value => value + 1)}>Next actual prefix</button>
        <output data-testid="performance-delta-count">{delta}</output>
        <input data-testid="performance-composer" aria-label="Draft preserved during updates" className="rounded-md border border-border px-3 py-1" defaultValue="Draft stays editable" />
      </header>
      <WidgetStreamPreview title="Incremental source" summary="Only received SVG elements" source={prefix} format="svg" receivedBytes={new TextEncoder().encode(prefix).byteLength} />
      {widgets.map(widget => (
        <section key={widget.widgetId} data-testid={`performance-item-${widget.widgetId}`} className="relative my-4 min-h-96">
          <InlineWidgetHost widget={widget} panelId="performance-panel" loadContent={loadContent} />
        </section>
      ))}
    </main>
  )
}
