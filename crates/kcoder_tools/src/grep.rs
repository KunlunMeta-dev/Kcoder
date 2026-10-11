use crate::owned_process::{OwnedProcess, drain_prefix};
use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};

mod page;
use page::GrepPage;
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
    /// Existing file or project/subdirectory to search. Omit only when cwd is the intended project; avoid broad home/drive scans.
    pub path: Option<String>,
    /// Filename filter such as `*.rs` or `src/**/*.ts`, not a content regex. Prefer this or type to bound the scan.
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
const MAX_GREP_RECORD_BYTES: usize = 64 * 1024;
const MAX_GREP_PAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_GREP_STDERR_BYTES: usize = 4096;
const RIPGREP_TIMEOUT: Duration = Duration::from_secs(20);

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> String {
        "grep".to_string()
    }

    fn description(&self) -> String {
        "Search file contents using a regular expression. path accepts a file or directory and defaults to cwd. Limit the search to the relevant scope with path, a filename glob, or a file type. Escape regex metacharacters when matching literal text; enable multiline only for matches spanning lines. output_mode selects files_with_matches (default, filenames), content (matching lines, line numbers enabled by default), or count (per-file counts and an aggregate total). Results are formatted text. head_limit is 1..=10000, defaults to 250, and limits displayed output rather than scan cost; offset paginates results. Use context for surrounding lines and -i for case-insensitive matching. Windows paths may use forward slashes. No matches is a valid result; truncated output is not an exhaustive result."
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
        if let (Some(context), Some(legacy)) = (input.context, input.context_flag)
            && context != legacy
        {
            return Err(ToolError::InvalidInput(
                "Conflicting context and legacy -C values; use context only".into(),
            ));
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
            cmd.arg("-l").arg("--null");
        }
        GrepOutputMode::Count => {
            cmd.arg("-c").arg("--with-filename").arg("--null");
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
    let mut owned = OwnedProcess::spawn(&mut cmd)
        .map_err(|error| ToolError::Execution(format!("failed to run rg: {error}")))?;
    let stdout = owned
        .child
        .stdout
        .take()
        .ok_or_else(|| ToolError::Execution("rg stdout unavailable".to_string()))?;
    let stderr = owned
        .child
        .stderr
        .take()
        .ok_or_else(|| ToolError::Execution("rg stderr unavailable".to_string()))?;
    let work = async {
        let wait = async {
            let status = owned.child.wait().await?;
            owned.terminate_group();
            Ok::<_, std::io::Error>(status)
        };
        tokio::try_join!(
            wait,
            collect_rg_page(stdout, mode, input, base, &cwd),
            drain_prefix(stderr, MAX_GREP_STDERR_BYTES)
        )
    };
    let result = tokio::select! {
        result = timeout(process_timeout, work) => result,
        _ = ctx.cancelled() => {
            owned.finish().await.map_err(|error| ToolError::Execution(format!("rg cleanup failed: {error}")))?;
            return Ok(ToolOutput::error("grep cancelled; the search did not finish and no exact count is available."));
        }
    };
    owned
        .finish()
        .await
        .map_err(|error| ToolError::Execution(format!("rg cleanup failed: {error}")))?;
    let (status, page, stderr) = match result {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            return Ok(ToolOutput::error(format!(
                "grep stopped before the search completed: {error}. No exact total is available; narrow the request or reduce its displayed page."
            )));
        }
        Err(_) => {
            return Ok(ToolOutput::error(grep_timeout_message(
                input,
                base,
                &cwd,
                process_timeout,
            )));
        }
    };
    if !status.success() && status.code() != Some(1) {
        return Ok(ToolOutput::error(format!(
            "ripgrep failed with status {status}: {}",
            String::from_utf8_lossy(&stderr).trim()
        )));
    }
    Ok(ToolOutput::text(ctx.truncate(&page)))
}

async fn collect_rg_page(
    mut stdout: impl AsyncRead + Unpin,
    mode: GrepOutputMode,
    input: &GrepInput,
    base: &Path,
    cwd: &Path,
) -> std::io::Result<String> {
    let mut page = GrepPage::new(input, base, cwd);
    let mut record = Vec::new();
    let mut path_boundary_seen = false;
    let mut chunk = [0u8; 8192];
    let separator = if mode == GrepOutputMode::FilesWithMatches {
        0
    } else {
        b'\n'
    };
    loop {
        let read = stdout.read(&mut chunk).await?;
        let eof = read == 0;
        for byte in chunk[..read]
            .iter()
            .copied()
            .map(Some)
            .chain(eof.then_some(None))
        {
            let boundary = byte.is_none()
                || byte.is_some_and(|b| {
                    b == separator
                        && (mode == GrepOutputMode::FilesWithMatches
                            || path_boundary_seen
                            || record == b"--")
                });
            if !boundary {
                if record.len() >= MAX_GREP_RECORD_BYTES {
                    return Err(std::io::Error::other("grep record byte budget exceeded"));
                }
                let byte = byte.unwrap();
                path_boundary_seen |= byte == 0;
                record.push(byte);
                continue;
            }
            if !record.is_empty() {
                page.push_rg_line(String::from_utf8_lossy(&record).trim_end_matches(['\r', '\n']))?;
                record.clear();
                path_boundary_seen = false;
            }
        }
        if eof {
            break;
        }
    }
    Ok(page.finish())
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
    base: &Path,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    let scan = regex_fallback_scan(input, base, ctx);
    let result = tokio::select! {
        result = timeout(RIPGREP_TIMEOUT, scan) => result,
        _ = ctx.cancelled() => return Ok(ToolOutput::error("grep cancelled; no exact count is available.")),
    };
    match result {
        Ok(Ok(text)) => Ok(ToolOutput::text(ctx.truncate(&text))),
        Ok(Err(error)) => Ok(ToolOutput::error(format!(
            "grep fallback stopped before completing its scan: {error}. No exact total is available."
        ))),
        Err(_) => Ok(ToolOutput::error(grep_timeout_message(
            input,
            base,
            &ctx.state.cwd(),
            RIPGREP_TIMEOUT,
        ))),
    }
}

async fn read_search_line(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> std::io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let take = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map_or(chunk.len(), |index| index + 1);
        if take > MAX_GREP_RECORD_BYTES.saturating_sub(line.len()) {
            return Err(std::io::Error::other(
                "grep fallback line byte budget exceeded",
            ));
        }
        let ended = chunk[take - 1] == b'\n';
        line.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        if ended {
            return Ok(Some(line));
        }
    }
}

async fn regex_fallback_scan(
    input: &GrepInput,
    base: &Path,
    ctx: &ToolContext,
) -> std::io::Result<String> {
    let mode = input
        .output_mode
        .unwrap_or(GrepOutputMode::FilesWithMatches);
    let regex = regex::RegexBuilder::new(&input.pattern)
        .case_insensitive(input.case_insensitive.unwrap_or(false))
        .build()
        .map_err(std::io::Error::other)?;
    let cwd = ctx.state.cwd();
    let mut page = GrepPage::new(input, base, &cwd);
    let glob_matcher = input
        .glob
        .as_ref()
        .and_then(|g| globset::Glob::new(g).ok().map(|g| g.compile_matcher()));
    for entry in walkdir::WalkDir::new(base)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        // Never follow a final symlink outside the search/sandbox boundary.
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if glob_matcher
            .as_ref()
            .is_some_and(|matcher| !matcher.is_match(path))
        {
            continue;
        }
        let file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(_) => continue,
        };
        let mut reader = BufReader::new(file);
        let path_text = path.to_string_lossy();
        let relative = to_relative_path(&path_text, &cwd, base);
        let context = input.context.or(input.context_flag).unwrap_or(0);
        let before = input.before_context.unwrap_or(context);
        let after = input.after_context.unwrap_or(context);
        let mut preceding = std::collections::VecDeque::new();
        let mut preceding_bytes = 0usize;
        let mut line_number = 0usize;
        let mut last_emitted = 0usize;
        let mut after_until = 0usize;
        let mut file_matches = 0u64;
        while let Some(bytes) = read_search_line(&mut reader).await? {
            line_number += 1;
            let Ok(line) = std::str::from_utf8(&bytes) else {
                file_matches = 0;
                break;
            };
            if line.contains('\0') {
                file_matches = 0;
                break;
            }
            let line = line.trim_end_matches(['\r', '\n']);
            let matched = regex.is_match(line);
            file_matches += u64::from(matched);
            if mode == GrepOutputMode::FilesWithMatches && matched {
                break;
            }
            if mode == GrepOutputMode::Content {
                if matched {
                    for (index, text) in &preceding {
                        if *index > last_emitted {
                            page.push_content(format!("{relative}:{index}: {text}"));
                            last_emitted = *index;
                        }
                    }
                    after_until = line_number.saturating_add(after);
                }
                if (matched || line_number <= after_until) && line_number > last_emitted {
                    page.push_content(format!("{relative}:{line_number}: {line}"));
                    last_emitted = line_number;
                }
                if before > 0 {
                    let text = line.to_string();
                    preceding_bytes += text.len() + 32;
                    preceding.push_back((line_number, text));
                    while preceding.len() > before {
                        if let Some((_, old)) = preceding.pop_front() {
                            preceding_bytes -= old.len() + 32;
                        }
                    }
                    if preceding_bytes > MAX_GREP_PAGE_BYTES {
                        return Err(std::io::Error::other(
                            "grep fallback context byte budget exceeded",
                        ));
                    }
                }
            }
        }
        if file_matches > 0 {
            if mode == GrepOutputMode::FilesWithMatches {
                page.push_file(&path_text)?;
            }
            if mode == GrepOutputMode::Count {
                page.push_count(&path_text, file_matches)?;
            }
        }
    }
    Ok(page.finish())
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

#[cfg(test)]
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

#[cfg(test)]
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
    async fn ripgrep_rejects_an_oversized_record_before_collecting_it() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let fake_rg = tmp.path().join("rg-fixture");
        std::fs::write(
            &fake_rg,
            "#!/bin/sh\nhead -c 2097152 /dev/zero | tr '\\000' x\nprintf '\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake_rg, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = run_ripgrep(&grep_input_for_content(), tmp.path(), &ctx, &fake_rg)
            .await
            .unwrap();
        assert!(
            output.is_error,
            "oversized process records must be rejected during reading"
        );
        assert!(tool_text(&output).contains("budget"));
    }

    #[cfg(unix)]
    fn python_rg_fixture(root: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("rg-fixture");
        std::fs::write(&path, format!("#!/usr/bin/python3\n{script}")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ripgrep_streams_dense_output_past_the_page_with_large_offsets_and_exact_counts() {
        for mode in [GrepOutputMode::Content, GrepOutputMode::Count] {
            let tmp = tempfile::tempdir().unwrap();
            let fake = python_rg_fixture(
                tmp.path(),
                r#"import os, sys
sys.stderr.buffer.write(b'x' * 1048576)
for i in range(600000):
    sys.stdout.buffer.write(f'p{i}\0{2 if "-c" in sys.argv else str(i) + ":needle"}\n'.encode())
sys.stdout.buffer.flush()
with open('scan-finished', 'w') as f: f.write('complete')
"#,
            );
            let mut input = grep_input_for_content();
            input.output_mode = Some(mode);
            input.offset = Some(599999);
            input.head_limit = Some(1);
            let ctx = ToolContext::new(AppState::new(tmp.path()));
            let output = run_ripgrep(&input, tmp.path(), &ctx, &fake).await.unwrap();
            let text = tool_text(&output);
            assert!(!output.is_error, "{text}");
            assert!(text.contains("p599999:"), "{text}");
            assert!(text.len() < 512);
            assert!(
                tmp.path().join("scan-finished").exists(),
                "the permitted scan must complete beyond the retained page"
            );
            if mode == GrepOutputMode::Count {
                assert!(
                    text.contains("1200000 total occurrences across 600000 files"),
                    "{text}"
                );
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ripgrep_count_timeout_never_reports_a_partial_exact_total() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = python_rg_fixture(
            tmp.path(),
            "import sys, time\nsys.stdout.buffer.write(b'p\\x005\\n'); sys.stdout.buffer.flush()\ntime.sleep(60)\n",
        );
        let mut input = grep_input_for_content();
        input.output_mode = Some(GrepOutputMode::Count);
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output =
            run_ripgrep_with_timeout(&input, tmp.path(), &ctx, &fake, Duration::from_millis(100))
                .await
                .unwrap();
        assert!(output.is_error);
        assert!(!tool_text(&output).contains("total occurrence"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn ripgrep_context_cancel_and_future_abort_stop_owned_children() {
        for abort_future in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let fake = python_rg_fixture(
                tmp.path(),
                r#"import os, subprocess, time
child = subprocess.Popen(['sleep', '60'])
with open('pids', 'w') as f: f.write(f'{os.getpid()} {child.pid}')
time.sleep(60)
"#,
            );
            let mut ctx = ToolContext::new(AppState::new(tmp.path()));
            let cancel = tokio_util::sync::CancellationToken::new();
            ctx.abort_token = Some(cancel.clone());
            let root = tmp.path().to_path_buf();
            let task = tokio::spawn(async move {
                run_ripgrep(&grep_input_for_content(), &root, &ctx, &fake).await
            });
            let pids: Vec<u32> = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(text) = tokio::fs::read_to_string(tmp.path().join("pids")).await {
                        let pids: Vec<_> = text
                            .split_whitespace()
                            .filter_map(|pid| pid.parse::<u32>().ok())
                            .collect();
                        if pids.len() == 2 {
                            break pids;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            if abort_future {
                task.abort();
                let _ = task.await;
            } else {
                cancel.cancel();
                let output = task.await.unwrap().unwrap();
                assert!(output.is_error);
                assert!(tool_text(&output).contains("cancelled"));
            }
            let running = |pid| {
                std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .ok()
                    .and_then(|s| {
                        s.rsplit_once(") ")
                            .map(|(_, fields)| !fields.starts_with('Z'))
                    })
                    .unwrap_or(false)
            };
            let stopped = tokio::time::timeout(Duration::from_secs(2), async {
                while pids.iter().any(|pid| running(*pid)) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            if stopped.is_err() {
                for pid in &pids {
                    unsafe {
                        libc::kill(*pid as libc::pid_t, libc::SIGKILL);
                    }
                }
            }
            assert!(stopped.is_ok(), "grep descendant survived: {pids:?}");
        }
    }

    #[tokio::test]
    async fn regex_fallback_streams_context_without_duplicates_and_counts_full_scan() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("file.txt"),
            "one\nneedle\nthree\nneedle\nfive\n",
        )
        .unwrap();
        let mut input = grep_input_for_content();
        input.pattern = "needle".to_string();
        input.context = Some(1);
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = regex_fallback(&input, tmp.path(), &ctx).await.unwrap();
        let text = tool_text(&output);
        assert_eq!(text.lines().count(), 5, "{text}");
        assert_eq!(text.matches("file.txt:3:").count(), 1);
        input.output_mode = Some(GrepOutputMode::Count);
        input.offset = Some(99999);
        let output = regex_fallback(&input, tmp.path(), &ctx).await.unwrap();
        assert!(tool_text(&output).contains("2 total occurrences across 1 file"));
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

    #[tokio::test]
    async fn regex_fallback_rejects_oversized_line_before_building_all_results() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("huge.txt"), "x".repeat(2097152)).unwrap();
        let input = grep_input_for_content();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = regex_fallback(&input, tmp.path(), &ctx).await.unwrap();
        assert!(output.is_error, "fallback must enforce its reading budget");
        assert!(tool_text(&output).contains("budget"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ripgrep_nul_path_boundary_preserves_newline_in_file_names() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("line\nbreak:5.txt"), "needle\n").unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        for mode in ["content", "count", "files_with_matches"] {
            let output = GrepTool
                .call(json!({"pattern":"needle", "output_mode":mode}), &ctx)
                .await
                .unwrap();
            assert!(!output.is_error, "{}", tool_text(&output));
            assert!(
                tool_text(&output).contains("line\nbreak:5.txt"),
                "{}",
                tool_text(&output)
            );
        }
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
