//! Bounded result retention; count summaries are produced only after a complete scan.
use super::*;

pub(super) struct GrepPage<'a> {
    input: &'a GrepInput,
    mode: GrepOutputMode,
    base: &'a Path,
    cwd: &'a Path,
    rows: Vec<String>,
    files: std::collections::BTreeSet<(std::cmp::Reverse<std::time::SystemTime>, String)>,
    bytes: usize,
    records: usize,
    total_matches: u64,
    matching_files: u64,
    display_truncated: bool,
}

impl<'a> GrepPage<'a> {
    pub(super) fn new(input: &'a GrepInput, base: &'a Path, cwd: &'a Path) -> Self {
        Self {
            input,
            mode: input
                .output_mode
                .unwrap_or(GrepOutputMode::FilesWithMatches),
            base,
            cwd,
            rows: Vec::new(),
            files: Default::default(),
            bytes: 0,
            records: 0,
            total_matches: 0,
            matching_files: 0,
            display_truncated: false,
        }
    }

    fn limit(&self) -> usize {
        self.input
            .head_limit
            .unwrap_or(DEFAULT_HEAD_LIMIT)
            .clamp(1, 10000)
    }
    fn offset(&self) -> usize {
        self.input.offset.unwrap_or(0)
    }

    pub(super) fn push_rg_line(&mut self, line: &str) -> std::io::Result<()> {
        match self.mode {
            GrepOutputMode::Content => self.push_content(relativize_rg_line(line, self.cwd)),
            GrepOutputMode::Count => {
                let (path, count) = line
                    .rsplit_once([':', '\0'])
                    .ok_or_else(|| std::io::Error::other("invalid ripgrep count record"))?;
                let count = count
                    .parse::<u64>()
                    .map_err(|_| std::io::Error::other("invalid ripgrep count record"))?;
                self.push_count(path, count)?;
            }
            GrepOutputMode::FilesWithMatches => self.push_file(line)?,
        }
        Ok(())
    }

    pub(super) fn push_content(&mut self, row: String) {
        if self.records >= self.offset() && self.records - self.offset() < self.limit() {
            let cost = row.len().saturating_add(std::mem::size_of::<String>());
            if cost <= MAX_GREP_PAGE_BYTES.saturating_sub(self.bytes) {
                self.bytes += cost;
                self.rows.push(row);
            } else {
                self.display_truncated = true;
            }
        }
        self.records = self.records.saturating_add(1);
    }

    pub(super) fn push_count(&mut self, path: &str, count: u64) -> std::io::Result<()> {
        self.total_matches = self
            .total_matches
            .checked_add(count)
            .ok_or_else(|| std::io::Error::other("grep count overflow"))?;
        self.matching_files += 1;
        self.push_content(format!(
            "{}:{count}",
            to_relative_path(path, self.cwd, self.base)
        ));
        Ok(())
    }

    pub(super) fn push_file(&mut self, path: &str) -> std::io::Result<()> {
        // Keep the newest offset + page entries without preallocating for a
        // caller-controlled offset. Include tree-node overhead in accounting.
        let key = (
            std::cmp::Reverse(file_modified_time(Path::new(path))),
            to_relative_path(path, self.cwd, self.base),
        );
        let cost = key.1.len().saturating_add(128);
        if self.files.insert(key) {
            self.bytes = self.bytes.saturating_add(cost);
        }
        if self.files.len() > self.offset().saturating_add(self.limit())
            && let Some(last) = self.files.pop_last()
        {
            self.bytes = self.bytes.saturating_sub(last.1.len().saturating_add(128));
        }
        if self.bytes > MAX_GREP_PAGE_BYTES {
            return Err(std::io::Error::other(
                "grep sorted page byte budget exceeded",
            ));
        }
        self.records = self.records.saturating_add(1);
        Ok(())
    }

    pub(super) fn finish(mut self) -> String {
        if self.mode == GrepOutputMode::FilesWithMatches {
            let offset = self.offset();
            let limit = self.limit();
            self.rows = self
                .files
                .into_iter()
                .skip(offset)
                .take(limit)
                .map(|(_, path)| path)
                .collect();
        }
        let mut text = if self.mode == GrepOutputMode::Count && self.total_matches > 0 {
            format!(
                "{}\n\nFound {} total {} across {} {}.",
                self.rows.join("\n"),
                self.total_matches,
                if self.total_matches == 1 {
                    "occurrence"
                } else {
                    "occurrences"
                },
                self.matching_files,
                if self.matching_files == 1 {
                    "file"
                } else {
                    "files"
                }
            )
        } else if self.rows.is_empty() {
            if self.mode == GrepOutputMode::FilesWithMatches {
                "No files found".to_string()
            } else {
                "No matches found".to_string()
            }
        } else if self.mode == GrepOutputMode::FilesWithMatches {
            format!("Found {} files\n{}", self.rows.len(), self.rows.join("\n"))
        } else {
            self.rows.join("\n")
        };
        let offset = self.input.offset.unwrap_or(0);
        let limit = self
            .input
            .head_limit
            .unwrap_or(DEFAULT_HEAD_LIMIT)
            .clamp(1, 10000);
        append_pagination_note(
            &mut text,
            (self.records.saturating_sub(offset) > limit).then_some(limit),
            offset,
        );
        if self.display_truncated {
            text.push_str(
                "\n[Displayed page reached the byte budget; remaining rows were omitted.]",
            );
        }
        text
    }
}
