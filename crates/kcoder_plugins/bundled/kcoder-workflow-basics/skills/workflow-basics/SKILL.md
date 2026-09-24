---
name: workflow-basics
description: Use when designing, saving, or reusing a KCoder visual workflow with explicit node dependencies and verification.
---

# Visual Workflow Authoring

A workflow definition is a reusable graph; a run is one execution in a specific conversation and workspace. A canvas node is an Agent task, not a newly registered model tool. Do not run a workflow merely because the user asked to design or save it.

## Generate incrementally

1. Confirm the intended result and current target/workspace. If the user or Studio supplied a draft ID, update that draft; do not create an unrelated copy.
2. Use `WorkflowDraft` only when attached. Create an empty draft if needed, then submit one `upsert_node` per step. Each mutation must use the latest returned `revision` as `expected_revision`. This makes every generated node visible on the canvas.
3. Give each node a stable ID, concise title, concrete prompt, Agent role, bounded `maxTurns`, and explicit `dependsOn` IDs. Use dependencies only for real data or ordering requirements. Independent nodes may run concurrently.
4. Scope implementation writes with `allowedWritePaths`; describe acceptance criteria and expected artifacts. Verifiers check evidence rather than assuming a prior node succeeded.
5. On revision conflict, read the current draft and reconcile. Never overwrite a newer edit with stale node data.
6. Read the completed draft to confirm it matches the request. Saving publishes a validated immutable version; incomplete nodes, unknown dependencies and cycles must be corrected first. If Studio is managing generation, leave the draft for the user's Save action unless the user explicitly requested publishing.

## Reuse and execute

Only when execution is requested and `Workflow` is attached, run the selected saved `definition_id` and explicit `version`, with JSON `args`. The current workspace belongs to this run; do not reuse absolute paths from another project without checking the user's intent. Editing the draft does not modify the saved version already selected by a run.

Inspect persisted output and verification evidence before reporting success. A failed run does not erase its saved definition. Resume replays the orchestration script and may reuse matching completed Agent outputs; it is not a JavaScript instruction-pointer checkpoint or an exactly-once guarantee for partial external side effects.

## Compatibility

Existing named `.kcoder/workflows/<name>.js` and inline JavaScript workflows still run through the original interface. Arbitrary JavaScript is not automatically editable as a visual graph. If visual authoring controls are absent, explain the missing capability instead of pretending a graph was saved.
