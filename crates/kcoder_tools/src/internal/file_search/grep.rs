//! Bounded Grep records, fallback scans and cost estimates.

use crate::{GENERATED_DIRECTORIES_TO_EXCLUDE, VCS_DIRECTORIES_TO_EXCLUDE};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};

#[path = "grep/input.rs"]
mod input;
#[path = "../../grep/page.rs"]
mod page;
pub use input::{GrepInput, GrepOutputMode};
pub use page::GrepPage;

pub const DEFAULT_HEAD_LIMIT: usize = 250;
pub const BROAD_SEARCH_FILE_LIMIT: usize = 500;
const BROAD_SEARCH_BYTE_LIMIT: u64 = 16 * 1024 * 1024;
pub const EXPENSIVE_SEARCH_FILE_LIMIT: usize = 2_000;
pub const EXPENSIVE_SEARCH_BYTE_LIMIT: u64 = 128 * 1024 * 1024;
const PREFLIGHT_ESTIMATE_TIME_LIMIT: Duration = Duration::from_millis(300);
pub const MAX_GREP_RECORD_BYTES: usize = 64 * 1024;
const MAX_GREP_PAGE_BYTES: usize = 8 * 1024 * 1024;

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

pub async fn regex_fallback_scan(
    input: &GrepInput,
    base: &Path,
    cwd: &(dyn Fn() -> PathBuf + Sync),
) -> std::io::Result<String> {
    let mode = input
        .output_mode
        .unwrap_or(GrepOutputMode::FilesWithMatches);
    let regex = regex::RegexBuilder::new(&input.pattern)
        .case_insensitive(input.case_insensitive.unwrap_or(false))
        .build()
        .map_err(std::io::Error::other)?;
    let cwd = cwd();
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchScopeEstimate {
    pub files: usize,
    pub bytes: u64,
    crossed_limit: bool,
}

impl SearchScopeEstimate {
    pub fn is_within_limit(self) -> bool {
        !self.crossed_limit
    }

    pub fn file_count_label(self) -> String {
        self.file_count_label_with_limit(BROAD_SEARCH_FILE_LIMIT)
    }

    pub fn file_count_label_with_limit(self, limit: usize) -> String {
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

    pub fn byte_count_label(self) -> String {
        self.byte_count_label_with_limit(BROAD_SEARCH_BYTE_LIMIT)
    }

    pub fn byte_count_label_with_limit(self, limit: u64) -> String {
        let bytes = human_bytes(self.bytes);
        if self.crossed_limit && self.bytes > limit {
            format!("more than {bytes}")
        } else {
            bytes
        }
    }
}

pub fn estimate_broad_search_cost(base: &Path) -> SearchScopeEstimate {
    estimate_search_cost(base, BROAD_SEARCH_FILE_LIMIT, BROAD_SEARCH_BYTE_LIMIT)
}

pub fn estimate_expensive_search_cost(base: &Path) -> SearchScopeEstimate {
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

pub fn append_pagination_note(text: &mut String, applied_limit: Option<usize>, offset: usize) {
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

pub fn relativize_rg_line(line: &str, cwd: &Path) -> String {
    // Content-mode ripgrep is invoked with `--null`, yielding
    // `path\0line:text` (or `path\0line-context`).
    let Some((path, rest)) = line.split_once('\0') else {
        return line.to_string();
    };
    format!("{}:{}", to_relative_path(path, cwd, cwd), rest)
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
