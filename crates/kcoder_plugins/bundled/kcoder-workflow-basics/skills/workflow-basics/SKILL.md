---
name: workflow-basics
description: Use when designing, saving, or reusing a KCoder visual workflow with explicit node dependencies and verification.
---

# Visual Workflow Authoring

A workflow definition is a reusable graph; a run is one execution in a specific conversation and workspace. Nodes may be Agent tasks, inputs, templates, conditions, merges, bounded loops or outputs; they are not newly registered model tools. Do not run a workflow merely because the user asked to design or save it.

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

Only when execution is requested and `Workflow` is attached, run the selected saved `definition_id` and explicit `version`, with JSON `args`. The current workspace belongs to this run; do not reuse absolute paths from another project without checking the user's intent. Editing the draft does not modify the saved version already selected by a run.

Inspect persisted output and verification evidence before reporting success. A failed run does not erase its saved definition. Resume replays the orchestration script and may reuse matching completed Agent outputs; it is not a JavaScript instruction-pointer checkpoint or an exactly-once guarantee for partial external side effects.

## Compatibility

Existing named `.kcoder/workflows/<name>.js` and inline JavaScript workflows still run through the original interface. Arbitrary JavaScript is not automatically editable as a visual graph. If visual authoring controls are absent, explain the missing capability instead of pretending a graph was saved.
