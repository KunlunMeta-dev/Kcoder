//! Bounded Glob fallback directory scanner.

use crate::{GENERATED_DIRECTORIES_TO_EXCLUDE, VCS_DIRECTORIES_TO_EXCLUDE};
use globset::Glob;
use std::{
    cmp::Ordering,
    collections::BinaryHeap,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum GlobScanError {
    #[error("input validation failed: {0}")]
    InvalidInput(String),
    #[error("tool execution failed: {0}")]
    Execution(String),
    #[error("tool was aborted")]
    Aborted,
}

#[derive(Debug, Clone, Copy)]
pub struct GlobScanLimits {
    pub max_entries: usize,
    pub max_duration: Duration,
    pub max_results: usize,
}

const PREFLIGHT_MAX_ENTRIES: usize = 20_000;
const PREFLIGHT_MAX_DURATION: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanStop {
    EntryLimit,
    TimeLimit,
}

#[derive(Debug)]
pub struct GlobMatch {
    pub path: String,
    pub modified: SystemTime,
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
pub struct GlobScanResult {
    pub matches: Vec<GlobMatch>,
    pub total_matches: usize,
    pub scanned_entries: usize,
    pub elapsed: Duration,
    pub stopped: Option<ScanStop>,
}

pub struct GlobScanRequest {
    pub base: PathBuf,
    pub cwd: PathBuf,
    pub pattern: String,
    pub result_limit: usize,
    pub default_budget: bool,
    pub limits: GlobScanLimits,
    pub skip_generated: bool,
    pub abort_token: Option<CancellationToken>,
    pub worker_cancel: CancellationToken,
}

pub fn scan_glob(request: GlobScanRequest) -> Result<GlobScanResult, GlobScanError> {
    let GlobScanRequest {
        base,
        cwd,
        pattern,
        result_limit,
        default_budget,
        limits,
        skip_generated,
        abort_token,
        worker_cancel,
    } = request;
    let matcher = Glob::new(&pattern)
        .map_err(|e| GlobScanError::InvalidInput(format!("invalid glob pattern: {}", e)))?
        .compile_matcher();

    if default_budget
        && preflight_exceeds_default_budget(
            &base,
            &matcher,
            skip_generated,
            &abort_token,
            &worker_cancel,
        )?
    {
        return Err(GlobScanError::Execution(format!(
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
            return Err(GlobScanError::Aborted);
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
) -> Result<bool, GlobScanError> {
    let started_at = Instant::now();
    let mut scanned_entries = 0usize;
    let walker = walk_entries(base, skip_generated);
    let mut entries = walker.into_iter().filter_map(Result::ok);

    loop {
        if is_cancelled(abort_token, worker_cancel) {
            return Err(GlobScanError::Aborted);
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

pub fn to_relative_path(path: &Path, cwd: &Path, base: &Path) -> String {
    path.strip_prefix(cwd)
        .or_else(|_| path.strip_prefix(base))
        .unwrap_or(path)
        .display()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

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
            default_budget: false,
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
}
