//! Spec bundled assets domain implementation.

use super::*;

/// Superpowers skills bundled into the binary and installed by `init`.
pub const SUPERPOWER_SKILLS: &[(&str, &str)] = &[
    (
        "using-superpowers",
        include_str!("skills/using-superpowers/SKILL.md"),
    ),
    (
        "brainstorming",
        include_str!("skills/brainstorming/SKILL.md"),
    ),
    (
        "writing-plans",
        include_str!("skills/writing-plans/SKILL.md"),
    ),
    (
        "executing-plans",
        include_str!("skills/executing-plans/SKILL.md"),
    ),
    (
        "test-driven-development",
        include_str!("skills/test-driven-development/SKILL.md"),
    ),
    (
        "verification-before-completion",
        include_str!("skills/verification-before-completion/SKILL.md"),
    ),
    (
        "using-git-worktrees",
        include_str!("skills/using-git-worktrees/SKILL.md"),
    ),
    (
        "systematic-debugging",
        include_str!("skills/systematic-debugging/SKILL.md"),
    ),
    (
        "subagent-driven-development",
        include_str!("skills/subagent-driven-development/SKILL.md"),
    ),
    (
        "dispatching-parallel-agents",
        include_str!("skills/dispatching-parallel-agents/SKILL.md"),
    ),
    (
        "requesting-code-review",
        include_str!("skills/requesting-code-review/SKILL.md"),
    ),
    (
        "receiving-code-review",
        include_str!("skills/receiving-code-review/SKILL.md"),
    ),
    (
        "finishing-a-development-branch",
        include_str!("skills/finishing-a-development-branch/SKILL.md"),
    ),
    (
        "writing-skills",
        include_str!("skills/writing-skills/SKILL.md"),
    ),
];

pub const SUPERPOWER_SKILL_ASSETS: &[BundledSkillAsset] = &[
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/frame-template.html",
        content: include_str!("skills/brainstorming/scripts/frame-template.html"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/helper.js",
        content: include_str!("skills/brainstorming/scripts/helper.js"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/server.cjs",
        content: include_str!("skills/brainstorming/scripts/server.cjs"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/start-server.sh",
        content: include_str!("skills/brainstorming/scripts/start-server.sh"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "scripts/stop-server.sh",
        content: include_str!("skills/brainstorming/scripts/stop-server.sh"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "spec-document-reviewer-prompt.md",
        content: include_str!("skills/brainstorming/spec-document-reviewer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "brainstorming",
        relative_path: "visual-companion.md",
        content: include_str!("skills/brainstorming/visual-companion.md"),
    },
    BundledSkillAsset {
        skill: "requesting-code-review",
        relative_path: "code-reviewer.md",
        content: include_str!("skills/requesting-code-review/code-reviewer.md"),
    },
    BundledSkillAsset {
        skill: "subagent-driven-development",
        relative_path: "code-quality-reviewer-prompt.md",
        content: include_str!("skills/subagent-driven-development/code-quality-reviewer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "subagent-driven-development",
        relative_path: "implementer-prompt.md",
        content: include_str!("skills/subagent-driven-development/implementer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "subagent-driven-development",
        relative_path: "spec-reviewer-prompt.md",
        content: include_str!("skills/subagent-driven-development/spec-reviewer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "CREATION-LOG.md",
        content: include_str!("skills/systematic-debugging/CREATION-LOG.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "condition-based-waiting-example.ts",
        content: include_str!("skills/systematic-debugging/condition-based-waiting-example.ts"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "condition-based-waiting.md",
        content: include_str!("skills/systematic-debugging/condition-based-waiting.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "defense-in-depth.md",
        content: include_str!("skills/systematic-debugging/defense-in-depth.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "find-polluter.sh",
        content: include_str!("skills/systematic-debugging/find-polluter.sh"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "root-cause-tracing.md",
        content: include_str!("skills/systematic-debugging/root-cause-tracing.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "test-academic.md",
        content: include_str!("skills/systematic-debugging/test-academic.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "test-pressure-1.md",
        content: include_str!("skills/systematic-debugging/test-pressure-1.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "test-pressure-2.md",
        content: include_str!("skills/systematic-debugging/test-pressure-2.md"),
    },
    BundledSkillAsset {
        skill: "systematic-debugging",
        relative_path: "test-pressure-3.md",
        content: include_str!("skills/systematic-debugging/test-pressure-3.md"),
    },
    BundledSkillAsset {
        skill: "test-driven-development",
        relative_path: "testing-anti-patterns.md",
        content: include_str!("skills/test-driven-development/testing-anti-patterns.md"),
    },
    BundledSkillAsset {
        skill: "writing-plans",
        relative_path: "plan-document-reviewer-prompt.md",
        content: include_str!("skills/writing-plans/plan-document-reviewer-prompt.md"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "agent-best-practices.md",
        content: include_str!("skills/writing-skills/agent-best-practices.md"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "examples/AGENTS_MD_TESTING.md",
        content: include_str!("skills/writing-skills/examples/AGENTS_MD_TESTING.md"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "graphviz-conventions.dot",
        content: include_str!("skills/writing-skills/graphviz-conventions.dot"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "persuasion-principles.md",
        content: include_str!("skills/writing-skills/persuasion-principles.md"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "render-graphs.js",
        content: include_str!("skills/writing-skills/render-graphs.js"),
    },
    BundledSkillAsset {
        skill: "writing-skills",
        relative_path: "testing-skills-with-subagents.md",
        content: include_str!("skills/writing-skills/testing-skills-with-subagents.md"),
    },
];

/// Companion scripts that must retain execute permissions on Unix.
pub const SUPERPOWER_EXECUTABLE_ASSETS: &[(&str, &str)] = &[
    ("brainstorming", "scripts/start-server.sh"),
    ("brainstorming", "scripts/stop-server.sh"),
    ("systematic-debugging", "find-polluter.sh"),
    ("writing-skills", "render-graphs.js"),
];

pub fn bundled_skill_asset_is_executable(skill: &str, relative_path: &str) -> bool {
    SUPERPOWER_EXECUTABLE_ASSETS
        .iter()
        .any(|(asset_skill, asset_path)| *asset_skill == skill && *asset_path == relative_path)
}

/// Render the `using-specs` skill, including project-specific config guidance
/// when `.kcoder/specs/config.yaml` is available.
pub fn render_using_specs_skill(config: Option<&config::ProjectConfig>) -> String {
    let mut text = USING_SPECS_SKILL.trim_end().to_string();
    text.push_str(
        "\n\n## Tool Preference\n\n\
Use `SpecStatus` to check artifact/task/drift state before archiving or reporting progress. \
Use `SpecStatus` with `change` to inspect a change's proposal, tasks, design, and delta specs before editing. \
Use `SpecCheck` with `action=preflight` before implementing `spec-driven-superpowers` changes. \
Use `SpecRecordVerification` to write retained evidence into `verification.md`. \
Prefer structured spec tools over guessing paths under `.kcoder/specs/changes/`.\n",
    );
    if let Some(config) = config {
        text.push_str("\n## Project Spec Configuration\n\n");
        let schema = if config.schema.trim().is_empty() {
            "spec-driven"
        } else {
            config.schema.as_str()
        };
        text.push_str(&format!("- Schema: `{schema}`\n"));
        if config::is_superpowers_schema(schema) {
            text.push_str(
                "- `review.md` is the readiness gate; do not implement while it is `blocked`.\n\
- `plan.md` is the execution driver; keep `tasks.md` as the coarse-grained source of truth.\n\
- Map high-priority `Validation Focus` items into `plan.md` execution or verification steps.\n",
            );
        }
        if let Some(precheck) = config
            .precheck
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            text.push_str(&format!("- Precheck: `{precheck}`\n"));
        }
        if let Some(context) = config
            .context
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            text.push_str("\nProject context:\n\n");
            text.push_str(context.trim());
            text.push('\n');
        }
        if let Some(rules) = &config.rules
            && !rules.is_empty()
        {
            text.push_str("\nArtifact rules:\n");
            for (artifact, artifact_rules) in rules {
                text.push_str(&format!("- `{artifact}`:\n"));
                for rule in artifact_rules {
                    text.push_str(&format!("  - {rule}\n"));
                }
            }
        }
    }
    text
}

pub(super) const CODE_REVIEWER_PROMPT_TEMPLATE: &str = r#"You are a Senior Code Reviewer reviewing a spec-driven change.

## Change

{TITLE}

## What Was Implemented

{DESCRIPTION}

## Requirements / Plan

{PLAN_OR_REQUIREMENTS}

## Pre-Review Checks

{PRECHECK}

## Git Range

Base: {BASE_SHA}
Head: {HEAD_SHA}

```bash
git diff --stat {BASE_SHA}..{HEAD_SHA}
```

{DIFF_STAT}

```bash
git diff {BASE_SHA}..{HEAD_SHA}
```

{DIFF}

## Review Process

Conduct the review in two explicit phases. Do not mix phase-1 and phase-2 findings until the final summary.

### Phase 1: Spec Compliance

Verify that the implementation faithfully satisfies the approved spec change.

- Does the git diff realize every ADDED/MODIFIED/REMOVED/RENAMED requirement in the delta specs?
- Are there unimplemented requirements or scope creep not covered by the deltas?
- Do new tests map to specific spec scenarios (WHEN/THEN)?
- Is the design.md consistent with the actual changes?

### Phase 2: Code Quality

Only after confirming spec compliance, evaluate the implementation itself.

- Type safety, error handling, and panic paths.
- Edge cases, cross-platform behavior, and async correctness.
- Test quality: do tests verify real behavior, not just existence?
- No obvious bugs, security issues, or unnecessary complexity.

## Output Format

### Strengths
[What's well done? Be specific.]

### Issues
#### Critical (Must Fix)
#### Important (Should Fix)
#### Minor (Nice to Have)

### Assessment
**Ready to merge?** [Yes | No | With fixes]
**Reasoning:** [1-2 sentence technical assessment]
"#;

pub(super) const DEFAULT_SPEC: &str = r#"# Spec: core

## Purpose

Core domain behavior for the project.

## Requirements

### Requirement: example

The system MUST behave correctly in the example scenario.

#### Scenario: happy path

- **WHEN** an action happens
- **THEN** an expected result occurs
"#;

pub(super) const PROPOSAL_TEMPLATE: &str = r#"# Proposal

## Problem

What problem does this change solve?

## Approach

High-level approach.

## Acceptance criteria

- [ ] Criterion one
- [ ] Criterion two
"#;

pub(super) const DESIGN_TEMPLATE: &str = r#"# Design

## Overview

Design overview.

## Key decisions

- Decision one
- Decision two

## Risks

- Risk one
"#;

pub(super) const TASKS_TEMPLATE: &str = r#"# Tasks

## 1. Understand and reproduce
- [ ] 1.1 Read the relevant specs and code.
- [ ] 1.2 List edge cases and platform-specific behavior.

## 2. Design
- [ ] 2.1 Write or update delta specs under `changes/<name>/specs/`.
- [ ] 2.2 Update `design.md` with key decisions and risks.

## 3. Implement
- [ ] 3.1 Add production code.
- [ ] 3.2 Add or update tests for every new/changed requirement.

## 4. Verify
- [ ] 4.1 Run the project test suite.
- [ ] 4.2 Run SpecCheck with action=verify and close any coverage gaps.
"#;

pub(super) const REVIEW_TEMPLATE: &str = r#"# Review

## Readiness Decision

ready with conditions

## Execution Mode

standard

## Verification Mode

inline-only

## Debug Mode

standard

## Review Request

not-requested

## Review Scope

none

## Review Focus

none

## Review Status

not-requested

## Delegation Mode

single-agent

## Parallelization Mode

serial-only

## Worktree Mode

same-tree

## Branch Finish Mode

standard

## Blocked By

none

## Observed Failure

none

## Validation Focus

- Run the project precheck.
- Run SpecCheck with action=validate and close any structural errors.

## Key Risks

- Unknown until design and tasks are finalized.

## Findings Summary

none

## Manual Adjustments

none
"#;

pub(super) const PLAN_TEMPLATE: &str = r#"# Plan

## Scope

Describe the part of the change this execution plan covers.

## Covers

- 1.1

## Plan Type

lightweight

## Execution Strategy

standard

## Ordered Steps

1. Inspect the relevant specs and code.
2. Implement the smallest coherent change.
3. Run the focused validation.

## Validation Per Step

1. Confirm the affected requirements and current behavior.
2. Confirm code changes match the accepted design.
3. Confirm tests, SpecCheck action=validate, and any configured precheck pass.

## Files / Owners

- `TBD`

## Completion Checkpoint

All covered tasks are complete, validation has passed, and residual risks are recorded.

## Completion Verification

Record final commands or evidence here when retained verification is recommended or required.

## Debugging Trail

none

## Review Follow-Up

none

## Delegation Units

none

## Parallel Units

none

## Isolation Boundaries

none

## Worktree Units

none

## Isolation Reason

none

## Integration Owner

main agent

## Finish Checklist

none

## Delivery Handoff

none

## Execution Notes

none

## Manual Adjustments

none
"#;

pub(super) const DEFAULT_DELTA_TEMPLATE: &str = r#"# Delta: core

Describe changes to the authoritative spec using the four sections below.
Each requirement MUST use SHALL/MUST/SHOULD/MAY and each scenario MUST use WHEN/THEN.

## ADDED Requirements

### Requirement: <name>
The system MUST ...

#### Scenario: <title>
- **WHEN** ...
- **THEN** ...

## MODIFIED Requirements

<!-- List requirements whose behavior changes. Use `### Requirement: <name>` blocks. -->

## REMOVED Requirements

<!-- List requirements to remove. Use `### Requirement: <name>` blocks or a bullet list. -->

## RENAMED Requirements

<!-- Use FROM/TO pairs: `- FROM: ### Requirement: <old-name>` / `- TO: ### Requirement: <new-name>`. -->
"#;

pub(super) const USING_SPECS_SKILL: &str = r#"---
name: using-specs
description: Use when the project has a .kcoder/specs directory and you are doing spec-driven development.
paths:
  - ".kcoder/specs/**"
---

# Using Specs (OpenSpec + Superpowers fusion)

This project uses spec-driven development. The authoritative behavior specs live
under `.kcoder/specs/specs/`. Changes are tracked under `.kcoder/specs/changes/`.

The Superpowers discipline skills are installed under `.kcoder/skills/`. Invoke
them with the Skill tool before taking action:

- `using-superpowers` — root protocol; check for applicable skills before every response.
- `brainstorming` — HARD-GATE for creative work; present a design and get approval first.
- `writing-plans` — turn a spec into a numbered, bite-sized implementation plan.
- `test-driven-development` — follow RED / GREEN / REFACTOR for every feature or fix.
- `verification-before-completion` — run verification commands and confirm output before claiming done.
- `using-git-worktrees` — isolate feature work in a clean worktree when appropriate.

Workflow:

1. **Check skills** — invoke `using-superpowers` to see which discipline applies.
2. **Brainstorm** — if the problem is ambiguous or creative, invoke `brainstorming`.
3. **Create a change** — call `SpecNewChange` with a kebab-case name and optional title.
4. **Propose** — fill in `proposal.md` with the problem, approach, and acceptance criteria.
5. **Spec** — write delta specs under `changes/<name>/specs/<capability>/spec.md` describing ADDED,
   MODIFIED, or REMOVED requirements relative to `.kcoder/specs/specs/`.
   - If the change spans multiple independent capability domains, invoke
     `dispatching-parallel-agents` to draft each domain's delta spec in parallel.
6. **Design** — document key decisions and risks in `design.md`.
7. **Review readiness** — when the schema is `spec-driven-superpowers`, fill
   `review.md` before implementation planning. Treat `Readiness Decision:
   blocked` as a stop sign, and carry `Validation Focus` into the plan.
8. **Plan execution** — invoke `writing-plans`, then use `ExitPlanMode` with the
   plan text. Default `spec-driven` changes sync the plan to `tasks.md` as
   checkboxes. `spec-driven-superpowers` changes sync the plan to `plan.md`;
   keep `tasks.md` as the coarse-grained progress source of truth.
9. **Preflight** — when the schema is `spec-driven-superpowers`, call
   `SpecCheck` with `action=preflight` and resolve blockers before implementation.
10. **Implement** — invoke `test-driven-development` and follow its RED/GREEN/REFACTOR cycle.
   Prefer `EnterWorktree` for isolated branches.
11. **Verify** — invoke `verification-before-completion`; run tests and ensure all tasks are checked (`- [x]`).
    If retained evidence is recommended or required, call `SpecRecordVerification`
    so `verification.md` records the completion decision, commands, checks,
    evidence, and residual risks.
12. **Review writeback** — after code-review findings are received, call
    `SpecReview` with `action=writeback` so accepted findings are written into `review.md`,
    `tasks.md`, `plan.md`, or `verification.md` rather than a parallel notes tree.
13. **Rebase if needed** — if `SpecArchive` reports drift, call `SpecSync` to
    fast-forward unchanged deltas or surface conflicts, resolve them, then re-sync.
14. **Archive** — call `SpecArchive` to finalize the change.

Never skip the spec and design steps for non-trivial changes. If a requirement
conflicts with an existing spec, update the spec delta and explain why.
"#;
