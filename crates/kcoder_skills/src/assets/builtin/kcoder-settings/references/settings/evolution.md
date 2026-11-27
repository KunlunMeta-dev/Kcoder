# Self-Evolution, Learned Lessons and Ratings

Read this file only when the task involves self-evolution (`evolution.*`), learned overlays or lessons, proposals, ratings (`/rate`), `/evolution`, or the Studio **Self-evolution** page.

## What It Learns

Self-evolution improves existing learnable targets from real feedback: usage → feedback → distilled pattern → proposal → offline evaluation → canary → promotion or rollback. Every step keeps its evidence and can be undone. It never trains model weights; it only changes text assets. Target types (`evolution.targets.<type>`):

- `skill`: lessons, checklists and examples for a skill, served as an overlay with the skill's activation result. Default on.
- `preference`: personal cross-task preferences `pref.<scope>.<category>`; `pref.global.*` is injected with the relevant-memory context and domain preferences with the matching skill. Default on.
- `project_knowledge`: project conventions, commands and pitfalls. Default on, but it never exceeds `propose`: every write waits for the user.
- `tool_usage`: short usage hints appended to a tool's own result. Default **off**.
- `workflow_template`: subagent and workflow guidance applied only to newly started runs. Default **off**.

Signals are tool and task results, edits to produced files, corrections and regeneration requests in conversation, and explicit ratings. Failures caused by the environment (network, rate limits, permission or sandbox denials, provider errors) are not scored. The model only classifies signals, summarizes evidence into proposals and judges evaluations; it never scores a target on its own. User work is not copied into learned content: proposals that closely overlap evidence text are rejected, and evidence is secret-redacted.

## Settings and Defaults

All keys are under `evolution`. Verify names against the profile's `settings.schema.jsonc` before writing; unknown keys are rejected.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. Off: nothing is collected, distilled, evaluated or served from a candidate; existing data is kept |
| `mode` | `propose` | `observe` (record only), `propose` (changes wait for the user), `auto` (applied after evaluation and canary) |
| `targets.<type>.enabled` | see above | Type switch |
| `targets.<type>.mode` | unset (`project_knowledge`: `propose`) | Can only narrow the global mode (`observe` < `propose` < `auto`); `project_knowledge` is capped at `propose` |
| `targets.<type>.scope` / `items` | `all` / `{}` | `all` evolves every target except items set to `enabled: false`; `selected` evolves only items set to `true`. Items are keyed by full target key, for example `skill:project:deploy-check` |
| `targets.skill.allow_file_edits` | `false` | Allow direct edits of `UserCreated` and `AgentCreated` skill files (see below) |
| `signals.artifact_edits`, `procedure_results`, `chat_corrections`, `rating_ui` | `true` | A disabled signal gets weight 0; `rating_ui` also hides Studio rating controls |
| `distill_min_usages` | `20` | New observed usages that trigger the next distillation (minimum 1) |
| `candidate_traffic` | `0.5` | Canary share for targets with an offline evaluator; targets without one use at most 0.1 |
| `promote_threshold` / `rollback_threshold` | `0.8` / `0.3` | Required `P(candidate > stable)`; rollback must be lower than promote |
| `eval.win_rate` / `eval.max_diversity_drop` | `0.6` / `0.1` | Offline evaluation pass thresholds (ties excluded; relative diversity drop) |
| `model` | `null` | `{"provider": "<id>", "model": "<id>"}` of an already configured model; `null` follows the triggering session's model |
| `stage_models.classifier` / `distill` / `eval` | `null` | Per-stage override; `null` uses `model` |
| `evidence_ttl_days` | `90` | 1–3650; older evidence is deleted |
| `usage_limit.monthly_max_tokens` | `null` | `null` is unlimited (default); otherwise a positive token cap per month |
| `share_aggregates` | `false` | Placeholder for future cross-user statistics; nothing is uploaded |

Model references point to models the target already has configured (same Provider IDs, case-preserving); no extra Provider or key is needed. A removed or unavailable selected model pauses evolution model calls; it never falls back to the first catalog entry or another model.

**Scope.** Evolution reads only user, program and explicit overlay settings. Project and local settings may only set `evolution.enabled` to `false`; every other `evolution` key there is ignored with a load warning, so a repository cannot enable it, pick a model or relax thresholds. Write user changes with:

```bash
kcoder config set evolution.enabled true --scope user
kcoder config set evolution.targets.tool_usage.enabled true --scope user
kcoder config get evolution.mode --source
```

Change these only on the user's request; enabling makes extra model calls.

## Write Ownership

When `evolution.enabled` is off, background skill review, the curator and memory behave exactly as before, and no overlay is injected. When it is on (and the session is not in training mode or a workflow draft):

- The skill file (base layer) is written only by the user, installers/upgrades, or an applied skill-file proposal. Overlays, learned preferences and project knowledge are written only by the evolution framework; user edits in the UI go through it.
- Background skill review (still governed by `skills.auto_skill_review_*` and still requiring `skill_manage` in the tool set) loses `skill_manage` and `remember`. Findings about existing skills become review-finding evidence that needs real signals to count; a workflow no skill covers becomes a create-skill proposal in `propose`, an `AgentCreated` skill after the write guard in `auto`, or evidence only in `observe`; what `remember` would have saved becomes preference or project-knowledge evidence.
- Duplicate overlay entries become curator merge proposals instead of direct rewrites.
- In `observe`, already accepted overlays are still injected. Turning evolution off later stops injection and keeps the data.

## Overlays, Skill Files and Rollback

**Overlay (default for every skill).** Learned content lives outside the skill directory, in stable and candidate slots of at most 6000 characters each. It is appended to the `skill` activation result inside `<evolution_overlay target="…" revision="…">`, not to the system prompt, and is not repeated when the marker is already in the transcript, so a resumed session shows what was in effect. When the skill body changes (user edit or upgrade), the overlay is marked as needing revalidation and is not injected until revalidated. A session keeps one channel (stable or candidate) for a target.

**Skill-file mode.** `UserCreated` skills need `targets.skill.allow_file_edits`; `AgentCreated` skills qualify with that setting or when they declare `evolution.target: skill`. Bundled, Hub and external skills always use overlays; project skills also need a workspace that allows implicit project writes. Learned text goes into a managed block (`<!-- kcoder:evolution:begin -->` … `end`) and is staged in the skill store's candidate slot until promoted.

**Rollback.** Rolling back a canary only switches the pointer; candidate content is kept. Rolling back a promoted skill-file proposal restores the pre-promotion package. If the skill was edited after promotion, the edit is kept, only the overlay is rolled back, and the result carries a notice saying so; any managed block must then be handled by hand. The store keeps the previous package only for the latest promotion, so older promotions also roll back the overlay only. Pinning the stable version stops the canary.

## Where Data Lives and Clearing It

Data lives in the target's user data directory (the profile that holds the user `settings.json`; see `kcoder config path`), never inside a project:

- User scope (user, bundled, Hub and external skills, tools, preferences): `<profile>/evolution/`.
- Project scope (project skills and project knowledge): `<profile>/evolution-projects/<memory project key>/evolution/`.

Files include `usages.jsonl`, `outcomes.jsonl`, redacted `evidence/`, `stats.json`, `proposals/`, `overlays/`, `patterns.json`, `preferences.json` and `state.json`. A remote target keeps its own data. Clear data with Studio **Self-evolution → Data and privacy → Clear local evolution data** (all, this project only, or personal data only; confirmed twice) or the `evolution/data/clear` RPC; both cancel and wait for running evolution jobs first and return learned overlays to the original versions. Do not delete these files while KCoder is running. Disabling evolution never deletes data.

## Commands and Studio

TUI/REPL:

```text
/evolution                         # same as /evolution status
/evolution list skill              # skill | preference | project_knowledge | tool_usage | workflow_template
/evolution approve <proposal-id>   # also: reject, rollback
/evolution distill <target-key>    # queue distillation for the next idle period
/rate up|down [reason]             # rate the last turn of this session
```

`/rate` records only when evolution is active and the turn used a target. The latest rating stands: changing it (or adding a reason) appends a new rating record, earlier ones stay in the journal but no longer score.

Studio: **Settings → Self-evolution** configures the current runtime target; the target must advertise `selfEvolutionV1`, otherwise the page says the version is unsupported. Turning the master switch on shows a dialog about the extra model cost until it has been acknowledged in that client. Advanced settings (traffic, thresholds, stage models, monthly limit) are collapsed. The effective skill's detail under **Plugins → Manage → Skills** has an **Evolution** section with scores, the editable overlay, learned patterns, proposals with evaluation results, and approve/promote/reject/roll back/pin actions, plus **Distill feedback**. With `rating_ui`, replies whose completed `skill` call recorded a usage show thumbs up/down (the runtime lists the ratable turns); the selection can be changed, and a failure names its cause (no recorded skill use, self-evolution off, conversation not found, unconfirmed). A promotion shows "Skill X learned a new lesson" with Undo.

In `propose`, approving a draft approves evaluation and canary only; promotion waits for a second confirmation. In `auto`, passing candidates are promoted or rolled back automatically, preferences are written after the safety scan, and project knowledge still waits for the user.

## Troubleshooting

Read `evolution/status` (Studio page or `/evolution status`) first. `disabledReason`:

- `training_mode`: `--training-mode` turns evolution off for that process; settings cannot be changed there. Not a settings fix.
- `project_disabled`: the user enabled it, but this project's `.kcoder/settings.json` or `settings.local.json` sets `evolution.enabled: false`. That is the project's choice; remove it only when the user asks.
- `model_unavailable`: a selected `model`/`stage_models.*` reference is not an available configured model, or the session paused its evolution jobs because the stage model could not be resolved. Pick another configured model (or follow the session model); do not invent Provider entries or copy credentials. A manual distill on a workspace without a live session also answers `model_unavailable` while evolution follows the session model, because there is no session to follow; set `evolution.model` or open a session there.
- `usage_limit`: this month's evolution tokens reached `usage_limit.monthly_max_tokens`. Learning resumes next month or after the user raises or clears the limit.

`diagnostics.projectScopeIssue`:

- `data_root_inside_project`: the profile directory is inside the project (for example a development home in the checkout), so project-scope data is skipped; user-scope learning continues. Use a profile outside the project.
- `unavailable`: project storage could not be opened; project-scope learning is skipped for that request.

Other checks: a skill without overlay injection may have no accepted overlay yet, need revalidation after a body change, or be disabled under `targets.skill.items`. `tool_usage` and `workflow_template` stay idle until enabled. Distillation and evaluation run only while the session is idle and only after `distill_min_usages`, repeated conflict events or a manual distill request.

## Cost

Collection, statistics and canary assignment are local. Signal classification (batched), distillation (idle, threshold-triggered) and evaluation (idle, once per proposal) call the selected model, counted as a separate request class; usage this month is shown in Studio and `/evolution status`. There is no token limit by default; evaluation keeps concurrency and duration caps. Suggest a cheaper configured model in `stage_models` or a monthly limit when cost matters.
