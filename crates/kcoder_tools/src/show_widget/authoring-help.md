Render or read an inline visualization for KWorker in Studio. This tool is unavailable in CLI/TUI. It stores a private widget revision, not a project file. It does not install services, authorize accounts, or verify mathematical correctness.

## Choose one action

- `action:"render"` (default): require `title`, `summary`, and complete `widget_code`. Optional render fields are `format` (`html` default, or `svg`), `execution_mode` (`managed` default, or explicitly authorized `isolated_html`), and `libraries`. For a new widget omit `widget_id` and `expected_revision`. For an update supply BOTH actual returned `widget_id` and its current `expected_revision`. Do not send read fields.
- `action:"read"`: supply exactly one selector: `widget_id`, OR the original `lookup_tool_call_id`. With `widget_id`, omit `expected_revision` for latest or specify it for an immutable historical revision. With `lookup_tool_call_id`, omit `expected_revision`; optionally supply the actual `lookup_attempt_id` to disambiguate reused IDs. Optional `include_source:true` returns at most 64 KiB of builtin source and a truncation flag. MCP App HTML remains UI-only. Omit ALL render fields, including title, source, format, execution mode and libraries.
- Never invent an ID, revision, attempt or tool-call ID. A lookup tool-call ID is the original provider tool call, not a path, conversation ID or JSON-RPC request ID. No `open`, `expand`, `focus`, `scroll`, `config` or `series` tool argument exists.

## IDs must come from real receipts

NEVER use placeholder IDs, demo IDs, ellipses, temporary IDs, or fabricated IDs in tool arguments OR final-answer widget references. New renders MUST omit `widget_id` and `expected_revision`; the host allocates them. For reads, updates and final references, copy the exact ID and revision from the actual successful receipt. Never reuse an unrelated widget's identity. If the result was lost, recover it using the real original provider tool-call ID; if no real selector is known, do not issue a guessed read/update or emit a widget reference.

These rules govern host-assigned widget/receipt selectors and final references. Ordinary HTML/SVG element IDs remain local identifiers defined consistently within `widget_code`.

## Source and libraries

`widget_code` is the original HTML/SVG string. Escape its quotes and newlines ONCE when serializing the outer tool-argument JSON. Do not JSON-stringify the markup first, wrap it in another JSON object/string, or include Markdown code fences inside it. Examples below are complete argument objects; their displayed backslashes belong to the outer JSON encoding only.

Limits are UTF-8 bytes: nonblank `title` at most 256, nonblank plain-text `summary` at most 4096, and `widget_code` from 1 byte to 1 MiB (1048576). Aggregate large data instead of exceeding the source or rendering budgets. The final rendered DOM is bounded to 4000 nodes.

`libraries` accepts only `chart_js`, `d3`, `topojson` (at most three entries). Use `chart_js` for charts, both `d3` and `topojson` for maps, and omit libraries for plain SVG/static HTML or the compound-interest recipe. No arbitrary plugin, controller, CDN or date-adapter library can be loaded.

Managed mode accepts passive SVG/static HTML plus the declarations below. Do NOT write `new Chart(...)`, executable `<script>`, inline event handlers, network fetches, external CSS/resources or frames. Managed chart/config/map scripts must have `type="application/json"` and the exact corresponding `data-kcoder-*` marker. Interactive form controls come from registered recipes; arbitrary managed HTML controls/JavaScript are not supported. Custom HTML/JavaScript is a separate `isolated_html` capability, enabled only when the current host explicitly authorizes it; choosing that argument cannot grant authorization.

For a diagram, use actual SVG markup with `format:"svg"` and useful title/description. A `data-kcoder-prompt="follow-up question"` on a node can append a visible follow-up draft; it never sends automatically. Ordinary SVG needs no chart library.

## Managed Chart.js 4.5.1

Put the RAW Chart.js configuration object in `<script type="application/json" data-kcoder-chart>...</script>` and use `libraries:["chart_js"]`. Do not nest it under `config`, `chart`, `spec` or `series`. Keep `options` inside the configuration. Strings naming functions are not executable callbacks.

For managed charts, prefer only the complete `data-kcoder-chart` declaration and let the host create and bind the canvas. Do not put the JSON on a `<canvas>` element or write `new Chart(...)` in managed source. `options.plugins:false` is a valid choice when plugin UI is unnecessary.

- Exact core `type` values: `bar`, `line`, `pie`, `doughnut`, `scatter`, `radar`, `bubble`, `polarArea`. Case matters.
- A dataset inherits the top-level `type` unless it supplies its own supported `type`. For dataset-only mixed charts, omit top-level `type` and explicitly type EVERY dataset. Do not insert a guessed default type to hide missing or invalid types.
- `mixed`, `stacked` and `area` are not independent types. Combine dataset types for mixed charts. Use `bar`/`line` with `options.scales.<axis>.stacked:true` for stacking; `line` with dataset `fill:true` for area; `bar` with `options.indexAxis:"y"` instead of obsolete `horizontalBar`.
- `data` is an object, `data.datasets` is an array of dataset objects, and each dataset's `data` is an array. Dataset object maps and numeric strings as standalone points are not this managed contract. Array points may be finite numbers, `null` for a skipped value, valid Chart.js tuples, or object points/custom parsed objects. Preserve legitimate strings in category coordinates/custom fields; do not coerce everything to numbers. All numeric members, including nested ones, must be finite.
- At most 32 datasets and 10000 total data-array entries PER CHART; at most 8 chart declarations per widget. These are distinct from the overall 1 MiB source and 4000 rendered-node budgets. Do not misreport them as one global point limit.
- Core plugins/controllers only. No date adapter is bundled: `time`/`timeseries` axes are not available by default. Use date strings as category labels or numeric values on linear axes when suitable.
- Dual axes use explicit dataset `yAxisID` and matching `options.scales` IDs. Label axes/units and missing values. The host owns responsive sizing, uses a bounded canvas, and disables Chart.js animation (`responsive:true`, `maintainAspectRatio:false`, `animation:false`) in the runtime copy. Storage keeps your original source.

Only an explicitly authorized `isolated_html` host permits your own chart JavaScript. Request `libraries:["chart_js"]`, append the canvas to the document and establish a nonzero container size before constructing and binding `new Chart(canvas, config)`. After a hidden tab or collapsed container becomes visible, resize the existing chart. Disabling the initial chart animation can make readiness easier to confirm; animation is not universally forbidden in isolated mode. Check the actual canvas dimensions and Chart.js canvas binding in that live document rather than treating a previously saved read status as a new size/binding check.

Minimal bar example (sample counts):

```json
{"action":"render","title":"Sample counts","summary":"Sample counts are 10 for A and 12 for B.","format":"html","libraries":["chart_js"],"widget_code":"<script type=\"application/json\" data-kcoder-chart>{\"type\":\"bar\",\"data\":{\"labels\":[\"A\",\"B\"],\"datasets\":[{\"label\":\"Count\",\"data\":[10,12]}]}}</script>"}
```

Valid dataset-only mixed example, deliberately with NO top-level `type` (both series use counts):

```json
{"action":"render","title":"Sample actual and target counts","summary":"Sample actual counts are 10 and 12; target counts are 11 and 14.","format":"html","libraries":["chart_js"],"widget_code":"<script type=\"application/json\" data-kcoder-chart>{\"data\":{\"labels\":[\"A\",\"B\"],\"datasets\":[{\"type\":\"bar\",\"label\":\"Actual\",\"data\":[10,12]},{\"type\":\"line\",\"label\":\"Target\",\"data\":[11,14]}]}}</script>"}
```

## Registered interaction and maps

The compound-interest recipe takes a JSON OBJECT in an inert `data-kcoder-config` script inside `<div data-kcoder-recipe="compound-interest">`. `annualRate` is a percentage (8.5 means 8.5%, not 0.085). `principal` is finite in [0,10000000], `annualRate` in [-100,100], and `years` is an integer in [0,100]. `currency`, when supplied, is a three-uppercase-letter code. Verify arithmetic independently; committing/rendering does not verify a calculation.

```json
{"action":"render","title":"Compound-interest example","summary":"Adjust the sample principal, annual rate and years to inspect the calculation.","format":"html","widget_code":"<div id=\"savings\" data-kcoder-recipe=\"compound-interest\"><script type=\"application/json\" data-kcoder-config>{\"principal\":560000,\"annualRate\":8.5,\"years\":7,\"currency\":\"CNY\"}</script></div>"}
```

Maps use `<script type="application/json" data-kcoder-map>{"values":{"156":10},"unit":"sample units"}</script>` with `libraries:["d3","topojson"]`. The host supplies verified world topology; `values` is an object keyed by ISO 3166-1 numeric country codes present in that topology; each value must be a finite JSON number. Prefer three-digit string keys: Brazil `"076"`, Australia `"036"`, China `"156"`. Compact keys `"76"` and `"36"` are also accepted and padded by the host. Use one key per country; supplying both `"36"` and `"036"` is an error. Alpha codes (`"BR"`/`"AU"`), arbitrary IDs and countries absent from the bundled 110m topology are rejected with the offending `/values/<key>` pointer. Omit missing data; do not remove valid countries to work around a formatting error. Optional `markers` is an array of at most 100 `{label,longitude,latitude}` objects: label 1..80 characters, finite longitude [-180,180], finite latitude [-90,90]. Use supplied or verified coordinates; never invent boundaries or locations. At most two map declarations and four registered recipes fit in one widget.

## Final presentation, validation and recovery

During the tool call and intermediate generation, Studio shows only compact status: no visible SVG, canvas, image or frame is expanded. Studio displays the saved visualization only in the final successful completed reply. Invisible read-only render verification may run before completion. Presentation/expansion and page scrolling belong to Studio, not tool arguments or model JavaScript. Do not attempt to open the processing area, autofocus a component or move the parent viewport. In the FINAL answer, insert the saved reference on its own line among the explanation:

Construct the reference from the literal prefix `::kcoder-widget{widget_id=`, the JSON-quoted `widget_id` from the successful receipt, the literal ` revision=`, that receipt's numeric `revision`, and the closing `}`. Do not output an unfinished marker or substitute placeholder values.

Copy BOTH ID and revision from the actual receipt. Do not put a working reference in a Markdown fence, reprint the source as the final deliverable, or create another widget merely to show the same result. The accessible summary must remain useful when rendering is unavailable.

Validate sources, labels, units, calculations and Chart.js data structure independently. A committed receipt proves durable storage, not correctness, rendering readiness, user review or a completed external action. `rendered` is a bounded client rendering observation for that exact widget revision; it does not prove the user saw it, that it remains visible now, or that its data/calculations are correct. Non-visible read-only verification can also produce this observation.

`action:"read"` returns saved metadata, not a new visual inspection. Its `status:"recorded"` describes storage. Optional `render_observation` contains the last accepted observation for the selected revision: `status` (`rendered` or `failed`), `errorCode` and `observedAtMs`. The timestamp is when the server stored that changed observation; duplicate identical receipts retain the prior timestamp. There are no pixel, current-visibility or user-review fields. `errorCode:null` is not proof of a healthy current canvas. An initial `unconfirmed` feedback can later be followed by a valid delayed ready observation for the same revision. Describe this as an updated stored observation, not as a fresh recheck merely because read now returns `rendered`.

Missing observations, an unavailable/offscreen client, a pending container/binding, or a zero-size/unbound canvas do not establish a usable rendering and do not by themselves establish bad source. Keep these situations unconfirmed/pending according to actual host feedback; do not claim success or regenerate to manufacture a receipt. Distinguish them from a confirmed source/schema failure carrying an actual reason and pointer. Fix source only when that evidence supports it; host readiness, resource-loading or lifecycle problems require the corresponding host recovery, not guessed chart data changes.

For errors, follow the actual reason and JSON pointer: unsupported type, missing effective type, invalid root/data/dataset or an exceeded quota require different corrections. Do not guess, coerce a malformed object into an array, unwrap arbitrary wrappers, insert invented values or cast all custom point fields. When a failed first-frame observation has `repair_allowed:true`, update only that affected `widget_id` with its current `expected_revision`, at most twice in the current task; retain old revisions and failure history. Do not repair the wrong ID or regenerate an unrelated successful component. Do not create a replacement widget to reset an exhausted repair budget. Render observations retain bounded cause codes such as `invalid_widget_unknown_country_id_999`; `resource_blocked` is a distinct resource failure. An `invalid_widget` data/ID error must be corrected using its reason and pointer; do not infer a topology loading failure from a generic `render_failed` status.

On a revision conflict, first read latest metadata with `widget_id` and no revision, inspect the returned revision/source, then perform a justified update. After an interrupted/unknown render call, READ the original receipt before retrying. `include_source:true` may be truncated: check the returned flag. Never replay external actions to recreate a view.

For read-by-widget recovery, set `action` to `read`, set `widget_id` to the exact saved receipt ID, and optionally set `include_source` to true. For lost-result recovery, set `action` to `read` and `lookup_tool_call_id` to the real original provider call ID; add `lookup_attempt_id` only when its actual value is known. These identities are runtime data, so no copyable placeholder-ID JSON is provided.
