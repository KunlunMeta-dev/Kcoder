---
name: kworker-visualization
description: "Create inline diagrams, charts, maps and adjustable explanations for KWorker in Studio when a visual helps the user's office or research task. 在 Studio 的 KWorker 中制作会话内图示、图表、地图与交互演示。"
license: MIT
metadata:
  kcoder:
    category: visualization
    tags: [charts, diagrams, maps, office, 图表, 可视化]
    requires_tools: [show_widget]
---

# Inline visualization in KWorker

Use this workflow only when `show_widget` is attached to the current request. It is a Studio presentation capability, not a CLI/TUI file preview. Its presence does not install office dependencies, authorize a service, or grant desktop/network access.

Use a visual when it makes relationships, comparisons, trends or adjustable scenarios easier to understand. Keep simple answers simple. Respect the user's requested format: a downloadable report, image, presentation or website still needs the corresponding real artifact workflow, with whatever tools and dependencies are actually available.

## Choose a supported form

- **Diagram or illustration:** SVG with a meaningful `title`/`desc`, readable labels and sufficient contrast. Use shapes or line patterns as well as color. CSS animation must respect reduced motion.
- **Chart:** a managed Chart.js 4.5.1 JSON declaration, with `libraries: ["chart_js"]`. Exact core types are `bar`, `line`, `pie`, `doughnut`, `scatter`, `radar`, `bubble`, `polarArea`. Label axes and units, explain missing values, and distinguish samples from measured data. Mixed and stacked charts are configurations of these types, not extra type names.
- **Map:** a JSON map declaration with `libraries: ["d3", "topojson"]`. The host supplies real Natural Earth topology. Country IDs are ISO numeric codes present in that topology: prefer three-digit string keys, including Brazil `"076"` and Australia `"036"`; compact `"76"`/`"36"` are padded by the host. Values must be finite JSON numbers, with one key per country; duplicate padded/compact aliases and alpha codes are rejected. Follow `/values/<key>` errors and preserve valid country data. Optional `markers` contain at most 100 `{label, longitude, latitude}` objects: a nonempty label of at most 80 characters, finite longitude in [-180, 180] and latitude in [-90, 90]. Use supplied or verified coordinates; do not invent borders or positions. The host provides a value/missing-data legend, keyboard/button zoom and reset.
- **Adjustable explanation:** use the registered compound-interest recipe where it fits. It calculates locally and does not send another model request for every slider change.
- **Prototype:** inert HTML/CSS for the layout, or supported managed declarations for interaction. Managed mode cannot run arbitrary model JavaScript, event-handler attributes, frames, forms or network resources. Use `data-kcoder-prompt` for a visible follow-up action; the host appends it to the user's draft and never sends automatically.

Use the current tool contract for any additional supported recipe. Arbitrary HTML/JS requires an explicitly available isolated host and its permission path; do not silently downgrade an executable design or describe a static mockup as functional. CDN scripts and direct external fetches are not part of the managed host.

## Render and reference

Call `show_widget` with `action: "render"` (the default), an accurate short `title`, a plain-text `summary`, complete `widget_code`, and the appropriate `format` (`html` or `svg`). Add only the local library IDs needed by the declaration. Pass markup as the `widget_code` JSON string; do not write an extra project file for an inline view.

`widget_code` is original markup: serialize it once as a string in the outer argument object. Do not first JSON-stringify the markup, wrap it as an object, or put Markdown fences inside it. The tool description includes complete argument examples; the snippets below are the markup contents of this one field. `render` and `read` have separate fields: read calls omit title, markup, summary, format, execution mode and libraries; render calls omit lookup IDs and `include_source`. No tool argument opens/expands a processing area or controls page scrolling; Studio owns visibility and final presentation.

The source limit is 1 MiB. Aggregate large datasets, keep the figure focused, and put detailed explanations and source links in the surrounding response. The summary must remain useful if the client cannot display the component. Financial conventions and currency units follow the user's context; for Chinese market examples use red for gains and green for losses, with signs or other non-color cues.

For charts, use the raw configuration object inside the inert declaration, never a `config`, `chart`, `spec` or `series` wrapper. `data.datasets` and every dataset's `data` are arrays. Standalone points are finite numbers or null skips; valid tuple/object/custom parsed points retain their structure and category strings, with finite numeric members at every depth. Do not coerce arbitrary strings/objects to numbers. The limits are 32 datasets and 10000 data-array entries **per chart**, with at most 8 charts and 4000 rendered DOM nodes **per widget**. No arbitrary plugin/controller or date adapter is bundled; use date category labels or numeric linear axes instead of assuming `time`/`timeseries` axes work. The host controls responsive sizing and disables chart animation in its runtime copy; original stored markup is retained.

Prefer a complete `data-kcoder-chart` JSON script alone in managed mode; the host creates and binds its canvas. Do not attach JSON to a canvas or write `new Chart(...)` there. `options.plugins:false` remains valid. Only a currently authorized `isolated_html` host permits custom chart scripts: request `chart_js`, mount the canvas and give its container nonzero dimensions before binding `new Chart(canvas, config)`. Resize the existing chart when a hidden tab or collapsed container opens. Initial animation may be disabled to simplify readiness; isolated mode does not forbid all animation. Inspect the live canvas dimensions and binding instead of using a saved `read` observation as a fresh check.

When there is no top-level `type`, every dataset must declare its own supported type. Otherwise datasets inherit the top-level type and may override it. `area` uses `line` plus dataset `fill:true`; `horizontalBar` is an obsolete alias, so use `bar` plus `options.indexAxis:"y"`; stacking uses `options.scales.<axis>.stacked:true`. Do not repair invalid or absent types by guessing a default.

Use only the exact ID and revision returned by a successful `show_widget` receipt. Never use placeholder IDs, demo IDs, ellipses, temporary IDs or fabricated values in tool arguments or final references. For a new render, omit `widget_id` and `expected_revision` entirely so the host allocates them. Reads and updates must use actual saved identities; after a lost result, recover with the real original provider tool-call ID. If no valid identity is known, do not guess or emit an unbound reference.

These rules govern host-assigned identities. HTML/SVG element IDs remain local identifiers defined consistently within `widget_code`.

In the final answer, assemble a reference on its own line from `::kcoder-widget{widget_id=`, the JSON-quoted returned `widget_id`, ` revision=`, the returned numeric revision, and `}`. No placeholder-ID reference is provided for copying. Do not put a working reference in a code fence or print the full HTML again. Several components may be interleaved with normal paragraphs in the final successful reply. Repeated references locate the existing component rather than requiring another render call.

During tool calls and intermediate generation, the client shows only compact status. No visible SVG, canvas, image or frame is expanded; the saved visualization appears only in the final successful completed reply. Invisible read-only render verification may run before completion. Do not attempt to expand the processing area or control page scrolling. Never simulate progress or claim a slider/diagram was tested merely because the source was committed.

## Local managed examples

These snippets are source for `widget_code`, not standalone files. Adapt the data and labels, and provide the matching title/summary in the tool call.

### Clickable SVG diagram

Use `format: "svg"`, with no extra libraries:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 140" role="img">
  <title>Source to answer</title><desc>Reviewed sources support a concise answer.</desc>
  <g data-kcoder-prompt="Explain how these sources were checked" aria-label="Reviewed sources">
    <rect x="16" y="30" width="170" height="70" rx="12" fill="none" stroke="currentColor"/>
    <text x="101" y="72" text-anchor="middle" fill="currentColor">Reviewed sources</text>
  </g>
  <path d="M190 65H280" fill="none" stroke="currentColor"/>
  <rect x="286" y="30" width="170" height="70" rx="12" fill="none" stroke="currentColor"/>
  <text x="371" y="72" text-anchor="middle" fill="currentColor">Answer</text>
</svg>
```

### Mixed quarterly chart

Use `format: "html"` and `libraries: ["chart_js"]`. These are explicitly sample data:

```html
<script type="application/json" data-kcoder-chart aria-label="Sample quarterly revenue and year-on-year growth">
{"type":"bar","data":{"labels":["Q1","Q2","Q3","Q4"],"datasets":[{"label":"Revenue (10,000 CNY)","data":[128,156,142,189],"backgroundColor":"#3589df","yAxisID":"revenue","order":2},{"type":"line","label":"Year-on-year growth (%)","data":[8,21,-9,33],"borderColor":"#e84a4a","borderDash":[6,4],"pointStyle":"rect","yAxisID":"growth","order":1}]},"options":{"scales":{"revenue":{"position":"left","beginAtZero":true,"title":{"display":true,"text":"Revenue (10,000 CNY)"}},"growth":{"position":"right","min":-10,"max":35,"grid":{"drawOnChartArea":false},"title":{"display":true,"text":"Growth (%)"}}}}}
</script>
```

This second mixed form is equally valid and deliberately has no top-level type; every dataset declares its type:

```html
<script type="application/json" data-kcoder-chart>
{"data":{"labels":["A","B"],"datasets":[{"type":"bar","label":"Actual count","data":[10,12]},{"type":"line","label":"Target count","data":[11,14]}]}}
</script>
```

### Compound-interest calculator

Use `format: "html"`, with no extra libraries:

```html
<div id="savings" data-kcoder-recipe="compound-interest">
  <script type="application/json" data-kcoder-config>{"principal":560000,"annualRate":8.5,"years":7,"currency":"CNY"}</script>
</div>
```

The annual rate is a percentage, not a fraction. Independently check `principal × (1 + annualRate / 100) ** years`: these initial values give approximately 991,279.66 CNY total and 431,279.66 CNY earnings. Check a zero-year or zero-rate control when changing the recipe. Negative returns require both a negative sign and the appropriate loss styling.

### Real-topology map

Use `format: "html"` and `libraries: ["d3", "topojson"]`:

```html
<script type="application/json" data-kcoder-map>{"values":{"156":10,"840":20},"unit":"sample units"}</script>
```

The values are samples for China and the United States; other countries have no data. Explain the source, unit and missing-data treatment in the surrounding prose. Use a different visualization if the host's geographic granularity cannot represent the user's data accurately.

## Verification and recovery

Check numbers, units, labels, branches and sources independently of schema validity. Use a lightweight available calculation tool for uncertain arithmetic; use the renderer's actual observations when available for display failures. A committed receipt proves storage, not mathematical correctness, rendering readiness or user review. `rendered` is only a bounded client observation for the exact revision, including possible non-visible verification; it does not prove the user saw the result, that it is still visible, or that the data is correct.

Updates require the returned `widget_id` and current `expected_revision`; old revisions remain readable. After a conflict, use `action: "read"` with `widget_id` and omit `expected_revision` to read the latest metadata. Specify `expected_revision` to inspect that historical revision.

After an interrupted/unknown call, reconcile it using `action: "read"` with the original `lookup_tool_call_id`; include `lookup_attempt_id` when needed to disambiguate. Do not guess private session paths or replay a render simply because its result was not recorded. Read returns metadata by default; `include_source: true` returns at most 64 KiB of built-in source and reports truncation. It never exposes UI-only MCP App HTML to the model.

For a chart failure, follow the reason and JSON pointer: an unsupported type, missing effective type, malformed dataset or quota overflow need different corrections. Keep valid numeric/null/tuple/object values intact; do not unwrap unknown schemas, cast all custom fields or invent missing values. A revision conflict requires reading latest metadata before an update. The read selectors `widget_id` and `lookup_tool_call_id` are mutually exclusive; `expected_revision` is meaningful only with `widget_id`, and `lookup_attempt_id` only with `lookup_tool_call_id`.

The active turn waits at most three seconds for a first-frame observation. `action:"read"` retrieves the last accepted saved observation, not a new visual inspection: `render_observation` has `status` (`rendered`/`failed`), `errorCode` and the server's recording time `observedAtMs`. An identical duplicate receipt retains its timestamp. `status:"recorded"` only confirms stored metadata, and `errorCode:null` alone does not verify a current canvas. Failure codes preserve their category and structured reason; for example `invalid_widget_unknown_country_id_999` identifies country code `999`, while `resource_blocked` denotes an unavailable resource. Missing feedback is unconfirmed; a valid delayed ready receipt may update that same revision later. Report the updated observation honestly without claiming that reading it rechecked the view.

A pending chart container/binding, zero-size/unbound canvas, or unavailable/offscreen client is not evidence of a usable rendering or a defective source. Do not regenerate merely because it is unconfirmed. Follow the actual host/resource recovery for readiness problems. For a confirmed source failure with a reason and pointer, update only the affected ID with its current revision when `repair_allowed` is true. At most two automatic repairs are allowed per task; preserve failure history and the accessible summary after that budget. Do not create a replacement widget to reset that budget. An `invalid_widget` country-ID/data error is not evidence of a topology/resource loading failure; follow its exact reason and pointer. Do not turn missing permissions, unavailable native isolation, incorrect data or unknown external effects into a claimed pass. Explain any remaining limitation briefly and give the user the usable result or the next concrete recovery action.
