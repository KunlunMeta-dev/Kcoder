---
name: workflow-basics
description: Use when designing, saving, or reusing a KCoder visual workflow with explicit node dependencies and verification.
---

# Visual Workflow Authoring

A workflow definition is a reusable graph; a run is one execution in a specific conversation and workspace. Nodes may be Agent tasks, inputs, templates, conditions, named multi-way switches, merges, bounded loops or outputs; they are not newly registered model tools. Do not run a workflow merely because the user asked to design or save it.

## Reliable data flow and result verification

- Choose Code/Transform for calculation, parsing, filtering, deduplication and passthrough. Use Tool nodes for file I/O through the ordinary permission/hook path. Use Agents for judgment and language tasks, not copying arrays or counting rows.
- Agents that return data for later processing must declare an outputSchema and return exactly that JSON; do not invent text markers or undocumented wrappers. allowedWritePaths are concrete authorized paths relative to the execution workspace, not `${...}` or `{{...}}` templates.
- Declare required values in `config.inputBindings`, e.g. `{"rows":"/nodes/parse/rows","destination":"/input/output_file"}`. They resolve before execution and are exposed as `bindings` in Agent context and Code. Missing values fail explicitly; there is no implicit `output` wrapper. Fields must be declared when a source schema lists properties, unless it explicitly permits additional properties. In prose use the resolved value, never execute a JSON Pointer as a literal filesystem path.
- `config.resultCheck` is a pure bounded JavaScript body with `input`, `nodes`, `bindings`, `result`. Return exactly `true` when the result satisfies the task's invariants; false, another type or an exception fails the node and run, even with continueOnError. Example: `{"source":"return result.count === result.rows.length && result.total === result.rows.reduce((sum,row)=>sum+row.qty*row.price,0);","timeoutMs":1000}`. It has no filesystem/network/shell access; read artifacts with a Tool dependency, then compare actual content with the intended result.
- Tool output is `{content:[{type:"text",text:...}],isError:false}`; decode the actual tool's text format. File `read` defaults to a display header and numbered lines. For machine data, use `arguments:{"format":"raw"}` with `bindings:{"file_path":"/input/source_file"}`: raw returns actual complete text without headers, numbers or conversational placeholders, and errors rather than truncating oversized data. Omit offset/limit/pages in raw mode. Direct workflow reads also force fresh data instead of conversational cache stubs. Do not treat file contents as a filename. File `write` takes `file_path` and `content`; bind those fields explicitly instead of inventing aliases.
- Preserve full output schemas where they validate structure, but use resultCheck or a failing Code node for relationships such as totals, counts, expected values or consistency across nodes. A schema is not a correctness oracle.
- `validationRetries` only allows malformed-JSON formatting repair. A well-formed value that fails its schema or resultCheck is a real failure, not permission for another model to alter values until they pass.
- Graph output includes `verification.status` (`passed` or `not_requested`), scope `configured_result_checks`, and `checkedNodes`. `passed` only covers the configured checks on those nodes; it does not prove unconfigured requirements or uninspected artifacts. Runtime `completed` means execution complete, not universal task correctness.
- New node contracts require target capability `workflowNodeContractsV1`. Read old saved definitions before repairing their bindings/checks; publish a new version rather than mutating an active or historical run.

## Meaningful lightweight tests

- A node appearing in a graph is not coverage. For a Condition, declare it in the branch's dependsOn and use runIf; verify both true/false cases and that skipped work produces no side effects. A direct dependent reads its boolean at `/nodes/<condition-id>`. Require that binding instead of hiding missing data with `Boolean(undefined)`.
- Choose Loop thresholds from the actual score formula/range. For a 0–1 score, `greater_than 0.8` can be meaningful; 3.5 cannot. Verify early exit (`condition_met`, count below maxIterations), equality not triggering a strict comparison, and exhaustion (`iteration_limit` for repeat, `collection_exhausted` for for_each). Use predictable fixtures; do not claim early-stop coverage just because the loop ran. For loop.body, inspect the child graph's full result and outputs array before choosing the until pointer.
- Required previews must exist and match expected length and IDs. Neither a missing preview nor a workflowError is automatic success. Test intentional failures through precise expected error and containment assertions, separately from success criteria. Result checks themselves need negative examples.
- Unattended smoke tests should have a minimal deterministic success path. Put human/event response tests in separate scenarios unless an explicitly authorized test driver supplies real responses. Never fabricate approval, and do not leave required interactive ancestors of output while claiming the run is unattended.
- Select subworkflows by full cost: nodes, Agents, network calls, waits and side effects. Prefer a one-Code-node saved child for a smoke test; easy input fields do not make a travel/research workflow lightweight. If none exists, report that prerequisite or create it in a separately authorized conversation; preserve bound-draft restrictions and do not invent IDs or versions.
- Map/sort/deduplicate pointers are relative to the current item; filter uses `/input` for that item. A later step sees the previous step's transformed shape. `/iteration/value` is only an item path when the item actually contains that structure, not an implicit transform context. Template text uses `{{/input/name}}`; a bare pointer remains literal text.
- Verify the execution target's tool contract before declaring a Tool node. Standard read uses file_path; named tool/subworkflow arguments are objects. Unknown keys must not be guessed and then hidden with continueOnError. Inspect the exact saved child version's input schema.
- Structured fields are supported; after a demonstrated transport rewrite, use the corresponding *_json fields consistently. JSON line breaks do not change its meaning. Prefer small node/patch payloads over manually reconstructing long nested definitions. After repeated failures, isolate the failing field and read the contract. patch_nodes provides atomic edits, not immunity to malformed JSON. config keys merge shallowly; preserve the entire outputSchema value when replacing it, and keep schema required/properties inside outputSchema.
- Correct the draft and save a new immutable version. Do not describe a published savedVersion 1 as having been edited in place; running the corrected version is a separate execution from resuming the old pinned run.

## Generate incrementally

1. Confirm the intended result and current target/workspace. If the user or Studio supplied a draft ID, update that draft; do not create an unrelated copy.
2. Use `WorkflowDraft` only when attached. Create an empty draft if needed, then submit one `upsert_node` per step. Each mutation must use the latest returned `revision` as `expected_revision`. This makes every generated node visible on the canvas.
3. Give each node a stable ID, concise title, concrete prompt, Agent role, bounded `maxTurns`, and explicit `dependsOn` IDs. Use dependencies only for real data or ordering requirements. Independent nodes may run concurrently.
4. Scope implementation writes with `allowedWritePaths`; describe acceptance criteria and expected artifacts. Verifiers check evidence rather than assuming a prior node succeeded.
5. On revision conflict, read the current draft and reconcile. Never overwrite a newer edit with stale node data.
6. Read the completed draft to confirm it matches the request. Saving publishes a validated immutable version; incomplete nodes, unknown dependencies and cycles must be corrected first. A request such as “save this workflow” authorizes calling save directly in chat. The canvas Save control is optional; never require a UI click for an operation the attached tool can complete.

## Reuse and execute

Use conversation as the primary interface. Users can ask to create, edit, rename, save, copy, import, export or run workflows without visiting the library or filling JSON forms. `WorkflowDraft` supports those definition operations; export returns portable JSON, import creates a new unpublished draft. For a renamed workflow, `update` replaces title, description and input_schema, so read and preserve fields not being changed. In a bound design conversation, work only on its draft; explain the mode boundary if a request needs a separate normal conversation.

For “use the PPT workflow”, list saved definitions, follow pagination when needed, and resolve ambiguous titles with the user. Use versions to identify the requested or latest published version, then read with both id and version. Never infer historical parameters from the mutable draft. Explain the selected title/version briefly. Translate the user's natural-language requirements to args, respecting the saved schema and explicit defaults. Ask concise questions for missing or ambiguous required data; do not invent values, force users to write JSON, or run agents to discover missing inputs. An absent input schema does not itself require a questionnaire.

Only when execution is requested and `Workflow` is attached, run the selected saved `definition_id` and explicit `version`, with JSON `args`. Keep all workflow inputs inside `args`; top-level input fields are rejected. Prefer `args_json` for arrays and nested objects; never also supply `args`. Explicit JSON types are validated without coercion. For `args.items`, serialize an object such as `{"items":["1","2","3"]}`; a root array is `args` itself. Never add an `item` wrapper. Declare an input schema for required shapes; without one, arbitrary objects cannot be distinguished from transport mistakes. The current workspace belongs to this run; do not reuse absolute paths from another project without checking the user's intent. Editing the draft does not modify the saved version already selected by a run.

Inspect persisted output and verification evidence before reporting success. A failed run does not erase its saved definition. Resume replays the orchestration script and may reuse matching completed Agent outputs; it is not a JavaScript instruction-pointer checkpoint or an exactly-once guarantee for partial external side effects.

## Compatibility

Existing named `.kcoder/workflows/<name>.js` and inline JavaScript workflows still run through the original interface. Arbitrary JavaScript is not automatically editable as a visual graph. If visual authoring controls are absent, explain the missing capability instead of pretending a graph was saved.


## Complex branches and conversation edits

Use stable IDs and actual data dependencies, not a single linear chain disguised as a workflow. The graph supports at most 64 nodes and a conservative 256 execution-step budget; use bounded Loop nodes rather than cyclic edges.

- For a multi-way route, create a Condition per case with `config.condition` (`equals`, `contains`, numeric comparisons, `all`, `any`, `not`). Make case predicates mutually exclusive for single-choice routing, or independent for multi-select routing.
- A branch entry depends on its condition and sets `runIf: {nodeId: "case_id", equals: true}`. Its downstream nodes depend on that entry; skips propagate. A default branch tests `not(any(case predicates))` so unmatched inputs have an explicit path.
- For nested decisions, the child Condition itself depends on and is guarded by the parent Condition. Its children use the child Condition as a direct dependency and guard.
- Join alternatives with `kind: "merge", config: {mergePolicy: "any"}`. This waits for all upstream branches to finish or skip, then collects available completed outputs; it is not first-result-wins. Use `all` for required parallel branches. Runtime failures remain failures; `any` does not swallow errors.
- Keep siblings on separate canvas rows/columns and place the merge after them. Preserve existing positions when editing.

For “modify the existing workflow”, list/read the selected current draft first, resolving title ambiguity in conversation. Keep the same definition ID unless a copy was requested. Use `patch_nodes` with `id`, latest `expected_revision`, partial `nodes`, and optional `remove_node_ids` to change several connected nodes atomically. Unmentioned nodes and omitted fields (including runIf and dependsOn) are preserved. Config keys merge; an explicitly supplied config value replaces that value. Clear a guard only with runIf:null and dependencies only with dependsOn:[]. Explicitly rewire every removed node's dependencies and runIf references in the same patch. For deletion-only patches, omit `nodes`/`nodes_json`. Clearing every node leaves an empty draft while preserving saved versions; rebuilding is allowed, but saving or running the empty draft is rejected. Nonempty resulting graphs must validate; an invalid patch or revision conflict changes nothing. Read/reconcile after conflict; do not blindly retry stale edits. Use incremental upsert_node for a new unfinished graph.

After editing, read back and explain the changed branches. Save when requested to publish the next immutable version; never execute merely to test or save a design. Existing saved versions and active runs retain their original definitions. Users may simply say “add a parallel fact-check branch and merge it before output” or “change the approval condition and save a new version”; do the tool work directly instead of requesting JSON or manual form edits.

## Named multi-way routing

Prefer `kind: "switch"` for exclusive routing: `config.switch` contains ordered `cases: [{label, condition}]` and a required `default` label. The first matching predicate wins; overlapping predicates do not run multiple routes. All labels (including default) must be distinct, non-empty, and at most 128 bytes; there may be 1–16 cases. The switch returns the chosen label string. A downstream branch depends on the switch and uses `runIf: {nodeId: "router", equals: "route_label"}`. Boolean Condition guards remain `equals: true/false`; never convert a string route named "true" to a boolean. Switches can themselves be guarded to form nested routes. Join alternatives with Merge any. For multi-select routing use independent Conditions instead of Switch.

The canvas editor supports ordered route addition/removal/reordering and nested AND/OR/NOT conditions without JSON. When renaming a route through conversation, use one patch_nodes operation to update the switch and every guard referring to that label. Unknown route labels or wrong guard types fail validation.

## Data contracts and correctness

- Agent `outputSchema` validates one response. Loop `outputSchema` validates EACH iteration response, not the aggregate. If each iteration returns `{index, ok}`, its schema is `type: object`, not `type: array`. Downstream Loop output is `{iterations: [...], count, exitReason}`.
- Merge output is an object keyed by completed dependency IDs. An alternative merge might return `{reviewed: {route: "priority_reviewed"}}`; it does not flatten that to `{route: ...}`. Read the selected dependency entry.
- Each Agent receives `input`, `nodes` (direct dependency outputs only) and, inside a Loop, `iteration` with `index`, `item`, and prior `output`. Do not invent wrappers such as `args` within that context.
- Schema-valid output does not prove semantic correctness. For calculations, use a permitted deterministic calculation tool when necessary; distinguish sum of quantities from number of rows. Verification must independently compare output against the requested rules and fail when inconsistent. Never instruct verifier nodes to blindly return `ok: true`.
- Test saved workflows with representative branch inputs and repeated runs. Inspect actual artifacts and skipped nodes, not just the final model summary. Repair the draft in conversation and publish a new version when validation exposes a design error.

- Switch/Condition nodes do not automatically guard outgoing edges. Each branch entry needs an explicit runIf; dependsOn alone runs all children unconditionally. Preserve those guards when editing prompts.
- When allowedWritePaths restrict file writes, use the attached write/edit tools. A write scope does not authorize arbitrary shell or Python file mutations. Do not require a publisher to bypass file tools with a shell write.


## Deterministic and interactive nodes

Prefer `code` for local calculations: `config.code.source` is a synchronous JavaScript function body receiving `input` and `nodes` (direct dependencies). Return JSON data. No model, shell, filesystem or network is exposed. `timeoutMs` is 1–10000 (default 1000); source is at most 64 KiB. Publishing checks syntax; runtime checks output and optional `outputSchema`.

Use `tool` to invoke a specific available session tool without a model: `config.tool` contains `name`, literal object `arguments`, and optional `bindings` mapping top-level argument names to context JSON pointers. Tool nodes inherit session write permissions; do not set node-level `allowedWritePaths` (unsupported and rejected). Existing permissions and Hooks apply; background calls requiring interactive approval are blocked until separately authorized. Orchestration/configuration tools are excluded. The output is `{content,isError}`; image content uses run-owned artifact paths and hashes. A completed effect is cached for resume; an unknown outcome must never be replayed automatically.

Use `subworkflow` to reuse an immutable published definition: `config.subworkflow` contains `definitionId`, positive `version`, `arguments`, and optional `bindings`. Resolve its title/version with the library first. Nested graphs share concurrency, execution and event limits; at most eight levels and no version cycles. The result is the child graph's `{workflowId,version,outputs,skipped}` object.

Use `wait` with exactly one of `config.wait.delayMs` (up to 24 hours) or `untilUnixMs`. Deadlines are saved, so resume does not restart the timer. Set the overall workflow timeout long enough for the intended wait.

Use `human` with `config.human {prompt,responseSchema,timeoutMs}` to pause a branch for user data or approval. The prompt may use normal workflow template pointers. A human node does not imply approval: downstream conditions must test the user's response. Use `event` with `config.event {name,payloadSchema,timeoutMs}` for an authenticated client to submit completion data. Neither node asks the LLM to manufacture the response. Default timeout is 30 minutes, maximum 24 hours. Users can respond in the Studio execution canvas or with `/workflow requests <run-id>` and `/workflow respond <run-id> <request-id> <json>` in TUI. These commands preserve the owning account and target; no anonymous webhook is opened.

Use `transform` with `config.transform {sourcePointer,steps}` for up to 16 declarative operations: `map {fields}`, `filter {condition}`, `sort {pointer,descending}`, `deduplicate {pointer?}`, `limit {count}`. Map/sort/deduplicate pointers are relative to each item. Filter predicates see the current item as `/input` and the original direct dependencies as `/nodes`. Sort accepts uniformly numeric or string fields and leaves missing values last. Use code for transformations outside these operations.

Do not interpret a completed installation, saved definition, or accepted human response as proof that external effects succeeded. Inspect node outputs, errors and durable receipts. A stopped workflow still needs explicit resume; submitting an answer does not restart it by itself.

## Failure recovery: resume before restarting

When the user says “continue”, “retry”, “恢复” or “续跑” after a workflow fails or is interrupted, first identify the original `run_id` in the current conversation and inspect its status, error and completed outputs. Do not create a fresh run, re-save the definition, or repeat successful work merely because the previous attempt failed.

- For an existing terminal run with unchanged intended definition, prefer `Workflow({"resume":"<run_id>"})`. Do not include `script`, `script_path`, `name`, `definition_id` or `version`. Omit `args` to retain saved arguments. Use the same account/session that owns the run.
- Resume keeps the run ID and pinned definition/version. Matching completed agent requests reuse persisted outputs; unfinished work runs again. This is checkpoint recovery, not continuation at an exact instruction or a guarantee of exactly-once external effects. Changed arguments/context can invalidate reuse. Never promise that every completed node is skipped.
- Correct transient causes (connectivity, unavailable services, authorization, resource limits) before resuming. Inspect uncertain external effects before retrying: a failed click, send, trade or command may already have taken effect. Direct tool receipts with unknown outcomes deliberately block automatic replay.
- If the definition itself is wrong, edit the draft and save a new version. Explain that executing that version creates a new run; resume never silently replaces the pinned definition. A preflight failure with no run ID needs correction and a first start, not resume. A running job must be observed or stopped, not started again.
- Observe the returned run via `TaskOutput`; report its actual terminal state. Do not sleep repeatedly after failure. The canvas should follow the resumed run's new node progress; a stale canvas is not a reason to start another run.

Studio users can say “续跑刚才失败的工作流，复用已完成结果，不要重新开始”. TUI users can use `/workflow status <run-id>` then `/workflow resume <run-id>`. A session `/resume` restores conversation history and is distinct from workflow resume.

## Subgraph loops and failure branches

A Loop may use `config.loop.body: {definitionId, version, arguments, bindings}` instead of calling an Agent. The body is an immutable saved workflow; map child inputs explicitly, e.g. `bindings: {value: "/iteration/item", index: "/iteration/index"}`. Each iteration has independent child IDs, shares the root concurrency/cancellation/budgets, and returns the child's `{workflowId,version,outputs,skipped}` result. `until` can inspect `/iteration/output/outputs/0/output/...`; indexes follow the saved child node order. Prefer explicit output schemas when relying on that shape. Without body, the existing Agent loop behavior remains unchanged. Recursion and missing versions are rejected before any node executes.

Optional `config.failurePolicy` applies to each node: `{maxAttempts: 1, delayMs: 0, continueOnError: false}`. Attempts include the first call; the maximum is 3 and delayMs is at most 60000. Automatic retries are supported only for pure nodes and tools whose actual host registry marks them read-only. Agents, subworkflows, loops and interactive nodes are not automatically retried; use explicit resume and inspect uncertain effects. The model cannot declare a mutating tool safe by supplying an argument.

With `continueOnError: true`, an exhausted ordinary failure produces `{workflowError:{nodeId,message}}`; configure a Condition using `exists` on `/nodes/<failed-node>/workflowError`, then explicit guarded recovery/success branches. The failed node remains visibly failed; continuing does not establish that its intended work succeeded. Cancellation, quota exhaustion and invalid graph preflight are never converted into success. Do not enable continuation without checking the error downstream. The default is stop on failure.

## Typed authoring and provider compatibility

Always preserve the user's intended numeric comparisons, sort direction, limits and typed defaults. JSON whitespace has no meaning; arrays may span lines. Do not claim that a provider or KCoder changed an argument based only on your recollection: compare recorded tool inputs and errors first.

If repeated calls arrive with stringified scalars or item wrappers, use `node_json`, `nodes_json`, `input_schema_json` or `definition_json` containing valid JSON text instead of the corresponding structured field. Never send both forms, even with null. These alternatives preserve nested JSON types and use the same validation, revision and ownership checks. They are for the model to use; do not make the user manually rewrite a workflow in the UI. The JSON text must still contain real numbers/booleans/arrays, not quoted numbers or wrapper objects.

`update` requires both `title` and `expected_revision`; preserve the current title when updating only the schema. Defaults must satisfy their containing schema; a rejected default does not advance the revision or change the draft. Freeform arguments and equality values are not blindly retyped. Correct malformed defaults or use the lossless JSON field rather than removing requested behavior.

A bound design conversation can inspect another workflow only through `read` with its explicit saved `version`. Read that version's `inputSchema` before assigning subworkflow arguments/bindings. Other drafts and mutations remain restricted to the bound definition.

For whole-file machine reads, use `read(format="raw")` and omit `offset`, `limit`, and `pages`. Use numbered mode for line ranges or PDF page selection; raw reads fail on size limits rather than silently truncating.
