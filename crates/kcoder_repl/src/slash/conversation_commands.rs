use crate::ReplApp;
use crate::diff_render::{RenderDiffOptions, calculate_add_remove_from_diff, render_unified_diff};
use kcoder_engine::QueryEngine;
use kcoder_types::MessageRole;
use std::path::Path;
use std::process::{Command, ExitStatus, Output};

use super::{SlashCommand, SlashResult};

const GIT_DIFF_WRAP_COLS: usize = 120;
const MAX_GIT_DIFF_LINES: usize = 1_200;
const MANUAL_COMPACT_MIN_USEFUL_TOKENS: usize = 256;
const EXECUTABLE_FILTER_CONFIG_PATTERN: &str = r"^filter\..*\.(clean|process)$";
const DISABLE_HOOKS_CONFIG: &str = if cfg!(windows) {
    "core.hooksPath=NUL"
} else {
    "core.hooksPath=/dev/null"
};

#[derive(Default)]
pub(super) struct BtwCommand;

#[async_trait::async_trait]
impl SlashCommand for BtwCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/btw"
    }

    fn description(&self) -> &'static str {
        "Ask a side question without interrupting the main task."
    }

    fn usage(&self) -> &'static str {
        "/btw <question>"
    }

    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        let question = args.trim();
        if question.is_empty() {
            app.push_message(MessageRole::System, "Usage: /btw <question>");
            return SlashResult::Handled;
        }
        SlashResult::StartSideQuestion(question.to_string())
    }
}

#[derive(Default)]
pub(super) struct HistoryCommand;

#[async_trait::async_trait]
impl SlashCommand for HistoryCommand {
    fn name(&self) -> &'static str {
        "/history"
    }
    fn description(&self) -> &'static str {
        "Show recent conversation history."
    }
    fn usage(&self) -> &'static str {
        "/history [n]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let limit: usize = args.trim().parse().unwrap_or(10);
        let messages = engine.state.messages();
        let start = messages.len().saturating_sub(limit);
        let lines: Vec<String> = messages[start..]
            .iter()
            .map(|m| format!("{}: {}", role_label(&m.role()), m.preview(120)))
            .collect();
        if lines.is_empty() {
            app.push_message(MessageRole::System, "No history yet.");
        } else {
            app.push_message(
                MessageRole::System,
                format!("Recent history:\n{}", lines.join("\n")),
            );
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct UndoCommand;

#[async_trait::async_trait]
impl SlashCommand for UndoCommand {
    fn name(&self) -> &'static str {
        "/undo"
    }
    fn description(&self) -> &'static str {
        "Remove the last assistant turn."
    }
    fn usage(&self) -> &'static str {
        "/undo"
    }
    async fn run(&self, _args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let removed = engine.state.pop_last_assistant_turn();
        if removed > 0 {
            // Also sync the display messages roughly by removing trailing assistant/system.
            app.messages
                .retain(|m| m.role != MessageRole::Assistant && m.role != MessageRole::System);
            app.push_message(
                MessageRole::System,
                format!("Undid {} assistant message(s).", removed),
            );
        } else {
            app.push_message(MessageRole::System, "Nothing to undo.");
        }
        SlashResult::Handled
    }
}

#[derive(Default)]
pub(super) struct CompactCommand;

#[async_trait::async_trait]
impl SlashCommand for CompactCommand {
    fn name(&self) -> &'static str {
        "/compact"
    }
    fn description(&self) -> &'static str {
        "Manually trigger context compaction."
    }
    fn usage(&self) -> &'static str {
        "/compact"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /compact");
            app.snap_to_bottom();
            return SlashResult::Handled;
        }

        let current_tokens = engine.estimated_token_count();
        if current_tokens > 0 && current_tokens < MANUAL_COMPACT_MIN_USEFUL_TOKENS {
            app.refresh_engine_metadata(engine);
            app.push_message(
                MessageRole::System,
                format!(
                    "Context compaction skipped: current model context is only {} tokens.",
                    current_tokens
                ),
            );
            app.snap_to_bottom();
            return SlashResult::Handled;
        }

        SlashResult::StartCompact
    }
}

#[derive(Default)]
pub(super) struct ReviewCommand;

#[async_trait::async_trait]
impl SlashCommand for ReviewCommand {
    fn name(&self) -> &'static str {
        "/review"
    }
    fn description(&self) -> &'static str {
        "Review current changes and find issues."
    }
    fn usage(&self) -> &'static str {
        "/review [instructions]"
    }
    async fn run(&self, args: &str, _app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        SlashResult::Submit(review_prompt(args.trim()))
    }
}

fn review_prompt(instructions: &str) -> String {
    let mut prompt = String::from(
        "Review my current changes and find correctness, regression, security, and test-coverage issues.\n\n\
         Scope:\n\
         - Inspect the git diff, including untracked files.\n\
         - Focus on bugs and user-visible risks introduced by the changes.\n\
         - Do not modify files while reviewing.\n\n\
         Output:\n\
         - Lead with findings ordered by severity.\n\
         - Include concrete file:line references for each finding.\n\
         - If there are no findings, say that clearly and mention any residual test gaps.\n",
    );
    if !instructions.is_empty() {
        prompt.push_str("\nAdditional review instructions:\n");
        prompt.push_str(instructions);
        prompt.push('\n');
    }
    prompt
}

#[derive(Default)]
pub(super) struct OcrCommand;

#[async_trait::async_trait]
impl SlashCommand for OcrCommand {
    fn name(&self) -> &'static str {
        "/ocr"
    }
    fn description(&self) -> &'static str {
        "Run OpenCodeReview through the built-in ocr tool."
    }
    fn usage(&self) -> &'static str {
        "/ocr [instructions]"
    }
    async fn run(&self, args: &str, _app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        let instructions = args.trim();
        SlashResult::SubmitWithDisplay {
            visible_text: ocr_visible_text(instructions),
            model_text: ocr_prompt(instructions),
        }
    }
}

fn ocr_visible_text(instructions: &str) -> String {
    if instructions.is_empty() {
        "Run OpenCodeReview review for current changes.".to_string()
    } else {
        format!("Run OpenCodeReview review for current changes. {instructions}")
    }
}

fn ocr_prompt(instructions: &str) -> String {
    let mut prompt = String::from(
        "Run OpenCodeReview for this workspace using the built-in `ocr` model tool.\n\n\
         Required workflow:\n\
         1. First call `ocr` with `{ \"command\": \"review\", \"preview\": true }` to show the current review scope.\n\
         2. If the scope is reasonably small or the user explicitly asked for a full review, call `ocr` again with preview=false and summarize its findings.\n\
         3. If the full review returns a background task id, report that id immediately and use `TaskOutput` later instead of leaving the user with no progress.\n\
         4. If the scope is very large, report the file count and suggest a narrower `scan` path or review range before starting a long full review.\n\
         5. Do not edit files while reviewing.\n\n\
         Output:\n\
         - Summarize the OCR scope and whether a full review was run.\n\
         - Lead with confirmed findings ordered by severity.\n\
         - Include concrete file:line references when OCR provides them.\n",
    );
    if !instructions.is_empty() {
        prompt.push_str("\nAdditional OCR review instructions:\n");
        prompt.push_str(instructions);
        prompt.push('\n');
    }
    prompt
}

#[derive(Default)]
pub(super) struct LearnCommand;

#[async_trait::async_trait]
impl SlashCommand for LearnCommand {
    fn name(&self) -> &'static str {
        "/learn"
    }
    fn description(&self) -> &'static str {
        "Learn a reusable KCoder skill from sources, notes, or this conversation."
    }
    fn usage(&self) -> &'static str {
        "/learn [what to learn from]"
    }
    async fn run(&self, args: &str, _app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        SlashResult::Submit(learn_prompt(args.trim()))
    }
}

fn learn_prompt(user_request: &str) -> String {
    let request = if user_request.trim().is_empty() {
        "the workflow we just went through in this conversation - review the conversation, identify the reusable procedure, and distill it into a KCoder skill"
    } else {
        user_request.trim()
    };

    format!(
        r#"[/learn] The user wants you to learn a reusable KCoder skill and save it.

THE REQUEST:
{request}

The request may mix SOURCES and REQUIREMENTS in any order:
- SOURCES can be local files, directories, URLs, the current conversation, or pasted notes.
- REQUIREMENTS can be focus areas, scope limits, naming preferences, exclusions, or quality constraints.

Treat every part of the request as load-bearing. Text after a path or URL is not incidental; it tells you how to shape the skill. Never read only the first source and ignore the rest.

Do this as a normal KCoder turn:
1. Search for existing skill-writing guidance first. Use DiscoverSkills with a concrete description such as "creating or editing KCoder skills". If `writing-skills` or another matching skill appears, invoke it with the skill tool and follow it before creating or editing any skill.
2. Gather every source the user named. Use read/glob/grep for local files and directories, WebFetch/WebSearch when URLs or current online docs are explicitly needed, and the conversation history when the user refers to what just happened.
3. Inspect existing skills before writing. Use skill_manage list/view and prefer patching or editing an existing relevant skill when that is better than creating a duplicate.
4. Treat skill creation as TDD for process documentation: define at least one concrete pressure/trigger scenario before writing, note the baseline failure or gap you are fixing, then write the minimum skill that addresses that gap. Use TodoWrite for the skill checklist when the work is non-trivial.
5. Author one focused SKILL.md for recurring workflow knowledge, not a one-off transcript. Save it with skill_manage action="create" unless an existing skill should be patched/edited instead.
6. If the skill needs bulky references, templates, scripts, or assets, add supporting files with skill_manage action="write_file" under references/, templates/, scripts/, or assets/ and reference them from SKILL.md.
7. After writing, verify the skill was created or updated by viewing it through skill_manage action="view". When possible, also test discoverability with DiscoverSkills and test activation with the skill tool or a prompt that should trigger it. Report the skill name, path, whether it was created or updated, and a one-line summary.

KCoder skill requirements:
- Skills live under .kcoder/skills/<name>/ by default.
- The SKILL.md must start with YAML frontmatter and include at least name and description.
- Skill names must be 64 characters or fewer, start with a lowercase ASCII letter or digit, and contain only lowercase ASCII letters, digits, '.', '_', and '-'.
- The description must start with "Use when", be third-person, describe only trigger conditions/symptoms, and must not summarize the skill's workflow or procedure.
- The body should include clear trigger guidance, a concise procedure or core pattern, common pitfalls, and verification criteria.
- Define a fresh trigger-test prompt that should activate the skill without naming the skill.
- Use exact commands, paths, APIs, and facts only when you verified them from the sources.
- Do not save secrets, personal credentials, or one-off session details.
"#
    )
}

#[derive(Default)]
pub(super) struct RenameCommand;

#[async_trait::async_trait]
impl SlashCommand for RenameCommand {
    fn needs_arguments(&self) -> bool {
        true
    }
    fn name(&self) -> &'static str {
        "/rename"
    }
    fn description(&self) -> &'static str {
        "Rename the current session."
    }
    fn usage(&self) -> &'static str {
        "/rename [title]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, _engine: &QueryEngine) -> SlashResult {
        let Some(title) = normalize_session_title(args) else {
            let prefill = app
                .session_title()
                .map(|title| format!("/rename {title}"))
                .unwrap_or_else(|| "/rename ".to_string());
            app.prefill_input(prefill);
            app.push_message(
                MessageRole::System,
                "Type a session title and press Enter to rename this session.",
            );
            return SlashResult::Handled;
        };

        app.set_session_title(title.clone());
        app.push_message(MessageRole::System, format!("Session renamed to: {title}"));
        SlashResult::Handled
    }
}

fn normalize_session_title(name: &str) -> Option<String> {
    let trimmed = name.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[derive(Default)]
pub(super) struct DiffCommand;

#[async_trait::async_trait]
impl SlashCommand for DiffCommand {
    fn name(&self) -> &'static str {
        "/diff"
    }
    fn description(&self) -> &'static str {
        "Show git diff, including untracked files."
    }
    fn usage(&self) -> &'static str {
        "/diff"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        if !args.trim().is_empty() {
            app.push_message(MessageRole::System, "Usage: /diff");
            return SlashResult::Handled;
        }

        let cwd = engine.state.cwd();
        let diff_result = tokio::task::spawn_blocking(move || collect_git_diff(&cwd)).await;
        match diff_result {
            Ok(Ok(diff)) if !diff.is_git_repo => {
                app.push_message(
                    MessageRole::System,
                    "`/diff` — _not inside a git repository_",
                );
            }
            Ok(Ok(diff)) if diff.text.trim().is_empty() => {
                app.push_message(MessageRole::System, "No changes detected.");
            }
            Ok(Ok(diff)) => {
                app.push_message(MessageRole::System, format_git_diff_message(&diff.text));
            }
            Ok(Err(error)) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to compute diff: {error}"),
                );
            }
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to compute diff: {error}"),
                );
            }
        }
        SlashResult::Handled
    }
}

fn role_label(role: &kcoder_types::MessageRole) -> &'static str {
    match role {
        kcoder_types::MessageRole::User => "You",
        kcoder_types::MessageRole::Assistant => "KCoder",
        kcoder_types::MessageRole::System => "System",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitDiff {
    is_git_repo: bool,
    text: String,
}

fn collect_git_diff(cwd: &Path) -> Result<GitDiff, String> {
    if !inside_git_repo(cwd)? {
        return Ok(GitDiff {
            is_git_repo: false,
            text: String::new(),
        });
    }

    let filter_config_overrides = diff_filter_config_overrides(cwd)?;
    let tracked_diff = run_git_capture_diff(
        cwd,
        &filter_config_overrides,
        &[
            "diff",
            "--no-textconv",
            "--no-ext-diff",
            "--submodule=short",
            "--ignore-submodules=dirty",
            "--no-color",
        ],
    )?;
    let untracked_files =
        run_git_capture_stdout(cwd, &[], &["ls-files", "--others", "--exclude-standard"])?;

    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut untracked_diff = String::new();
    for file in untracked_files
        .split('\n')
        .map(str::trim)
        .filter(|file| !file.is_empty())
        .filter(|file| !is_kcoder_runtime_diff_path(file))
    {
        let diff = run_git_capture_diff(
            cwd,
            &filter_config_overrides,
            &[
                "diff",
                "--no-textconv",
                "--no-ext-diff",
                "--submodule=short",
                "--ignore-submodules=dirty",
                "--no-color",
                "--no-index",
                "--",
                null_device,
                file,
            ],
        )?;
        untracked_diff.push_str(&diff);
    }

    Ok(GitDiff {
        is_git_repo: true,
        text: format!("{tracked_diff}{untracked_diff}"),
    })
}

fn is_kcoder_runtime_diff_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    matches!(
        normalized.as_str(),
        ".kcoder/skills/.usage.json" | ".kcoder/skills/.usage.json.lock"
    )
}

fn format_git_diff_message(diff: &str) -> String {
    let (added, removed) = calculate_add_remove_from_diff(diff);
    let mut lines = vec![
        "[Tool diff: git]".to_string(),
        format!("git diff (+{added} -{removed})"),
    ];
    let rendered = render_unified_diff(
        diff,
        RenderDiffOptions::new(GIT_DIFF_WRAP_COLS, MAX_GIT_DIFF_LINES),
    );
    lines.extend(rendered.lines);
    if rendered.truncated {
        lines.push(format!(
            "... diff truncated after {MAX_GIT_DIFF_LINES} rendered rows ..."
        ));
    }
    lines.join("\n")
}

fn inside_git_repo(cwd: &Path) -> Result<bool, String> {
    let output = run_git_command(cwd, &[], &["rev-parse", "--is-inside-work-tree"])?;
    Ok(output.status.success())
}

fn diff_filter_config_overrides(cwd: &Path) -> Result<Vec<(String, String)>, String> {
    let args = [
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        EXECUTABLE_FILTER_CONFIG_PATTERN,
    ];
    let output = run_git_command(cwd, &[], &args)?;
    if !output.status.success() && output.status.code() != Some(1) {
        return Err(git_failure_message(&args, &output.status, &output.stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut drivers = stdout
        .split('\0')
        .filter_map(|key| {
            key.strip_suffix(".clean")
                .or_else(|| key.strip_suffix(".process"))
        })
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    drivers.sort();
    drivers.dedup();

    Ok(drivers
        .into_iter()
        .flat_map(|driver| {
            [
                (format!("{driver}.clean"), String::new()),
                (format!("{driver}.process"), String::new()),
                (format!("{driver}.required"), "false".to_string()),
            ]
        })
        .collect())
}

fn run_git_capture_stdout(
    cwd: &Path,
    config_overrides: &[(String, String)],
    args: &[&str],
) -> Result<String, String> {
    let output = run_git_command(cwd, config_overrides, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(git_failure_message(args, &output.status, &output.stderr))
    }
}

fn run_git_capture_diff(
    cwd: &Path,
    config_overrides: &[(String, String)],
    args: &[&str],
) -> Result<String, String> {
    let output = run_git_command(cwd, config_overrides, args)?;
    if output.status.success() || output.status.code() == Some(1) {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(git_failure_message(args, &output.status, &output.stderr))
    }
}

fn run_git_command(
    cwd: &Path,
    config_overrides: &[(String, String)],
    args: &[&str],
) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg(DISABLE_HOOKS_CONFIG);
    for (key, value) in config_overrides {
        command.arg("-c").arg(format!("{key}={value}"));
    }
    command.args(args);
    command
        .output()
        .map_err(|error| format!("failed to run git {:?}: {error}", args))
}

fn git_failure_message(args: &[&str], status: &ExitStatus, stderr: &[u8]) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    if stderr.is_empty() {
        format!("git {:?} failed with status {status}", args)
    } else {
        format!("git {:?} failed with status {status}: {stderr}", args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn format_git_diff_message_uses_existing_diff_renderer() {
        let message = format_git_diff_message("@@ -1 +1 @@\n-old\n+new\n");

        assert!(message.starts_with("[Tool diff: git]\ngit diff (+1 -1)"));
        assert!(message.contains("1 -old"));
        assert!(message.contains("1 +new"));
    }

    #[test]
    fn review_prompt_includes_optional_instructions() {
        let prompt = review_prompt("focus on panic paths");

        assert!(prompt.contains("Review my current changes"));
        assert!(prompt.contains("Inspect the git diff, including untracked files."));
        assert!(prompt.contains("Additional review instructions:"));
        assert!(prompt.contains("focus on panic paths"));
    }

    #[test]
    fn learn_prompt_preserves_request_and_points_at_skill_manage() {
        let prompt = learn_prompt("docs/api.md focus on auth flow");

        assert!(prompt.contains("docs/api.md focus on auth flow"));
        assert!(prompt.contains("skill_manage"));
        assert!(prompt.contains("DiscoverSkills"));
        assert!(prompt.contains("writing-skills"));
        assert!(prompt.contains("TodoWrite"));
        assert!(prompt.contains(".kcoder/skills/<name>/"));
        assert!(prompt.contains("action=\"view\""));
        assert!(prompt.contains("must not summarize the skill's workflow"));
        assert!(prompt.contains("without naming the skill"));
    }

    #[test]
    fn learn_prompt_empty_request_uses_conversation_fallback() {
        let prompt = learn_prompt("   ");

        assert!(prompt.contains("conversation"));
        assert!(prompt.contains("reusable KCoder skill"));
    }

    #[test]
    fn collect_git_diff_reports_non_repo() {
        if !git_is_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();

        let diff = collect_git_diff(tmp.path()).unwrap();

        assert!(!diff.is_git_repo);
        assert!(diff.text.is_empty());
    }

    #[test]
    fn collect_git_diff_includes_tracked_and_untracked_files() {
        if !git_is_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        run_git(tmp.path(), &["init"]);
        fs::write(tmp.path().join("tracked.txt"), "old\n").unwrap();
        run_git(tmp.path(), &["add", "tracked.txt"]);
        fs::write(tmp.path().join("tracked.txt"), "new\n").unwrap();
        fs::write(tmp.path().join("untracked.txt"), "fresh\n").unwrap();
        fs::create_dir_all(tmp.path().join(".kcoder/skills")).unwrap();
        fs::write(tmp.path().join(".kcoder/skills/.usage.json"), "{}\n").unwrap();
        fs::write(tmp.path().join(".kcoder/skills/.usage.json.lock"), "").unwrap();

        let diff = collect_git_diff(tmp.path()).unwrap();

        assert!(diff.is_git_repo);
        assert!(diff.text.contains("diff --git a/tracked.txt b/tracked.txt"));
        assert!(diff.text.contains("-old"));
        assert!(diff.text.contains("+new"));
        assert!(diff.text.contains("untracked.txt"));
        assert!(diff.text.contains("+fresh"));
        assert!(!diff.text.contains(".kcoder/skills/.usage.json"));
    }

    fn git_is_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("git should be available");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[derive(Default)]
pub(super) struct RewindCommand;

#[async_trait::async_trait]
impl SlashCommand for RewindCommand {
    fn name(&self) -> &'static str {
        "/rewind"
    }
    fn description(&self) -> &'static str {
        "Pick a prompt to rewind files and the conversation to the state before it: /rewind [turn]"
    }
    fn usage(&self) -> &'static str {
        "/rewind [turn]"
    }
    async fn run(&self, args: &str, app: &mut ReplApp, engine: &QueryEngine) -> SlashResult {
        let arg = args.trim();
        if arg.is_empty() {
            let entries = engine.user_request_turn_previews();
            if entries.is_empty() {
                app.push_message(MessageRole::System, "No prompts to rewind to yet.");
            } else {
                app.open_rewind_picker(entries);
            }
            return SlashResult::Handled;
        }
        let Ok(turn) = arg.parse::<u64>() else {
            app.push_message(MessageRole::System, "Usage: /rewind [turn]");
            return SlashResult::Handled;
        };
        match engine.checkpoints_rewind(turn).await {
            Ok((report, conversation)) => {
                let mut parts = vec![format!("Rewound to checkpoint turn {}.", turn)];
                if !report.restored.is_empty() {
                    parts.push(format!(
                        "Restored: {}",
                        report
                            .restored
                            .iter()
                            .map(|p| p.display().to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if !report.deleted.is_empty() {
                    parts.push(format!(
                        "Deleted: {}",
                        report
                            .deleted
                            .iter()
                            .map(|p| p.display().to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                if !report.failed.is_empty() {
                    parts.push(format!(
                        "FAILED: {}",
                        report
                            .failed
                            .iter()
                            .map(|(p, e)| format!("{} ({e})", p.display()))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
                match conversation {
                    Some(outcome) if outcome.removed > 0 => {
                        parts.push(format!(
                            "Conversation rewound ({} message(s) removed).",
                            outcome.removed
                        ));
                        // Rebuild the visible transcript from the engine's
                        // own message state — the same source the model sees —
                        // so the display always matches the truncated context
                        // (no disk read, no flusher timing, works without a
                        // history path).
                        let messages = engine.state.messages();
                        app.replace_transcript_from_history(&messages);
                    }
                    _ => {}
                }
                app.push_message(MessageRole::System, parts.join(" "));
            }
            Err(error) => {
                app.push_message(MessageRole::System, format!("Rewind failed: {error}"));
            }
        }
        SlashResult::Handled
    }
}
