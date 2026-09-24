use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;
use tracing::{debug, warn};

use crate::process::configure_isolated_process_environment;

/// Search file contents using ripgrep (with a simple regex fallback).
#[derive(Debug, Default)]
pub struct GrepTool;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GrepInput {
    /// Regular expression pattern to search for. Escape special regex
    /// characters when searching for a literal string.
    pub pattern: String,
    /// Optional directory or file to search in. Omit to search the current
    /// working directory.
    pub path: Option<String>,
    /// Optional glob filter such as `*.rs` or `src/**/*.ts`.
    pub glob: Option<String>,
    /// Output modes: `files_with_matches` lists files, `content` shows matching lines,
    /// and `count` reports per-file counts plus an exact global total. The default is `files_with_matches`.
    pub output_mode: Option<GrepOutputMode>,
    /// Number of lines to show before each content match.
    #[serde(rename = "-B")]
    pub before_context: Option<usize>,
    /// Number of lines to show after each content match.
    #[serde(rename = "-A")]
    pub after_context: Option<usize>,
    /// Number of lines to show before and after each content match.
    #[serde(rename = "-C")]
    #[schemars(skip)]
    pub context_flag: Option<usize>,
    /// Lines before and after each content match.
    pub context: Option<usize>,
    /// Show line numbers in content mode. Defaults to true.
    #[serde(rename = "-n")]
    pub line_numbers: Option<bool>,
    /// Case insensitive search.
    #[serde(rename = "-i")]
    pub case_insensitive: Option<bool>,
    /// Ripgrep file type filter such as `rust`, `js`, or `py`.
    #[serde(rename = "type")]
    pub file_type: Option<String>,
    /// Maximum output lines/entries, 1..=10000; defaults to 250. Zero is rejected.
    /// Count totals still include all matches; only displayed per-file rows are limited.
    #[schemars(range(min = 1, max = 10000))]
    pub head_limit: Option<usize>,
    /// Skip this many output lines/entries before applying `head_limit`.
    pub offset: Option<usize>,
    /// Enable ripgrep multiline mode (`-U --multiline-dotall`).
    pub multiline: Option<bool>,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GrepOutputMode {
    Content,
    FilesWithMatches,
    Count,
}

const DEFAULT_HEAD_LIMIT: usize = 250;
const VCS_DIRECTORIES_TO_EXCLUDE: &[&str] = &[".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];
const GENERATED_DIRECTORIES_TO_EXCLUDE: &[&str] = &[
    "target",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    "out",
];
const BROAD_SEARCH_FILE_LIMIT: usize = 500;
const BROAD_SEARCH_BYTE_LIMIT: u64 = 16 * 1024 * 1024;
const EXPENSIVE_SEARCH_FILE_LIMIT: usize = 2_000;
const EXPENSIVE_SEARCH_BYTE_LIMIT: u64 = 128 * 1024 * 1024;
const PREFLIGHT_ESTIMATE_TIME_LIMIT: Duration = Duration::from_millis(300);
const RIPGREP_TIMEOUT: Duration = Duration::from_secs(20);

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> String {
        "grep".to_string()
    }

    fn description(&self) -> String {
        "A powerful search tool built on ripgrep. Use it for project content search instead of shell `grep` or `rg`. Supports regex patterns, \
         glob/type filters, output_mode (`files_with_matches`, `content`, `count`), \
         context lines, case-insensitive search, pagination, and multiline matching. \
         `count` includes an exact aggregate across the full search even when per-file rows are paginated. \
         Its output is bounded and may be truncated; follow the returned limit/truncation guidance."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(GrepInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: GrepInput = parse_input(&input)?;
        if input
            .head_limit
            .is_some_and(|limit| limit == 0 || limit > 10_000)
        {
            return Ok(ToolOutput::error(
                "head_limit must be in 1..=10000; zero no longer requests unlimited output. Omit it for 250, or paginate with offset. Count mode still computes the full aggregate.",
            ));
        }
        if let (Some(context), Some(legacy)) = (input.context, input.context_flag) {
            if context != legacy {
                return Err(ToolError::InvalidInput(
                    "Conflicting context and legacy -C values; use context only".into(),
                ));
            }
        }

        let base = input
            .path
            .as_ref()
            .map(|p| resolve_path(p, &ctx.state.cwd()))
            .unwrap_or_else(|| ctx.state.cwd());

        if let Some(sandbox) = &ctx.sandbox {
            sandbox
                .check_path(&base, false)
                .map_err(ToolError::Execution)?;
        }

        debug!(
            "grep pattern_chars={} under {:?}",
            input.pattern.chars().count(),
            base
        );

        if let Some(error) = unbounded_broad_search_error(&input, &base, &ctx.state.cwd()) {
            return Ok(ToolOutput::error(error));
        }
        if let Some(error) = expensive_unbounded_search_error(&input, &base, &ctx.state.cwd()) {
            return Ok(ToolOutput::error(error));
        }

        if let Some(rg_path) = crate::ripgrep::find_ripgrep() {
            run_ripgrep(&input, &base, ctx, &rg_path).await
        } else {
            warn!("ripgrep not found, falling back to regex scan");
            regex_fallback(&input, &base, ctx).await
        }
    }
}

async fn run_ripgrep(
    input: &GrepInput,
    base: &std::path::Path,
    ctx: &ToolContext,
    rg_path: &Path,
) -> Result<ToolOutput, ToolError> {
    run_ripgrep_with_timeout(input, base, ctx, rg_path, RIPGREP_TIMEOUT).await
}

async fn run_ripgrep_with_timeout(
    input: &GrepInput,
    base: &std::path::Path,
    ctx: &ToolContext,
    rg_path: &Path,
    process_timeout: Duration,
) -> Result<ToolOutput, ToolError> {
    let mode = input
        .output_mode
        .unwrap_or(GrepOutputMode::FilesWithMatches);
    let cwd = ctx.state.cwd();
    let mut cmd = Command::new(rg_path);
    cmd.arg("--hidden").arg("--max-columns").arg("500");

    for dir in VCS_DIRECTORIES_TO_EXCLUDE {
        cmd.arg("--glob").arg(format!("!{dir}"));
        cmd.arg("--glob").arg(format!("!{dir}/**"));
    }
    if !path_contains_named_dir(base, GENERATED_DIRECTORIES_TO_EXCLUDE) {
        for dir in GENERATED_DIRECTORIES_TO_EXCLUDE {
            cmd.arg("--glob").arg(format!("!{dir}"));
            cmd.arg("--glob").arg(format!("!{dir}/**"));
        }
    }

    if input.multiline.unwrap_or(false) {
        cmd.arg("-U").arg("--multiline-dotall");
    }

    if input.case_insensitive.unwrap_or(false) {
        cmd.arg("-i");
    }

    match mode {
        GrepOutputMode::FilesWithMatches => {
            cmd.arg("-l");
        }
        GrepOutputMode::Count => {
            cmd.arg("-c");
        }
        GrepOutputMode::Content => {
            // Make the path boundary unambiguous. File names may legally
            // contain colons and `:digits:` on Unix, so the normal human
            // output cannot be parsed reliably.
            cmd.arg("--null");
            if input.line_numbers.unwrap_or(true) {
                cmd.arg("-n");
            }
            if let Some(context) = input.context.or(input.context_flag) {
                cmd.arg("-C").arg(context.to_string());
            } else {
                if let Some(before) = input.before_context {
                    cmd.arg("-B").arg(before.to_string());
                }
                if let Some(after) = input.after_context {
                    cmd.arg("-A").arg(after.to_string());
                }
            }
        }
    }

    if input.pattern.starts_with('-') {
        cmd.arg("-e").arg(&input.pattern);
    } else {
        cmd.arg(&input.pattern);
    }

    if let Some(file_type) = &input.file_type {
        cmd.arg("--type").arg(file_type);
    }

    if let Some(glob) = &input.glob {
        for glob_pattern in split_glob_patterns(glob) {
            cmd.arg("--glob").arg(glob_pattern);
        }
    }

    cmd.arg(base);
    configure_isolated_process_environment(&mut cmd, &cwd);
    cmd.current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);

    let child = cmd
        .spawn()
        .map_err(|e| ToolError::Execution(format!("failed to run rg: {}", e)))?;
    let process_tree = child
        .id()
        .map(RipgrepProcessTreeTerminator::new)
        .ok_or_else(|| {
            ToolError::Execution("rg process did not expose a process id".to_string())
        })?;

    let output = match timeout(process_timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            process_tree.disarm();
            output
        }
        Ok(Err(e)) => {
            return Err(ToolError::Execution(format!(
                "failed to wait for rg: {}",
                e
            )));
        }
        Err(_) => {
            return Ok(ToolOutput::error(grep_timeout_message(
                input,
                base,
                &ctx.state.cwd(),
                process_timeout,
            )));
        }
    };

    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Ok(ToolOutput::error(format!(
            "ripgrep failed with status {}: {}",
            output.status,
            stderr.trim()
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let raw_lines: Vec<String> = stdout.lines().map(|line| line.to_string()).collect();
    let text = format_rg_results(mode, raw_lines, input, base, &ctx.state.cwd());
    Ok(ToolOutput::text(ctx.truncate(&text)))
}

struct RipgrepProcessTreeTerminator {
    pid: u32,
    finished: AtomicBool,
}

impl RipgrepProcessTreeTerminator {
    fn new(pid: u32) -> Self {
        Self {
            pid,
            finished: AtomicBool::new(false),
        }
    }

    fn terminate(&self) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        unsafe {
            let pid = self.pid as libc::pid_t;
            if libc::kill(-pid, libc::SIGKILL) != 0 {
                let _ = libc::kill(pid, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }

    fn disarm(&self) {
        self.finished.store(true, Ordering::SeqCst);
    }
}

impl Drop for RipgrepProcessTreeTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn grep_timeout_message(
    input: &GrepInput,
    base: &Path,
    cwd: &Path,
    process_timeout: Duration,
) -> String {
    let estimate = estimate_broad_search_cost(base);
    let mut text = format!(
        "grep stopped after {} ms before the session-level tool timeout. The search did not finish under `{}`.",
        process_timeout.as_millis(),
        base.display()
    );

    text.push_str(&format!(
        "\n\nPreflight estimate for this search root: {} over {}.",
        estimate.file_count_label(),
        estimate.byte_count_label()
    ));

    if search_has_scope(input, base, cwd) {
        text.push_str(
            "\n\nThe request had a filter, but filtered searches can still be expensive when the root is broad, the pattern is common, or the filesystem is under load.",
        );
    }

    text.push_str(
        "\n\nUse a narrower grep request:\n- Set `path` to the smallest relevant directory or file, for example `path: \"crates/kcoder_tools/src\"`.\n- Keep `type` or `glob` filters, but do not rely on them as the only bound for a large workspace.\n- Use a more specific `pattern` when possible.\n- For content output, keep `head_limit` small; note that pagination limits output, not the initial search root.",
    );

    text
}

async fn regex_fallback(
    input: &GrepInput,
    base: &std::path::Path,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    let mode = input
        .output_mode
        .unwrap_or(GrepOutputMode::FilesWithMatches);
    let regex = regex::RegexBuilder::new(&input.pattern)
        .case_insensitive(input.case_insensitive.unwrap_or(false))
        .build()
        .map_err(|e| ToolError::InvalidInput(format!("invalid regex: {}", e)))?;

    let mut content_results = Vec::new();
    let mut file_results = Vec::new();
    let mut count_results = Vec::new();
    let glob_matcher = input
        .glob
        .as_ref()
        .and_then(|g| globset::Glob::new(g).ok().map(|g| g.compile_matcher()));

    for entry in walkdir::WalkDir::new(base)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        // `follow_links(false)` stops directory traversal, but `Path::is_file`
        // follows symlinks via fs::metadata and would happily read a symlink
        // target outside the sandbox. Filter on the walker's own file type,
        // which never follows the final link.
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if let Some(matcher) = &glob_matcher
            && !matcher.is_match(path)
        {
            continue;
        }

        let content = match tokio::fs::read_to_string(path).await {
            Ok(c) => c,
            Err(_) => continue, // skip binary / unreadable files
        };

        let relative = path
            .strip_prefix(base)
            .unwrap_or(path)
            .display()
            .to_string();
        let lines = content.lines().collect::<Vec<_>>();
        let matched_lines = lines
            .iter()
            .enumerate()
            .filter_map(|(idx, line)| regex.is_match(line).then_some(idx))
            .collect::<Vec<_>>();
        let file_match_count = matched_lines.len();
        if mode == GrepOutputMode::Content && file_match_count > 0 {
            let context = input.context.or(input.context_flag).unwrap_or(0);
            let before = input.before_context.unwrap_or(context);
            let after = input.after_context.unwrap_or(context);
            let mut selected = vec![false; lines.len()];
            for idx in matched_lines {
                let start = idx.saturating_sub(before);
                let end = idx.saturating_add(after).min(lines.len().saturating_sub(1));
                for item in &mut selected[start..=end] {
                    *item = true;
                }
            }
            for (idx, line) in lines.iter().enumerate() {
                if selected[idx] {
                    content_results.push(format!("{}:{}: {}", relative, idx + 1, line.trim_end()));
                }
            }
        }
        if file_match_count > 0 {
            if mode == GrepOutputMode::FilesWithMatches {
                file_results.push((relative.clone(), file_modified_time(path)));
            } else if mode == GrepOutputMode::Count {
                count_results.push(format!("{}:{}", relative, file_match_count));
            }
        }
    }

    let text = match mode {
        GrepOutputMode::Content => {
            let (items, applied_limit) =
                apply_head_limit(content_results, input.head_limit, input.offset.unwrap_or(0));
            if items.is_empty() {
                "No matches found".to_string()
            } else {
                let mut text = items.join("\n");
                append_pagination_note(&mut text, applied_limit, input.offset.unwrap_or(0));
                text
            }
        }
        GrepOutputMode::FilesWithMatches => {
            file_results.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            let files: Vec<String> = file_results.into_iter().map(|(path, _)| path).collect();
            format_files_with_matches(files, input)
        }
        GrepOutputMode::Count => format_count_results(count_results, input),
    };
    Ok(ToolOutput::text(ctx.truncate(&text)))
}

fn resolve_path(path: &str, cwd: &std::path::Path) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() { p } else { cwd.join(p) }
}

fn unbounded_broad_search_error(input: &GrepInput, base: &Path, cwd: &Path) -> Option<String> {
    if search_has_scope(input, base, cwd) {
        return None;
    }

    let reason = broad_pattern_reason(&input.pattern)?;
    let estimate = estimate_broad_search_cost(base);
    if estimate.is_within_limit() {
        return None;
    }

    Some(format!(
        "Refusing to run an unbounded grep because {reason}. Preflight estimated {} over {} under `{}` before starting ripgrep, so this match-all search would scan too much text before pagination is applied.\n\nUse a safer grep request:\n- Narrow `path` to a subdirectory or file, for example `path: \"crates/kcoder_tools/src\"`.\n- Add a ripgrep `type` filter such as `type: \"rust\"`; this is usually faster than a broad `glob`.\n- Add a specific `glob`, for example `glob: \"*.rs\"`.\n- Use a more specific `pattern`, such as `TODO`, `fn main`, an identifier, or an error string.\n- Do not use `head_limit: 0` for whole-repository scans; `head_limit` is applied after grep returns results, so it cannot make a match-all search cheap.",
        estimate.file_count_label(),
        estimate.byte_count_label(),
        base.display()
    ))
}

fn expensive_unbounded_search_error(input: &GrepInput, base: &Path, cwd: &Path) -> Option<String> {
    if has_type_or_glob_filter(input) || path_provides_narrow_scope(input, base, cwd) {
        return None;
    }

    if is_home_directory(base) {
        return Some(format!(
            "Refusing to run an unbounded grep over `{}` because it is a home directory root that commonly contains hidden cache, session, credential, and tool-state folders. This kind of search can appear to hang until the session-level timeout.\n\nUse a safer grep request:\n- Narrow `path` to a project subdirectory or file, for example `path: \"KCoder/crates\"`.\n- Add a ripgrep `type` filter such as `type: \"rust\"`, `type: \"py\"`, or `type: \"ts\"`.\n- Add a specific `glob`, for example `glob: \"*.rs\"` or `glob: \"**/*.py\"`.\n- Avoid searching an entire home directory unless you explicitly need hidden tool caches and session histories.",
            base.display(),
        ));
    }

    let estimate = estimate_expensive_search_cost(base);
    if estimate.files <= EXPENSIVE_SEARCH_FILE_LIMIT
        && estimate.bytes <= EXPENSIVE_SEARCH_BYTE_LIMIT
    {
        return None;
    }

    Some(format!(
        "Refusing to run an unbounded grep over `{}` because preflight estimated {} over {} before starting ripgrep. Even with a specific pattern, this root is broad enough that the search can appear to hang before the session-level timeout.\n\nUse a safer grep request:\n- Narrow `path` to the smallest relevant directory or file, for example `path: \"crates/kcoder_tools/src\"`.\n- Add a ripgrep `type` filter such as `type: \"rust\"`, `type: \"py\"`, or `type: \"ts\"`.\n- Add a specific `glob`, for example `glob: \"*.rs\"` or `glob: \"**/*.py\"`.\n- Avoid searching parent workspaces that include generated run artifacts such as `target/tui-lab` unless you explicitly need them.",
        base.display(),
        estimate.file_count_label_with_limit(EXPENSIVE_SEARCH_FILE_LIMIT),
        estimate.byte_count_label_with_limit(EXPENSIVE_SEARCH_BYTE_LIMIT),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SearchScopeEstimate {
    files: usize,
    bytes: u64,
    crossed_limit: bool,
}

impl SearchScopeEstimate {
    fn is_within_limit(self) -> bool {
        !self.crossed_limit
    }

    fn file_count_label(self) -> String {
        self.file_count_label_with_limit(BROAD_SEARCH_FILE_LIMIT)
    }

    fn file_count_label_with_limit(self, limit: usize) -> String {
        if self.crossed_limit && self.files > limit {
            format!("more than {limit} files")
        } else {
            format!(
                "{} {}",
                self.files,
                if self.files == 1 { "file" } else { "files" }
            )
        }
    }

    fn byte_count_label(self) -> String {
        self.byte_count_label_with_limit(BROAD_SEARCH_BYTE_LIMIT)
    }

    fn byte_count_label_with_limit(self, limit: u64) -> String {
        let bytes = human_bytes(self.bytes);
        if self.crossed_limit && self.bytes > limit {
            format!("more than {bytes}")
        } else {
            bytes
        }
    }
}

fn estimate_broad_search_cost(base: &Path) -> SearchScopeEstimate {
    estimate_search_cost(base, BROAD_SEARCH_FILE_LIMIT, BROAD_SEARCH_BYTE_LIMIT)
}

fn estimate_expensive_search_cost(base: &Path) -> SearchScopeEstimate {
    estimate_search_cost(
        base,
        EXPENSIVE_SEARCH_FILE_LIMIT,
        EXPENSIVE_SEARCH_BYTE_LIMIT,
    )
}

fn estimate_search_cost(base: &Path, file_limit: usize, byte_limit: u64) -> SearchScopeEstimate {
    let started_at = Instant::now();
    let mut estimate = SearchScopeEstimate {
        files: 0,
        bytes: 0,
        crossed_limit: false,
    };

    if base.is_file() {
        estimate.files = 1;
        estimate.bytes = base.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        estimate.crossed_limit = estimate.files > file_limit || estimate.bytes > byte_limit;
        return estimate;
    }

    for entry in walkdir::WalkDir::new(base)
        .follow_links(false)
        .into_iter()
        .filter_entry(should_descend_for_grep_estimate)
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if started_at.elapsed() >= PREFLIGHT_ESTIMATE_TIME_LIMIT {
            estimate.files = estimate.files.max(file_limit.saturating_add(1));
            estimate.bytes = estimate.bytes.max(byte_limit.saturating_add(1));
            estimate.crossed_limit = true;
            break;
        }
        estimate.files = estimate.files.saturating_add(1);
        estimate.bytes = estimate
            .bytes
            .saturating_add(entry.metadata().map(|metadata| metadata.len()).unwrap_or(0));
        if estimate.files > file_limit || estimate.bytes > byte_limit {
            estimate.crossed_limit = true;
            break;
        }
    }

    estimate
}

fn should_descend_for_grep_estimate(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    let Some(name) = entry.file_name().to_str() else {
        return true;
    };
    !VCS_DIRECTORIES_TO_EXCLUDE.contains(&name) && !GENERATED_DIRECTORIES_TO_EXCLUDE.contains(&name)
}

fn human_bytes(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let bytes_f = bytes as f64;
    if bytes_f >= GIB {
        format!("{:.1} GiB", bytes_f / GIB)
    } else if bytes_f >= MIB {
        format!("{:.1} MiB", bytes_f / MIB)
    } else if bytes_f >= KIB {
        format!("{:.1} KiB", bytes_f / KIB)
    } else {
        format!("{bytes} B")
    }
}

fn search_has_scope(input: &GrepInput, base: &Path, cwd: &Path) -> bool {
    if has_type_or_glob_filter(input) {
        return true;
    }

    path_provides_narrow_scope(input, base, cwd)
}

fn has_type_or_glob_filter(input: &GrepInput) -> bool {
    if input
        .glob
        .as_deref()
        .is_some_and(|glob| !glob.trim().is_empty())
    {
        return true;
    }

    input
        .file_type
        .as_deref()
        .is_some_and(|file_type| !file_type.trim().is_empty())
}

fn path_provides_narrow_scope(input: &GrepInput, base: &Path, cwd: &Path) -> bool {
    input
        .path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
        && {
            let base = normalize_path_lexically(base);
            let cwd = normalize_path_lexically(cwd);
            base != cwd && !crate::sandbox::path_starts_with(&cwd, &base)
        }
}

fn path_contains_named_dir(path: &Path, names: &[&str]) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name.to_str().is_some_and(|name| names.contains(&name)),
        _ => false,
    })
}

fn is_home_directory(path: &Path) -> bool {
    let normalized = normalize_path_lexically(path);
    if let Some(home) = dirs::home_dir()
        && normalized == normalize_path_lexically(&home)
    {
        return true;
    }

    false
}

fn broad_pattern_reason(pattern: &str) -> Option<&'static str> {
    if pattern.trim().is_empty() {
        return Some("the pattern is empty or whitespace-only");
    }

    if is_whitespace_class_pattern(pattern) {
        return Some("the pattern searches only for whitespace");
    }

    let regex = regex::Regex::new(pattern).ok()?;
    if regex.is_match("") {
        return Some("the pattern can match the empty string");
    }

    if matches_nearly_every_one_character_line(&regex) {
        return Some("the pattern matches nearly every non-empty line");
    }

    None
}

fn is_whitespace_class_pattern(pattern: &str) -> bool {
    let compact: String = pattern.chars().filter(|c| !c.is_whitespace()).collect();
    matches!(
        compact.as_str(),
        r"\s"
            | r"\s+"
            | r"[[:space:]]"
            | r"[[:space:]]+"
            | r"\p{White_Space}"
            | r"\p{White_Space}+"
    )
}

fn matches_nearly_every_one_character_line(regex: &regex::Regex) -> bool {
    const SAMPLES: &[&str] = &["a", "Z", "0", "_", "/", "{", "}", " ", "\t", "中"];
    SAMPLES.iter().all(|sample| regex.is_match(sample))
}

fn normalize_path_lexically(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    normalized.push(component.as_os_str());
                }
            }
            Component::Normal(_) | Component::Prefix(_) | Component::RootDir => {
                normalized.push(component.as_os_str());
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        normalized
    }
}

fn format_rg_results(
    mode: GrepOutputMode,
    lines: Vec<String>,
    input: &GrepInput,
    base: &Path,
    cwd: &Path,
) -> String {
    match mode {
        GrepOutputMode::Content => {
            let (items, applied_limit) =
                apply_head_limit(lines, input.head_limit, input.offset.unwrap_or(0));
            if items.is_empty() {
                return "No matches found".to_string();
            }
            let mut text = items
                .into_iter()
                .map(|line| relativize_rg_line(&line, cwd))
                .collect::<Vec<_>>()
                .join("\n");
            append_pagination_note(&mut text, applied_limit, input.offset.unwrap_or(0));
            text
        }
        GrepOutputMode::FilesWithMatches => {
            let mut files = lines
                .into_iter()
                .map(|line| {
                    let modified = file_modified_time(Path::new(&line));
                    (to_relative_path(&line, cwd, base), modified)
                })
                .collect::<Vec<_>>();
            files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            format_files_with_matches(files.into_iter().map(|(path, _)| path).collect(), input)
        }
        GrepOutputMode::Count => {
            let count_lines = lines
                .into_iter()
                .map(|line| relativize_count_line(&line, cwd, base))
                .collect::<Vec<_>>();
            format_count_results(count_lines, input)
        }
    }
}

fn format_files_with_matches(files: Vec<String>, input: &GrepInput) -> String {
    let (items, applied_limit) =
        apply_head_limit(files, input.head_limit, input.offset.unwrap_or(0));
    if items.is_empty() {
        return "No files found".to_string();
    }
    let mut text = format!("Found {} files\n{}", items.len(), items.join("\n"));
    append_pagination_note(&mut text, applied_limit, input.offset.unwrap_or(0));
    text
}

fn format_count_results(lines: Vec<String>, input: &GrepInput) -> String {
    let total_matches = lines
        .iter()
        .filter_map(|line| line.rsplit_once(':'))
        .filter_map(|(_, count)| count.parse::<usize>().ok())
        .sum::<usize>();
    let file_count = lines
        .iter()
        .filter(|line| {
            line.rsplit_once(':')
                .is_some_and(|(_, count)| count.parse::<usize>().is_ok())
        })
        .count();
    let (items, applied_limit) =
        apply_head_limit(lines, input.head_limit, input.offset.unwrap_or(0));
    if total_matches == 0 {
        return "No matches found".to_string();
    }
    let mut text = items.join("\n");
    text.push_str(&format!(
        "\n\nFound {} total {} across {} {}.",
        total_matches,
        if total_matches == 1 {
            "occurrence"
        } else {
            "occurrences"
        },
        file_count,
        if file_count == 1 { "file" } else { "files" }
    ));
    append_pagination_note(&mut text, applied_limit, input.offset.unwrap_or(0));
    text
}

fn apply_head_limit<T>(
    items: Vec<T>,
    limit: Option<usize>,
    offset: usize,
) -> (Vec<T>, Option<usize>) {
    // Model and direct-tool entry points reject zero. Internal callers remain bounded.
    let effective_limit = limit.unwrap_or(DEFAULT_HEAD_LIMIT).clamp(1, 10_000);
    let total_after_offset = items.len().saturating_sub(offset);
    let applied_limit = (total_after_offset > effective_limit).then_some(effective_limit);
    (
        items
            .into_iter()
            .skip(offset)
            .take(effective_limit)
            .collect(),
        applied_limit,
    )
}

fn append_pagination_note(text: &mut String, applied_limit: Option<usize>, offset: usize) {
    let mut parts = Vec::new();
    if let Some(limit) = applied_limit {
        parts.push(format!("limit: {limit}"));
    }
    if offset > 0 {
        parts.push(format!("offset: {offset}"));
    }
    if !parts.is_empty() {
        text.push_str(&format!(
            "\n\n[Showing results with pagination = {}]",
            parts.join(", ")
        ));
    }
}

fn split_glob_patterns(glob: &str) -> Vec<&str> {
    let mut patterns = Vec::new();
    for raw in glob.split_whitespace() {
        if raw.contains('{') && raw.contains('}') {
            patterns.push(raw);
        } else {
            patterns.extend(raw.split(',').filter(|part| !part.is_empty()));
        }
    }
    patterns
}

fn relativize_rg_line(line: &str, cwd: &Path) -> String {
    // Content-mode ripgrep is invoked with `--null`, yielding
    // `path\0line:text` (or `path\0line-context`).
    let Some((path, rest)) = line.split_once('\0') else {
        return line.to_string();
    };
    format!("{}:{}", to_relative_path(path, cwd, cwd), rest)
}

fn relativize_count_line(line: &str, cwd: &Path, base: &Path) -> String {
    let Some((path, count)) = line.rsplit_once(':') else {
        return line.to_string();
    };
    format!("{}:{}", to_relative_path(path, cwd, base), count)
}

#[cfg(test)]
mod line_parse_tests {
    use super::*;

    #[test]
    fn nul_delimiter_handles_windows_and_colon_paths() {
        assert_eq!(
            relativize_rg_line("C:\\repo\\a.rs\x0012:match", Path::new(r"C:\repo")),
            "a.rs:12:match"
        );
        assert_eq!(
            relativize_rg_line("/repo/src/a.rs\x0012:match", Path::new("/repo")),
            "src/a.rs:12:match"
        );
        assert_eq!(
            relativize_rg_line(
                "/repo/src/weird:5:part.rs\x0012:value:99:text",
                Path::new("/repo")
            ),
            "src/weird:5:part.rs:12:value:99:text"
        );
        assert_eq!(
            relativize_rg_line("no delimiter here", Path::new("/repo")),
            "no delimiter here"
        );
    }
}

fn to_relative_path(path: &str, cwd: &Path, base: &Path) -> String {
    let path = Path::new(path);
    if let Ok(relative) = path.strip_prefix(cwd) {
        return relative.display().to_string();
    }
    if let Ok(relative) = path.strip_prefix(base) {
        return relative.display().to_string();
    }
    // Textual fallback: a Windows-style path (`C:\repo\a.rs`) contains no
    // separators on Unix hosts, so std::path prefix stripping above cannot
    // relativize it. rg output arrives as text; strip a string prefix
    // followed by either separator shape.
    if let Some(stripped) = strip_prefix_text(&path.to_string_lossy(), &cwd.to_string_lossy())
        .or_else(|| strip_prefix_text(&path.to_string_lossy(), &base.to_string_lossy()))
    {
        return stripped;
    }
    path.display().to_string()
}

/// Strip `prefix` from `path` when it is followed by a `/` or `\` separator.
fn strip_prefix_text(path: &str, prefix: &str) -> Option<String> {
    let rest = path.strip_prefix(prefix)?;
    rest.strip_prefix(['/', '\\']).map(str::to_string)
}

fn file_modified_time(path: &Path) -> std::time::SystemTime {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;
    use serde_json::json;

    fn grep_input_for_content() -> GrepInput {
        GrepInput {
            pattern: "home".to_string(),
            path: None,
            glob: None,
            output_mode: Some(GrepOutputMode::Content),
            before_context: None,
            after_context: None,
            context_flag: None,
            context: None,
            line_numbers: Some(true),
            case_insensitive: None,
            file_type: None,
            head_limit: None,
            offset: None,
            multiline: None,
        }
    }

    fn grep_input_with_pattern(pattern: &str) -> GrepInput {
        let mut input = grep_input_for_content();
        input.pattern = pattern.to_string();
        input.output_mode = None;
        input
    }

    fn tool_text(output: &ToolOutput) -> String {
        output
            .content
            .iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>()
    }

    #[tokio::test]
    async fn zero_and_excessive_limits_are_rejected_even_for_narrow_count_searches() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("one.txt"), "needle\nneedle\n").unwrap();
        let ctx = ToolContext::new(AppState::new(dir.path()));
        for limit in [0, 10001] {
            let result = GrepTool.call(json!({"pattern":"needle","path":"one.txt","output_mode":"count","head_limit":limit}), &ctx).await.unwrap();
            assert!(result.is_error);
            assert!(tool_text(&result).contains("1..=10000"));
        }
        let result = GrepTool
            .call(
                json!({"pattern":"needle","output_mode":"count","head_limit":1}),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!result.is_error);
        assert!(tool_text(&result).contains("Found 2 total occurrences across 1 file."));
    }

    #[test]
    fn count_aggregate_survives_row_limit_and_empty_pages() {
        let mut input = grep_input_with_pattern("needle");
        input.head_limit = Some(1);
        let lines = vec!["one.txt:2".to_string(), "two.txt:3".to_string()];
        let page = format_count_results(lines.clone(), &input);
        assert!(page.contains("Found 5 total occurrences across 2 files."));
        assert!(page.contains("one.txt:2"));
        assert!(!page.contains("two.txt:3"));
        input.offset = Some(99);
        let empty_page = format_count_results(lines, &input);
        assert!(empty_page.contains("Found 5 total occurrences across 2 files."));
        assert!(!empty_page.contains("No matches found"));
    }

    #[test]
    fn broad_search_guard_rejects_unbounded_match_all_patterns() {
        let tmp = tempfile::tempdir().unwrap();
        for index in 0..=BROAD_SEARCH_FILE_LIMIT {
            std::fs::write(tmp.path().join(format!("file-{index:03}.txt")), "x\n").unwrap();
        }
        let cwd = tmp.path().to_path_buf();
        for pattern in ["", "   ", ".", ".+", ".*", "^", "$", r"\s", r"\s+"] {
            let mut input = grep_input_with_pattern(pattern);
            input.head_limit = Some(0);

            let message = unbounded_broad_search_error(&input, &cwd, &cwd)
                .unwrap_or_else(|| panic!("expected broad-search guard for {pattern:?}"));

            assert!(message.contains("Refusing to run an unbounded grep"));
            assert!(message.contains("Preflight estimated"));
            assert!(message.contains("more than 500 files"));
            assert!(message.contains("path"));
            assert!(message.contains("type"));
            assert!(message.contains("glob"));
            assert!(message.contains("head_limit: 0"));
        }
    }

    #[test]
    fn broad_search_guard_allows_specific_patterns_and_scoped_searches() {
        let cwd = PathBuf::from("/repo");
        for pattern in ["TODO", "fn main", "error|warning"] {
            let mut input = grep_input_with_pattern(pattern);
            input.head_limit = Some(0);
            assert!(
                unbounded_broad_search_error(&input, &cwd, &cwd).is_none(),
                "specific pattern should be allowed: {pattern}"
            );
        }

        let mut path_scoped = grep_input_with_pattern(".");
        path_scoped.path = Some("src".to_string());
        assert!(unbounded_broad_search_error(&path_scoped, &cwd.join("src"), &cwd).is_none());

        let mut file_scoped = grep_input_with_pattern(".");
        file_scoped.path = Some("Cargo.toml".to_string());
        assert!(
            unbounded_broad_search_error(&file_scoped, &cwd.join("Cargo.toml"), &cwd).is_none()
        );

        let mut type_scoped = grep_input_with_pattern(".");
        type_scoped.file_type = Some("rust".to_string());
        assert!(unbounded_broad_search_error(&type_scoped, &cwd, &cwd).is_none());

        let mut glob_scoped = grep_input_with_pattern(".");
        glob_scoped.glob = Some("*.rs".to_string());
        assert!(unbounded_broad_search_error(&glob_scoped, &cwd, &cwd).is_none());

        let tmp = tempfile::tempdir().unwrap();
        for index in 0..=BROAD_SEARCH_FILE_LIMIT {
            std::fs::write(tmp.path().join(format!("file-{index:03}.txt")), "x\n").unwrap();
        }
        let mut current_dir_path = grep_input_with_pattern(".");
        current_dir_path.path = Some(".".to_string());
        assert!(
            unbounded_broad_search_error(&current_dir_path, &tmp.path().join("."), tmp.path())
                .is_some()
        );
    }

    #[test]
    fn broad_search_guard_allows_small_unbounded_match_all_pattern() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("small.txt"), "tiny\n").unwrap();
        let input = grep_input_with_pattern(".");

        assert!(unbounded_broad_search_error(&input, tmp.path(), tmp.path()).is_none());
    }

    #[test]
    fn expensive_search_guard_rejects_large_unbounded_specific_pattern() {
        let tmp = tempfile::tempdir().unwrap();
        for index in 0..=EXPENSIVE_SEARCH_FILE_LIMIT {
            std::fs::write(tmp.path().join(format!("file-{index:04}.txt")), "TODO\n").unwrap();
        }
        let input = grep_input_with_pattern("TODO");

        let message = expensive_unbounded_search_error(&input, tmp.path(), tmp.path())
            .expect("large unbounded specific searches should be rejected before ripgrep");

        assert!(
            message.contains("Refusing to run an unbounded grep"),
            "{message}"
        );
        assert!(message.contains("more than 2000 files"), "{message}");
        assert!(message.contains("type: \"rust\""), "{message}");
    }

    #[test]
    fn expensive_search_guard_rejects_home_directory_unbounded_searches() {
        let input = grep_input_with_pattern("TODO");
        let home = dirs::home_dir().expect("the current user's home directory should be available");

        let message = expensive_unbounded_search_error(&input, &home, &home)
            .expect("home directory searches should be rejected without walking the tree");

        assert!(message.contains("home directory root"), "{message}");
        assert!(message.contains("type: \"rust\""), "{message}");
        assert!(!is_home_directory(Path::new(
            "/data/devuser/20260629_agent"
        )));
    }

    #[test]
    fn search_estimate_skips_generated_dirs_unless_they_are_explicit_root() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target");
        std::fs::create_dir_all(&target).unwrap();
        for index in 0..=EXPENSIVE_SEARCH_FILE_LIMIT {
            std::fs::write(target.join(format!("file-{index:04}.txt")), "TODO\n").unwrap();
        }
        std::fs::write(tmp.path().join("visible.txt"), "TODO\n").unwrap();

        let default_root = estimate_expensive_search_cost(tmp.path());
        assert_eq!(default_root.files, 1);
        assert!(!default_root.crossed_limit);

        let explicit_target_root = estimate_expensive_search_cost(&target);
        assert!(explicit_target_root.crossed_limit);
        assert!(explicit_target_root.files > EXPENSIVE_SEARCH_FILE_LIMIT);
    }

    #[tokio::test]
    async fn grep_tool_allows_large_type_filtered_specific_search() {
        let tmp = tempfile::tempdir().unwrap();
        for index in 0..=EXPENSIVE_SEARCH_FILE_LIMIT {
            std::fs::write(tmp.path().join(format!("file-{index:04}.txt")), "TODO\n").unwrap();
        }
        std::fs::write(tmp.path().join("src.rs"), "fn target() {}\n").unwrap();

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = GrepTool
            .call(
                json!({ "pattern": "target", "type": "rust", "output_mode": "content" }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(!output.is_error);
        assert!(tool_text(&output).contains("fn target()"));
    }

    #[tokio::test]
    async fn grep_tool_rejects_unbounded_dot_search_before_running_grep() {
        let tmp = tempfile::tempdir().unwrap();
        for index in 0..=BROAD_SEARCH_FILE_LIMIT {
            std::fs::write(
                tmp.path().join(format!("file-{index:03}.txt")),
                "fn main() {}\n",
            )
            .unwrap();
        }

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = GrepTool
            .call(json!({ "pattern": ".", "head_limit": 0 }), &ctx)
            .await
            .unwrap();

        assert!(output.is_error);
        let text = tool_text(&output);
        assert!(text.contains("head_limit must be in 1..=10000"), "{text}");
        assert!(text.contains("zero no longer requests unlimited"), "{text}");
    }

    #[tokio::test]
    async fn grep_tool_allows_small_unbounded_dot_search() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("src.rs"), "fn main() {}\n").unwrap();

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = GrepTool
            .call(json!({ "pattern": ".", "output_mode": "content" }), &ctx)
            .await
            .unwrap();

        assert!(!output.is_error);
        assert!(tool_text(&output).contains("fn main()"));
    }

    #[tokio::test]
    async fn grep_tool_allows_specific_unbounded_pattern() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("src.rs"), "TODO: tighten grep guard\n").unwrap();

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = GrepTool
            .call(json!({ "pattern": "TODO", "output_mode": "content" }), &ctx)
            .await
            .unwrap();

        assert!(!output.is_error);
        assert!(tool_text(&output).contains("TODO: tighten grep guard"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ripgrep_runner_uses_clean_environment_and_session_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_rg = PathBuf::from(
            std::env::var_os("KCODER_WORKSPACE_ROOT")
                .expect("Cargo 应提供当前 KCoder 工作区根目录"),
        )
        .join("crates/kcoder_tools/tests/fixtures/fake_rg_environment.sh");

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = run_ripgrep(&grep_input_for_content(), tmp.path(), &ctx, &fake_rg)
            .await
            .unwrap();

        let text = output
            .content
            .into_iter()
            .filter_map(|block| match block {
                kcoder_types::ContentBlock::Text { text } => Some(text),
                _ => None,
            })
            .collect::<String>();

        assert!(text.contains("home=unset"), "{text}");
        assert!(
            text.contains(&format!("pwd={}", tmp.path().display())),
            "{text}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ripgrep_runner_returns_tool_error_before_session_timeout() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_rg = PathBuf::from(
            std::env::var_os("KCODER_WORKSPACE_ROOT")
                .expect("Cargo 应提供当前 KCoder 工作区根目录"),
        )
        .join("crates/kcoder_tools/tests/fixtures/fake_rg_slow.sh");

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = run_ripgrep_with_timeout(
            &grep_input_with_pattern("needle"),
            tmp.path(),
            &ctx,
            &fake_rg,
            Duration::from_millis(50),
        )
        .await
        .unwrap();

        assert!(output.is_error);
        let text = tool_text(&output);
        assert!(text.contains("grep stopped after 50 ms"), "{text}");
        assert!(text.contains("Use a narrower grep request"), "{text}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn ripgrep_runner_keeps_required_windows_runtime_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_rg = tmp.path().join("rg.cmd");
        std::fs::write(
            &fake_rg,
            "@echo off\r\necho env.txt:1:root=%SystemRoot%,path=%PATH%\r\n",
        )
        .unwrap();

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = run_ripgrep(&grep_input_for_content(), tmp.path(), &ctx, &fake_rg)
            .await
            .unwrap();
        let text = tool_text(&output);

        let system_root = std::env::var("SystemRoot").unwrap();
        let path = std::env::var("PATH").unwrap();
        assert!(text.contains(&format!("root={system_root}")), "{text}");
        assert!(text.contains(&format!("path={path}")), "{text}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn ripgrep_timeout_terminates_windows_wrapper_process_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_rg = tmp.path().join("rg.cmd");
        let pid_path = tmp.path().join("rg-child.pid");
        let escaped_pid_path = pid_path.display().to_string().replace('\'', "''");
        std::fs::write(
            &fake_rg,
            format!(
                "@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -Command \"\u{24}PID | Set-Content -LiteralPath '{escaped_pid_path}'; Start-Sleep -Seconds 60\"\r\n"
            ),
        )
        .unwrap();

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = run_ripgrep_with_timeout(
            &grep_input_with_pattern("needle"),
            tmp.path(),
            &ctx,
            &fake_rg,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert!(output.is_error);
        assert!(
            tool_text(&output).contains("grep stopped after 5000 ms"),
            "{}",
            tool_text(&output)
        );

        let child_pid = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(text) = tokio::fs::read_to_string(&pid_path).await
                    && let Ok(pid) = text.trim().parse::<u32>()
                {
                    break pid;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("fake rg child did not publish its PID");

        let terminated = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = std::process::Command::new("powershell.exe")
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &format!(
                            "if (Get-Process -Id {child_pid} -ErrorAction SilentlyContinue) {{ exit 1 }}"
                        ),
                    ])
                    .status()
                    .unwrap();
                if status.success() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok();

        if !terminated {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &child_pid.to_string(), "/T", "/F"])
                .status();
        }
        assert!(
            terminated,
            "timed-out ripgrep wrapper left child PID {child_pid} running"
        );
    }

    #[tokio::test]
    async fn grep_tool_preserves_unicode_paths_patterns_and_content() {
        if which::which("rg").is_err() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let unicode_dir = tmp.path().join("目录 昆仑");
        std::fs::create_dir(&unicode_dir).unwrap();
        std::fs::write(unicode_dir.join("功能 你好.txt"), "前缀\n昆仑匹配内容\n").unwrap();

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = GrepTool
            .call(
                json!({
                    "pattern": "昆仑匹配",
                    "path": unicode_dir,
                    "output_mode": "content"
                }),
                &ctx,
            )
            .await
            .unwrap();
        let text = tool_text(&output);

        assert!(!output.is_error, "{text}");
        assert!(text.contains("功能 你好.txt"), "{text}");
        assert!(text.contains("昆仑匹配内容"), "{text}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn grep_tool_preserves_colon_digit_sequences_in_file_names() {
        if which::which("rg").is_err() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("weird:5:part.rs");
        std::fs::write(&file, "first\nneedle:99:value\n").unwrap();

        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = GrepTool
            .call(
                json!({
                    "pattern": "needle",
                    "output_mode": "content"
                }),
                &ctx,
            )
            .await
            .unwrap();
        let text = tool_text(&output);

        assert!(!output.is_error, "{text}");
        assert!(text.contains("weird:5:part.rs:2:needle:99:value"), "{text}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn regex_fallback_does_not_read_symlinked_file_targets() {
        use std::os::unix::fs::symlink;

        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path().join("base");
        let outside = tmp.path().join("outside.txt");
        std::fs::create_dir(&base).unwrap();
        std::fs::write(&outside, "sandbox escape marker").unwrap();
        symlink(&outside, base.join("linked.txt")).unwrap();
        let input: GrepInput = serde_json::from_value(json!({
            "pattern": "sandbox escape marker",
            "output_mode": "content"
        }))
        .unwrap();
        let ctx = ToolContext::new(AppState::new(&base));

        let output = regex_fallback(&input, &base, &ctx).await.unwrap();
        let text = tool_text(&output);

        assert!(!text.contains("sandbox escape marker"), "{text}");
        assert!(!text.contains("linked.txt"), "{text}");
    }
}

#[cfg(test)]
mod context_alias_tests {
    use super::*;
    #[test]
    fn advertises_only_canonical_context() {
        let schema = GrepTool.input_schema();
        assert!(schema["properties"].get("context").is_some());
        assert!(schema["properties"].get("-C").is_none());
        let input: GrepInput =
            serde_json::from_value(serde_json::json!({"pattern":"x", "-C":2})).unwrap();
        assert_eq!(input.context_flag, Some(2));
    }
    #[tokio::test]
    async fn conflicting_aliases_fail_before_search() {
        let ctx = ToolContext::new(kcoder_state::AppState::new("/nonexistent"));
        assert!(matches!(
            GrepTool
                .call(
                    serde_json::json!({"pattern":"x", "context":1, "-C":2}),
                    &ctx
                )
                .await,
            Err(ToolError::InvalidInput(_))
        ));
    }
}
