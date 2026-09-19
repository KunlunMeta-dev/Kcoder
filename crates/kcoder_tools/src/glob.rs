use crate::{Tool, ToolContext, ToolError, ToolOutput, parse_input};
use async_trait::async_trait;
use globset::Glob;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::task::spawn_blocking;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::process::configure_isolated_process_environment;

/// Find files matching a glob pattern.
#[derive(Debug, Default)]
pub struct GlobTool;

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GlobOutputMode {
    /// Return matching paths.
    #[default]
    Paths,
    /// Scan matching files and return only the aggregate count, not a path list.
    Count,
}

#[derive(Debug, Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum GlobScanBudget {
    /// Conservative default tier for regular project searches.
    #[default]
    Default,
    /// Explicitly request a larger project-search scope.
    Expanded,
    /// Explicitly request the largest search budget available to the model.
    Large,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct GlobInput {
    /// Filesystem glob pattern such as `src/**/*.rs` or `**/*.test.ts`.
    pub pattern: String,
    /// Optional search directory. Defaults to the current working directory.
    pub path: Option<String>,
    /// Maximum number of matches to return. Defaults to 100.
    /// Model-facing searches reject zero because an unbounded result set is not responsive.
    pub limit: Option<usize>,
    /// Output mode. `paths` returns paths by default; `count` returns only the total
    /// matching-file count. Count mode ignores `limit` but still observes scan budgets, timeouts, and cancellation.
    pub output_mode: Option<GlobOutputMode>,
    /// Scan budget. Larger budgets require explicit selection and an explicit search path.
    #[serde(default)]
    pub scan_budget: GlobScanBudget,
}

#[derive(Debug, Clone, Copy)]
struct GlobScanLimits {
    max_entries: usize,
    max_duration: Duration,
    max_results: usize,
}

impl GlobScanBudget {
    fn limits(self) -> GlobScanLimits {
        match self {
            Self::Default => GlobScanLimits {
                max_entries: 50_000,
                max_duration: Duration::from_secs(2),
                max_results: 100,
            },
            Self::Expanded => GlobScanLimits {
                max_entries: 500_000,
                max_duration: Duration::from_secs(10),
                max_results: 500,
            },
            Self::Large => GlobScanLimits {
                max_entries: 5_000_000,
                max_duration: Duration::from_secs(30),
                max_results: 2_000,
            },
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Expanded => "expanded",
            Self::Large => "large",
        }
    }
}

const DEFAULT_GLOB_LIMIT: usize = 100;
const RIPGREP_GLOB_TIMEOUT: Duration = Duration::from_secs(20);
const PREFLIGHT_MAX_ENTRIES: usize = 20_000;
const PREFLIGHT_MAX_DURATION: Duration = Duration::from_millis(300);
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

fn glob_limit_error(limit: usize, budget: GlobScanBudget, max_results: usize) -> String {
    if budget == GlobScanBudget::Large {
        return format!(
            "Requested glob limit {} exceeds the maximum `{}` scan budget result cap of {}. Set `limit` to {} or lower, or narrow `path`/`pattern`; unbounded glob results are disabled.",
            limit,
            budget.as_str(),
            max_results,
            max_results,
        );
    }

    let next_budget = match budget {
        GlobScanBudget::Default => GlobScanBudget::Expanded,
        GlobScanBudget::Expanded => GlobScanBudget::Large,
        GlobScanBudget::Large => unreachable!("large budget handled above"),
    };
    format!(
        "Requested glob limit {} exceeds the `{}` scan budget result cap of {}. Retry with `scan_budget: \"{}\"` and an explicit narrow `path`, or use a smaller `limit`.",
        limit,
        budget.as_str(),
        max_results,
        next_budget.as_str(),
    )
}

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> String {
        "glob".to_string()
    }

    fn description(&self) -> String {
        "A file enumeration tool backed by ripgrep when available, with bounded and cancellable scans. Use it instead of shell `ls`, `find`, or glob expansion. Supports patterns like `**/*.rs` or `src/**/*.ts`; `output_mode: \"paths\"` returns file paths sorted by modification time, while `output_mode: \"count\"` scans and returns only an aggregate matched-file count. Path results are limited by `limit` (default 100) and may include a truncation notice; count results ignore `limit` but report whether the count is complete. Use grep for content search. Start with the default scan budget and select `expanded` or `large` only when a broader explicit path is required; `large` is the maximum budget."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        crate::clean_schema(schemars::schema_for!(GlobInput))
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }

        let input: GlobInput = parse_input(&input)?;
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
            "glob pattern_chars={} under {:?} with scan_budget={}",
            input.pattern.chars().count(),
            base,
            input.scan_budget.as_str()
        );

        if !base.exists() {
            return Ok(ToolOutput::error(format!(
                "Directory does not exist: {}",
                base.display()
            )));
        }
        if !base.is_dir() {
            return Ok(ToolOutput::error(format!(
                "Path is not a directory: {}",
                base.display()
            )));
        }

        // Validate the pattern before starting a worker so invalid input fails quickly.
        Glob::new(&input.pattern)
            .map_err(|e| ToolError::InvalidInput(format!("invalid glob pattern: {}", e)))?;

        let limits = input.scan_budget.limits();
        let output_mode = input.output_mode.unwrap_or_default();
        let result_limit = match output_mode {
            GlobOutputMode::Count => 1,
            GlobOutputMode::Paths => match input.limit {
                Some(0) => {
                    return Ok(ToolOutput::error(
                        "Unbounded glob results are disabled. Set a positive `limit` and, if needed, retry with `scan_budget: \"expanded\"` or `scan_budget: \"large\"` plus an explicit `path`.",
                    ));
                }
                Some(limit) if limit > limits.max_results => {
                    return Ok(ToolOutput::error(glob_limit_error(
                        limit,
                        input.scan_budget,
                        limits.max_results,
                    )));
                }
                Some(limit) => limit,
                None => DEFAULT_GLOB_LIMIT,
            },
        };

        if input.scan_budget != GlobScanBudget::Default
            && !path_provides_narrow_scope(&input, &base, &ctx.state.cwd())
        {
            return Ok(ToolOutput::error(format!(
                "The `{}` glob scan budget requires an explicit path narrower than the current working directory. Set `path` to the smallest relevant directory and retry.",
                input.scan_budget.as_str(),
            )));
        }

        if input.scan_budget == GlobScanBudget::Default && is_top_level_search_root(&base) {
            return Ok(ToolOutput::error(format!(
                "Refusing a default glob scan over top-level directory `{}`. Narrow `path` to a project directory, or explicitly retry with `scan_budget: \"expanded\"`/`\"large\"` and a positive `limit`.",
                base.display(),
            )));
        }

        // The rg search reads limit + 1 records to detect truncation instead of
        // performing a complete directory pre-scan. This prevents large workspaces
        // from exhausting the preflight budget and being mislabeled as too broad.
        // Use the Rust fallback below only when rg is unavailable.
        if let Some(rg_path) = crate::ripgrep::find_ripgrep() {
            return run_ripgrep_glob(
                &input,
                &base,
                ctx,
                &rg_path,
                result_limit,
                output_mode,
                limits,
            )
            .await;
        }

        let pattern = input.pattern.clone();
        let cwd = ctx.state.cwd();
        let abort_token = ctx.abort_token.clone();
        let scan_budget = input.scan_budget;
        let skip_generated = !path_contains_named_dir(&base, GENERATED_DIRECTORIES_TO_EXCLUDE);
        let worker_cancel = CancellationToken::new();
        let _worker_cancel_guard = CancelOnDrop(worker_cancel.clone());
        let scan = spawn_blocking(move || {
            scan_glob(GlobScanRequest {
                base,
                cwd,
                pattern,
                result_limit,
                budget: scan_budget,
                limits,
                skip_generated,
                abort_token,
                worker_cancel,
            })
        });

        let scan = tokio::select! {
            biased;
            _ = ctx.cancelled() => return Err(ToolError::Aborted),
            result = scan => result.map_err(|error| {
                ToolError::Execution(format!("glob worker failed: {}", error))
            })?,
        };

        let scan = match scan {
            Ok(scan) => scan,
            Err(ToolError::Aborted) => return Err(ToolError::Aborted),
            Err(error) => return Ok(ToolOutput::error(error.to_string())),
        };

        let output = if output_mode == GlobOutputMode::Count {
            format_scan_count_output(scan, scan_budget)
        } else {
            format_scan_output(scan, scan_budget, result_limit)
        };
        if output.truncated {
            Ok(ToolOutput::error(ctx.truncate(&output.text)))
        } else {
            Ok(ToolOutput::text(ctx.truncate(&output.text)))
        }
    }
}

async fn run_ripgrep_glob(
    input: &GlobInput,
    base: &Path,
    ctx: &ToolContext,
    rg_path: &Path,
    result_limit: usize,
    output_mode: GlobOutputMode,
    limits: GlobScanLimits,
) -> Result<ToolOutput, ToolError> {
    let cwd = ctx.state.cwd();
    let mut command = Command::new(rg_path);
    command
        .arg("--no-config")
        .arg("--files")
        .arg("--hidden")
        .arg(format!("--glob={}", input.pattern));

    for directory in VCS_DIRECTORIES_TO_EXCLUDE {
        command
            .arg(format!("--glob=!{directory}"))
            .arg(format!("--glob=!{directory}/**"));
    }
    if !path_contains_named_dir(base, GENERATED_DIRECTORIES_TO_EXCLUDE) {
        for directory in GENERATED_DIRECTORIES_TO_EXCLUDE {
            command
                .arg(format!("--glob=!{directory}"))
                .arg(format!("--glob=!{directory}/**"));
        }
    }

    command.arg("--").arg(base);
    configure_isolated_process_environment(&mut command, &cwd);
    command
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command
        .spawn()
        .map_err(|error| ToolError::Execution(format!("failed to run rg for glob: {error}")))?;
    let guard = child
        .id()
        .map(GlobProcessTreeTerminator::new)
        .ok_or_else(|| {
            ToolError::Execution("rg process did not expose a process id".to_string())
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ToolError::Execution("rg glob stdout was not captured".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| ToolError::Execution("rg glob stderr was not captured".to_string()))?;
    let stderr_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_end(&mut bytes).await;
        bytes
    });

    let timeout_limit = if output_mode == GlobOutputMode::Count {
        RIPGREP_GLOB_TIMEOUT.min(limits.max_duration)
    } else {
        RIPGREP_GLOB_TIMEOUT
    };
    let scan = timeout(timeout_limit, async {
        let mut lines = BufReader::new(stdout).lines();
        let mut matches = Vec::with_capacity(result_limit.saturating_add(1));
        let mut total_matches = 0usize;
        let mut truncated = false;

        loop {
            let line = tokio::select! {
                biased;
                _ = ctx.cancelled() => return Err(ToolError::Aborted),
                line = lines.next_line() => line.map_err(|error| {
                    ToolError::Execution(format!("failed to read rg glob output: {error}"))
                })?,
            };
            let Some(line) = line else { break };
            if line.is_empty() {
                continue;
            }
            total_matches = total_matches.saturating_add(1);
            if output_mode == GlobOutputMode::Count {
                if total_matches > limits.max_entries {
                    truncated = true;
                    break;
                }
                continue;
            }
            let path = PathBuf::from(&line);
            let absolute = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            matches.push(GlobMatch {
                path: to_relative_path(&absolute, &cwd, base),
                modified: absolute
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH),
            });
            if matches.len() > result_limit {
                truncated = true;
                break;
            }
        }

        if truncated {
            return Ok((matches, true, total_matches));
        }

        let status = child
            .wait()
            .await
            .map_err(|error| ToolError::Execution(format!("failed to wait for rg: {error}")))?;
        let stderr = stderr_task.await.unwrap_or_default();
        if !status.success() && status.code() != Some(1) {
            let message = String::from_utf8_lossy(&stderr).trim().to_string();
            if status.code() == Some(2) {
                return Err(ToolError::InvalidInput(if message.is_empty() {
                    format!("invalid glob pattern: {}", input.pattern)
                } else {
                    format!("invalid glob pattern: {message}")
                }));
            }
            return Err(ToolError::Execution(format!(
                "ripgrep failed with status {status}: {message}"
            )));
        }
        Ok((matches, false, total_matches))
    })
    .await;

    let (mut matches, truncated, total_matches) = match scan {
        Ok(result) => result?,
        Err(_) => {
            return Ok(ToolOutput::error(format!(
                "glob stopped after {} ms while ripgrep searched `{}`. Narrow `path` or `pattern` and retry.",
                timeout_limit.as_millis(),
                base.display(),
            )));
        }
    };

    // Terminate rg after reading limit + 1 records; dropping the guard kills the entire process group.
    if truncated {
        drop(guard);
    } else {
        guard.disarm();
    }

    if output_mode == GlobOutputMode::Count {
        return Ok(ToolOutput::text(format_ripgrep_count_output(
            total_matches,
            truncated,
            input.scan_budget,
            limits.max_entries,
        )));
    }

    matches.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
    if truncated {
        matches.truncate(result_limit);
    }
    let mut text = if matches.is_empty() {
        "No files found".to_string()
    } else {
        matches
            .iter()
            .map(|item| item.path.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    };
    if truncated {
        text.push_str(&format!(
            "\n\n(Results are truncated: showing first {} results. Consider using a more specific path or pattern.)",
            result_limit
        ));
    }
    Ok(ToolOutput::text(ctx.truncate(&text)))
}

struct GlobProcessTreeTerminator {
    pid: u32,
    armed: bool,
}

impl GlobProcessTreeTerminator {
    fn new(pid: u32) -> Self {
        Self { pid, armed: true }
    }

    fn disarm(mut self) {
        self.armed = false;
    }

    fn terminate(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
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
}

impl Drop for GlobProcessTreeTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanStop {
    EntryLimit,
    TimeLimit,
}

#[derive(Debug)]
struct GlobMatch {
    path: String,
    modified: SystemTime,
}

impl PartialEq for GlobMatch {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.modified == other.modified
    }
}

impl Eq for GlobMatch {}

// BinaryHeap keeps the least desirable retained match at the top, bounding memory while preserving reverse modification-time order.
impl Ord for GlobMatch {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .modified
            .cmp(&self.modified)
            .then_with(|| self.path.cmp(&other.path))
    }
}

impl PartialOrd for GlobMatch {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug)]
struct GlobScanResult {
    matches: Vec<GlobMatch>,
    total_matches: usize,
    scanned_entries: usize,
    elapsed: Duration,
    stopped: Option<ScanStop>,
}

struct GlobScanRequest {
    base: PathBuf,
    cwd: PathBuf,
    pattern: String,
    result_limit: usize,
    budget: GlobScanBudget,
    limits: GlobScanLimits,
    skip_generated: bool,
    abort_token: Option<CancellationToken>,
    worker_cancel: CancellationToken,
}

/// Ask a still-running worker to exit promptly when an outer timeout drops the calling future.
struct CancelOnDrop(CancellationToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

fn scan_glob(request: GlobScanRequest) -> Result<GlobScanResult, ToolError> {
    let GlobScanRequest {
        base,
        cwd,
        pattern,
        result_limit,
        budget,
        limits,
        skip_generated,
        abort_token,
        worker_cancel,
    } = request;
    let matcher = Glob::new(&pattern)
        .map_err(|e| ToolError::InvalidInput(format!("invalid glob pattern: {}", e)))?
        .compile_matcher();

    if budget == GlobScanBudget::Default
        && preflight_exceeds_default_budget(
            &base,
            &matcher,
            skip_generated,
            &abort_token,
            &worker_cancel,
        )?
    {
        return Err(ToolError::Execution(format!(
            "Refusing to run a default glob over `{}` because the search root is too broad. Preflight exceeded {} entries or {} ms before the scan began. Narrow `path`, or explicitly retry with `scan_budget: \"expanded\"`/`\"large\"` and a positive `limit`.",
            base.display(),
            PREFLIGHT_MAX_ENTRIES,
            PREFLIGHT_MAX_DURATION.as_millis(),
        )));
    }

    let started_at = Instant::now();
    let mut matches = BinaryHeap::with_capacity(result_limit.min(1024));
    let mut total_matches = 0usize;
    let mut scanned_entries = 0usize;
    let mut stopped = None;
    let walker = walk_entries(&base, skip_generated);
    let mut entries = walker.into_iter().filter_map(Result::ok);

    loop {
        if is_cancelled(&abort_token, &worker_cancel) {
            return Err(ToolError::Aborted);
        }
        if scanned_entries >= limits.max_entries {
            stopped = Some(ScanStop::EntryLimit);
            break;
        }
        if started_at.elapsed() >= limits.max_duration {
            stopped = Some(ScanStop::TimeLimit);
            break;
        }

        let Some(entry) = entries.next() else {
            break;
        };
        scanned_entries = scanned_entries.saturating_add(1);

        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = path.strip_prefix(&base).unwrap_or(path);
        if !matcher.is_match(rel) {
            continue;
        }

        total_matches = total_matches.saturating_add(1);
        let candidate = GlobMatch {
            path: to_relative_path(path, &cwd, &base),
            modified: entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH),
        };
        retain_best_match(&mut matches, candidate, result_limit);
    }

    let mut matches = matches.into_vec();
    matches.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
    let elapsed = started_at.elapsed();

    Ok(GlobScanResult {
        matches,
        total_matches,
        scanned_entries,
        elapsed,
        stopped,
    })
}

fn preflight_exceeds_default_budget(
    base: &Path,
    matcher: &globset::GlobMatcher,
    skip_generated: bool,
    abort_token: &Option<CancellationToken>,
    worker_cancel: &CancellationToken,
) -> Result<bool, ToolError> {
    let started_at = Instant::now();
    let mut scanned_entries = 0usize;
    let walker = walk_entries(base, skip_generated);
    let mut entries = walker.into_iter().filter_map(Result::ok);

    loop {
        if is_cancelled(abort_token, worker_cancel) {
            return Err(ToolError::Aborted);
        }
        if scanned_entries >= PREFLIGHT_MAX_ENTRIES
            || started_at.elapsed() >= PREFLIGHT_MAX_DURATION
        {
            return Ok(true);
        }
        let Some(entry) = entries.next() else {
            return Ok(false);
        };
        scanned_entries = scanned_entries.saturating_add(1);

        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel = path.strip_prefix(base).unwrap_or(path);
        let _ = matcher.is_match(rel);
    }
}

fn retain_best_match(matches: &mut BinaryHeap<GlobMatch>, candidate: GlobMatch, limit: usize) {
    if matches.len() < limit {
        matches.push(candidate);
        return;
    }

    if matches
        .peek()
        .is_some_and(|worst| is_better_match(&candidate, worst))
    {
        let _ = matches.pop();
        matches.push(candidate);
    }
}

fn is_better_match(candidate: &GlobMatch, current: &GlobMatch) -> bool {
    candidate.modified > current.modified
        || (candidate.modified == current.modified && candidate.path < current.path)
}

fn format_scan_output(
    result: GlobScanResult,
    budget: GlobScanBudget,
    result_limit: usize,
) -> FormattedGlobOutput {
    let visible_paths = result
        .matches
        .iter()
        .map(|item| item.path.as_str())
        .collect::<Vec<_>>();
    let mut text = if visible_paths.is_empty() {
        "No files matched.".to_string()
    } else if result.total_matches > visible_paths.len() {
        format!(
            "Matched {} files (showing first {} sorted by modification time; results truncated):\n{}",
            result.total_matches,
            visible_paths.len(),
            visible_paths.join("\n")
        )
    } else {
        format!(
            "Matched {} files sorted by modification time:\n{}",
            visible_paths.len(),
            visible_paths.join("\n")
        )
    };

    if let Some(stop) = result.stopped {
        let reason = match stop {
            ScanStop::EntryLimit => format!("{} entries", result.scanned_entries),
            ScanStop::TimeLimit => format!("{} ms", result.elapsed.as_millis()),
        };
        text.push_str(&format!(
            "\n\n[Partial results: `{}` scan budget stopped after {}. The result set is not complete. Narrow `path` or retry with a larger `scan_budget`; keep `limit` at or below {}.]",
            budget.as_str(),
            reason,
            result_limit,
        ));
    }

    FormattedGlobOutput {
        text,
        truncated: result.stopped.is_some(),
    }
}

fn format_scan_count_output(result: GlobScanResult, budget: GlobScanBudget) -> FormattedGlobOutput {
    let complete = result.stopped.is_none();
    let mut text = format!(
        "matched_files: {}\ncomplete: {}\nscan_budget: {}",
        result.total_matches,
        complete,
        budget.as_str(),
    );
    if let Some(stop) = result.stopped {
        let reason = match stop {
            ScanStop::EntryLimit => format!("{} entries", result.scanned_entries),
            ScanStop::TimeLimit => format!("{} ms", result.elapsed.as_millis()),
        };
        text.push_str(&format!(
            "\ncount_note: lower bound; scan stopped after {}. Narrow `path` or `pattern` and retry for a complete count.",
            reason,
        ));
    }
    FormattedGlobOutput {
        text,
        truncated: !complete,
    }
}

fn format_ripgrep_count_output(
    matched_files: usize,
    truncated: bool,
    budget: GlobScanBudget,
    max_entries: usize,
) -> String {
    let mut text = format!(
        "matched_files: {}\ncomplete: {}\nscan_budget: {}",
        matched_files,
        !truncated,
        budget.as_str(),
    );
    if truncated {
        text.push_str(&format!(
            "\ncount_note: lower bound; rg output exceeded the `{}` scan entry budget. Narrow `path` or `pattern` and retry for a complete count.",
            max_entries,
        ));
    }
    text
}

struct FormattedGlobOutput {
    text: String,
    truncated: bool,
}

fn walk_entries(
    base: &Path,
    skip_generated: bool,
) -> impl Iterator<Item = Result<walkdir::DirEntry, walkdir::Error>> {
    walkdir::WalkDir::new(base)
        .follow_links(false)
        .into_iter()
        .filter_entry(move |entry| should_descend(entry, skip_generated))
}

fn should_descend(entry: &walkdir::DirEntry, skip_generated: bool) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    let Some(name) = entry.file_name().to_str() else {
        return true;
    };
    if VCS_DIRECTORIES_TO_EXCLUDE.contains(&name) {
        return false;
    }
    if skip_generated && GENERATED_DIRECTORIES_TO_EXCLUDE.contains(&name) {
        return false;
    }
    true
}

fn is_cancelled(
    abort_token: &Option<CancellationToken>,
    worker_cancel: &CancellationToken,
) -> bool {
    abort_token
        .as_ref()
        .is_some_and(CancellationToken::is_cancelled)
        || worker_cancel.is_cancelled()
}

fn path_provides_narrow_scope(input: &GlobInput, base: &Path, cwd: &Path) -> bool {
    input
        .path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
        && {
            let base = normalize_path_lexically(base);
            let cwd = normalize_path_lexically(cwd);
            base != cwd && !cwd.starts_with(&base)
        }
}

fn is_top_level_search_root(path: &Path) -> bool {
    let normalized = normalize_path_lexically(path);
    if dirs::home_dir().is_some_and(|home| normalize_path_lexically(&home) == normalized) {
        return true;
    }
    match normalized.parent() {
        None => true,
        Some(parent) => parent.as_os_str().is_empty() || parent == Path::new("/"),
    }
}

fn path_contains_named_dir(path: &Path, names: &[&str]) -> bool {
    path.components().any(|component| match component {
        Component::Normal(name) => name.to_str().is_some_and(|name| names.contains(&name)),
        _ => false,
    })
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

fn to_relative_path(path: &Path, cwd: &Path, base: &Path) -> String {
    path.strip_prefix(cwd)
        .or_else(|_| path.strip_prefix(base))
        .unwrap_or(path)
        .display()
        .to_string()
}

fn resolve_path(path: &str, cwd: &Path) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() { p } else { cwd.join(p) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_state::AppState;
    use tokio_util::sync::CancellationToken;

    fn make_file_tree(root: &Path, count: usize) {
        for index in 0..count {
            std::fs::write(root.join(format!("file-{index:05}.rs")), "").unwrap();
        }
    }

    #[test]
    fn default_budget_rejects_a_broad_preflight() {
        let tmp = tempfile::tempdir().unwrap();
        make_file_tree(tmp.path(), PREFLIGHT_MAX_ENTRIES + 1);
        let matcher = Glob::new("**/*").unwrap().compile_matcher();

        assert!(
            preflight_exceeds_default_budget(
                tmp.path(),
                &matcher,
                true,
                &None,
                &CancellationToken::new(),
            )
            .unwrap()
        );
    }

    #[test]
    fn scan_budget_stops_and_bounds_results() {
        let tmp = tempfile::tempdir().unwrap();
        make_file_tree(tmp.path(), 20);
        let result = scan_glob(GlobScanRequest {
            base: tmp.path().to_path_buf(),
            cwd: tmp.path().to_path_buf(),
            pattern: "**/*".to_string(),
            result_limit: 2,
            budget: GlobScanBudget::Expanded,
            limits: GlobScanLimits {
                max_entries: 5,
                max_duration: Duration::from_secs(10),
                max_results: 2,
            },
            skip_generated: true,
            abort_token: None,
            worker_cancel: CancellationToken::new(),
        })
        .unwrap();

        assert_eq!(result.scanned_entries, 5);
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.stopped, Some(ScanStop::EntryLimit));
    }

    #[test]
    fn top_level_search_roots_are_rejected_by_default() {
        let home = dirs::home_dir().expect("home directory should be available");
        assert!(is_top_level_search_root(&home));
        assert!(!is_top_level_search_root(&home.join("project")));

        #[cfg(unix)]
        {
            assert!(is_top_level_search_root(Path::new("/")));
            assert!(is_top_level_search_root(Path::new("/root")));
            assert!(!is_top_level_search_root(Path::new("/root/project")));
        }
    }

    #[tokio::test]
    async fn expanded_budget_requires_an_explicit_narrow_path() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = GlobTool
            .call(
                serde_json::json!({
                    "pattern": "**/*",
                    "scan_budget": "expanded",
                    "limit": 100
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(output.is_error);
        let text = match &output.content[0] {
            kcoder_types::ContentBlock::Text { text } => text,
            _ => panic!("expected text output"),
        };
        assert!(text.contains("requires an explicit path"));
    }

    #[tokio::test]
    async fn glob_worker_stops_when_cancelled() {
        let tmp = tempfile::tempdir().unwrap();
        make_file_tree(tmp.path(), 5_000);
        let token = CancellationToken::new();
        let ctx = ToolContext::new(AppState::new(tmp.path())).with_abort_token(token.clone());
        let trigger = token.clone();
        tokio::spawn(async move {
            tokio::task::yield_now().await;
            trigger.cancel();
        });

        let result = GlobTool
            .call(
                serde_json::json!({
                    "pattern": "**/*",
                    "limit": 100
                }),
                &ctx,
            )
            .await;

        assert!(matches!(result, Err(ToolError::Aborted)));
    }

    #[tokio::test]
    async fn zero_limit_is_rejected_before_scanning() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(AppState::new(tmp.path()));
        let output = GlobTool
            .call(serde_json::json!({ "pattern": "**/*", "limit": 0 }), &ctx)
            .await
            .unwrap();

        assert!(output.is_error);
        let text = match &output.content[0] {
            kcoder_types::ContentBlock::Text { text } => text,
            _ => panic!("expected text output"),
        };
        assert!(text.contains("Unbounded glob results are disabled"));
    }

    #[test]
    fn large_budget_limit_error_does_not_suggest_unavailable_budget() {
        let text = glob_limit_error(20_000, GlobScanBudget::Large, 2_000);

        assert!(text.contains("maximum `large` scan budget result cap of 2000"));
        assert!(text.contains("Set `limit` to 2000 or lower"));
        assert!(!text.contains("larger `scan_budget`"));
    }

    #[test]
    fn smaller_budgets_point_to_the_next_available_budget() {
        let default_text = glob_limit_error(500, GlobScanBudget::Default, 100);
        let expanded_text = glob_limit_error(2_000, GlobScanBudget::Expanded, 500);

        assert!(default_text.contains("scan_budget: \"expanded\""));
        assert!(expanded_text.contains("scan_budget: \"large\""));
    }
}
