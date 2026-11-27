//! A host-owned, in-memory file tree for one batch. It is not a filesystem:
//! paths are validated strings, there are no links, devices or processes.
use std::collections::{BTreeMap, BTreeSet};

pub(in crate::ingest) const MAX_READ_RESULT_BYTES: usize = 64 * 1024;
pub(in crate::ingest) const MAX_READ_LINES: usize = 2000;
pub(in crate::ingest) const MAX_DRAFT_FILE_BYTES: usize = crate::WIKI_MAX_PAGE_BYTES + 64 * 1024;
pub(in crate::ingest) const MAX_REVIEW_FILE_BYTES: usize = 64 * 1024;
pub(in crate::ingest) const MAX_DRAFT_TREE_BYTES: usize = crate::ingest::WIKI_MAX_PROPOSAL_BYTES;
pub(in crate::ingest) const MAX_ADMITTED_UPDATES: usize = 6;
pub(in crate::ingest) const ROOTS: &str =
    "index.md, plan.md, sources/, library/, draft/<pageId>.md, review.md";

/// Tool-level failure: never a host error. The draft is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::ingest) struct TreeError {
    pub code: &'static str,
    pub message: String,
}

impl TreeError {
    pub(in crate::ingest) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Paths are relative, `/`-separated and free of empty, `.` or `..` segments.
pub(in crate::ingest) fn validate_path(path: &str) -> Result<String, TreeError> {
    let path = path.trim();
    let invalid = |reason: &str| {
        TreeError::new(
            "wiki_tool_path_invalid",
            format!("{reason}; use a relative path under: {ROOTS}"),
        )
    };
    if path.is_empty() {
        return Err(invalid("empty path"));
    }
    if path.starts_with('/')
        || path.starts_with('\\')
        || path.contains('\\')
        || path.as_bytes().get(1) == Some(&b':')
        || path.starts_with('~')
    {
        return Err(invalid("absolute or host paths are not available"));
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed
        .split('/')
        .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(invalid("empty, '.' or '..' path segments are not allowed"));
    }
    if trimmed.len() > 512 || trimmed.chars().any(char::is_control) {
        return Err(invalid("path is too long or contains control characters"));
    }
    Ok(trimmed.to_owned())
}

#[derive(Debug, Default, Clone)]
pub(in crate::ingest) struct WikiTree {
    files: BTreeMap<String, String>,
    seeds: BTreeMap<String, String>,
    /// Page ids accepted for `draft/<id>.md`: allocated new pages, seeded
    /// existing pages and admitted library reads.
    writable_pages: BTreeSet<String>,
    /// Extra existing pages admitted by reading them: id -> read revision.
    pub admitted: BTreeMap<String, String>,
    /// Every lazily read library page and its revision, in read order.
    pub read_revisions: Vec<(String, String)>,
    /// Which files carry absolute source line numbers: path -> first line.
    line_bases: BTreeMap<String, usize>,
}

impl WikiTree {
    pub(in crate::ingest) fn insert_read_only(&mut self, path: &str, content: String) {
        self.files.insert(path.to_owned(), content);
    }
    pub(in crate::ingest) fn insert_source(
        &mut self,
        path: &str,
        content: String,
        first_line: usize,
    ) {
        self.line_bases.insert(path.to_owned(), first_line.max(1));
        self.files.insert(path.to_owned(), content);
    }
    pub(in crate::ingest) fn insert_seed(&mut self, path: &str, content: String) {
        self.seeds.insert(path.to_owned(), content.clone());
        self.files.insert(path.to_owned(), content);
    }
    pub(in crate::ingest) fn allow_page(&mut self, page_id: &str) {
        self.writable_pages.insert(page_id.to_owned());
    }
    pub(in crate::ingest) fn page_allowed(&self, page_id: &str) -> bool {
        self.writable_pages.contains(page_id)
    }
    pub(in crate::ingest) fn get(&self, path: &str) -> Option<&str> {
        self.files.get(path).map(String::as_str)
    }
    pub(in crate::ingest) fn seed(&self, path: &str) -> Option<&str> {
        self.seeds.get(path).map(String::as_str)
    }
    pub(in crate::ingest) fn contains(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }
    pub(in crate::ingest) fn drafts(&self) -> impl Iterator<Item = (&str, &str)> {
        self.files
            .range("draft/".to_owned()..)
            .take_while(|(path, _)| path.starts_with("draft/"))
            .map(|(path, text)| (path.as_str(), text.as_str()))
    }
    /// Draft files whose bytes differ from their seed (or have no seed).
    pub(in crate::ingest) fn changed_drafts(&self) -> Vec<(&str, &str)> {
        self.drafts()
            .filter(|(path, text)| self.seeds.get(*path).map(String::as_str) != Some(*text))
            .collect()
    }
    pub(in crate::ingest) fn any_change(&self) -> bool {
        !self.changed_drafts().is_empty() || self.get("review.md") != self.seed("review.md")
    }

    /// Writable targets: `draft/<allowed page id>.md` and `review.md`.
    pub(in crate::ingest) fn check_writable(&self, path: &str) -> Result<(), TreeError> {
        if path == "review.md" {
            return Ok(());
        }
        let Some(name) = path.strip_prefix("draft/") else {
            return Err(TreeError::new(
                "wiki_tool_read_only",
                format!("{path} is read-only; only draft/<pageId>.md and review.md are writable"),
            ));
        };
        let Some(page) = name.strip_suffix(".md").filter(|id| !id.contains('/')) else {
            return Err(TreeError::new(
                "wiki_tool_path_invalid",
                "draft files are named draft/<pageId>.md",
            ));
        };
        if !self.writable_pages.contains(page) {
            return Err(TreeError::new(
                "wiki_tool_unallocated_page",
                format!(
                    "{page} is not an allocated new page ID, an offered existing page or an admitted library page; see index.md"
                ),
            ));
        }
        Ok(())
    }

    fn draft_bytes_after(&self, path: &str, content: &str) -> usize {
        self.drafts()
            .filter(|(other, _)| *other != path)
            .map(|(_, text)| text.len())
            .sum::<usize>()
            + content.len()
    }

    fn check_size(&self, path: &str, content: &str) -> Result<(), TreeError> {
        let limit = if path == "review.md" {
            MAX_REVIEW_FILE_BYTES
        } else {
            MAX_DRAFT_FILE_BYTES
        };
        if content.len() > limit {
            return Err(TreeError::new(
                "wiki_tool_file_too_large",
                format!("{path} would exceed {limit} bytes"),
            ));
        }
        if path.starts_with("draft/")
            && self.draft_bytes_after(path, content) > MAX_DRAFT_TREE_BYTES
        {
            return Err(TreeError::new(
                "wiki_tool_tree_too_large",
                format!("all drafts together would exceed {MAX_DRAFT_TREE_BYTES} bytes"),
            ));
        }
        Ok(())
    }

    pub(in crate::ingest) fn write(
        &mut self,
        path: &str,
        content: String,
    ) -> Result<(), TreeError> {
        self.check_writable(path)?;
        self.check_size(path, &content)?;
        self.files.insert(path.to_owned(), content);
        Ok(())
    }

    /// Atomic replacement. `old` must exist exactly once unless `all`.
    pub(in crate::ingest) fn edit(
        &mut self,
        path: &str,
        old: &str,
        new: &str,
        all: bool,
    ) -> Result<usize, TreeError> {
        self.check_writable(path)?;
        let Some(current) = self.files.get(path) else {
            return Err(TreeError::new(
                "wiki_tool_not_found",
                format!("{path} does not exist; use write to create it"),
            ));
        };
        if old.is_empty() {
            return Err(TreeError::new(
                "wiki_tool_edit_empty",
                "old_string must be nonempty; use write to create or replace a file",
            ));
        }
        if old == new {
            return Err(TreeError::new(
                "wiki_tool_edit_noop",
                "old_string and new_string are identical",
            ));
        }
        let count = current.matches(old).count();
        if count == 0 {
            return Err(TreeError::new(
                "wiki_tool_edit_not_found",
                "old_string was not found; read the file again and copy exact text",
            ));
        }
        if count > 1 && !all {
            return Err(TreeError::new(
                "wiki_tool_edit_ambiguous",
                format!(
                    "old_string occurs {count} times; add surrounding context or set replace_all"
                ),
            ));
        }
        let updated = if all {
            current.replace(old, new)
        } else {
            current.replacen(old, new, 1)
        };
        self.check_size(path, &updated)?;
        self.files.insert(path.to_owned(), updated);
        Ok(if all { count } else { 1 })
    }

    /// Directory listing for an existing directory prefix.
    pub(in crate::ingest) fn list(&self, directory: &str) -> Option<Vec<String>> {
        let prefix = format!("{directory}/");
        let mut entries = BTreeSet::new();
        for path in self.files.keys().filter(|path| path.starts_with(&prefix)) {
            let rest = &path[prefix.len()..];
            entries.insert(match rest.split_once('/') {
                Some((dir, _)) => format!("{prefix}{dir}/"),
                None => path.clone(),
            });
        }
        (!entries.is_empty()).then(|| entries.into_iter().collect())
    }

    /// Numbered lines. Source chunk files number lines with absolute source
    /// lines; `offset` uses the same numbering. Output is bounded.
    pub(in crate::ingest) fn read(
        &self,
        path: &str,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<String, TreeError> {
        let Some(text) = self.files.get(path) else {
            return Err(TreeError::new(
                "wiki_tool_not_found",
                format!("{path} does not exist; read index.md for the file list"),
            ));
        };
        let base = self.line_bases.get(path).copied().unwrap_or(1);
        let limit = limit.unwrap_or(MAX_READ_LINES).clamp(1, MAX_READ_LINES);
        let first = offset.unwrap_or(base);
        let lines: Vec<&str> = if text.is_empty() {
            Vec::new()
        } else {
            text.strip_suffix('\n')
                .unwrap_or(text)
                .split('\n')
                .collect()
        };
        let last_line = base + lines.len().saturating_sub(1);
        if first < base || (first > last_line && !(lines.is_empty() && first == base)) {
            return Err(TreeError::new(
                "wiki_tool_offset_out_of_range",
                format!("{path} has lines {base}..={last_line}"),
            ));
        }
        let mut output = String::new();
        let mut next = None;
        for (index, line) in lines.iter().enumerate().skip(first - base).take(limit) {
            let number = base + index;
            let rendered = format!("{number:>6}\t{line}\n");
            if output.len() + rendered.len() > MAX_READ_RESULT_BYTES && !output.is_empty() {
                next = Some(number);
                break;
            }
            output.push_str(&rendered);
        }
        let shown_until = first - base + limit;
        if next.is_none() && shown_until < lines.len() {
            next = Some(base + shown_until);
        }
        if let Some(next) = next {
            output.push_str(&format!("[more lines follow; nextOffset: {next}]\n"));
        }
        if lines.is_empty() {
            output.push_str("[empty file]\n");
        }
        Ok(output)
    }

    /// Hash over sorted path and content hashes of every file in the tree.
    pub(in crate::ingest) fn tree_hash(&self) -> String {
        let mut bytes = Vec::new();
        for (path, text) in &self.files {
            bytes.extend_from_slice(path.as_bytes());
            bytes.push(0);
            bytes.extend_from_slice(crate::objects::digest(text.as_bytes()).as_bytes());
            bytes.push(0);
        }
        crate::objects::digest(&bytes)
    }
}
