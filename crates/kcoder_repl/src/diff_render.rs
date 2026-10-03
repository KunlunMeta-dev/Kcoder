//! Unified diff text rendering for tool transcript cards.
//!
//! KCoder's transcript currently stores tool diffs as text. This module keeps
//! the layout rules in one place: right-aligned line numbers, a stable
//! sign column, wrapped continuation rows aligned under content, and vertical
//! ellipsis separators between hunks.

use unicode_width::UnicodeWidthChar;

const TAB_WIDTH: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RenderDiffOptions {
    wrap_cols: usize,
    max_rows: usize,
}

impl RenderDiffOptions {
    pub(crate) fn new(wrap_cols: usize, max_rows: usize) -> Self {
        Self {
            wrap_cols: wrap_cols.max(1),
            max_rows,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderedDiff {
    pub(crate) lines: Vec<String>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DiffFile {
    path: Option<String>,
    records: Vec<DiffRecord>,
    max_line_number: usize,
    added: usize,
    removed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DiffRecord {
    FileHeader(String),
    HunkSeparator,
    Change {
        number: Option<usize>,
        sign: char,
        content: String,
    },
    Other(String),
}

pub(crate) fn render_unified_diff(diff: &str, options: RenderDiffOptions) -> RenderedDiff {
    let ParsedDiff {
        records,
        max_line_number,
        ..
    } = parse_unified_diff(diff);
    let number_width = line_number_width(max_line_number);
    let mut lines = Vec::new();
    let mut truncated = false;

    'records: for record in records {
        let rendered = match record {
            DiffRecord::FileHeader(path) => hard_wrap_display_width(&path, options.wrap_cols),
            DiffRecord::HunkSeparator => {
                vec![render_hunk_separator(number_width)]
            }
            DiffRecord::Change {
                number,
                sign,
                content,
            } => render_change_line(number, sign, &content, number_width, options.wrap_cols),
            DiffRecord::Other(line) => hard_wrap_display_width(&line, options.wrap_cols),
        };

        for line in rendered {
            if lines.len() >= options.max_rows {
                truncated = true;
                break 'records;
            }
            lines.push(line);
        }
    }

    RenderedDiff { lines, truncated }
}

pub(crate) fn render_tool_diff_body(diff: &str, options: RenderDiffOptions) -> RenderedDiff {
    let parsed = parse_unified_diff(diff);
    let files = split_diff_files(&parsed.records);

    if files.len() <= 1 {
        return render_single_tool_diff_body(files.into_iter().next(), &parsed, options);
    }

    let mut lines = Vec::new();
    let mut truncated = false;
    'files: for (idx, file) in files.into_iter().enumerate() {
        if idx > 0 && !push_limited_line(&mut lines, String::new(), options.max_rows) {
            truncated = true;
            break;
        }

        if let Some(path) = file.path.as_deref() {
            let header = format!("  └ {path} (+{} -{})", file.added, file.removed);
            for line in hard_wrap_display_width(&header, options.wrap_cols) {
                if !push_limited_line(&mut lines, line, options.max_rows) {
                    truncated = true;
                    break 'files;
                }
            }
        }

        let rendered = render_records(
            &file.records,
            file.max_line_number,
            options.wrap_cols.saturating_sub(4),
        );
        for line in rendered {
            if !push_limited_line(&mut lines, format!("    {line}"), options.max_rows) {
                truncated = true;
                break 'files;
            }
        }
    }

    RenderedDiff { lines, truncated }
}

fn render_single_tool_diff_body(
    file: Option<DiffFile>,
    parsed: &ParsedDiff,
    options: RenderDiffOptions,
) -> RenderedDiff {
    let (records, max_line_number) = file
        .map(|file| (file.records, file.max_line_number))
        .unwrap_or_else(|| (parsed.records.clone(), parsed.max_line_number));
    let rendered = render_records(
        &records,
        max_line_number,
        options.wrap_cols.saturating_sub(4),
    );
    let mut lines = Vec::new();
    let mut truncated = false;
    for line in rendered {
        if !push_limited_line(&mut lines, format!("    {line}"), options.max_rows) {
            truncated = true;
            break;
        }
    }

    RenderedDiff { lines, truncated }
}

pub(crate) fn calculate_add_remove_from_diff(diff: &str) -> (usize, usize) {
    let parsed = parse_unified_diff(diff);
    if !parsed.has_hunk {
        return (0, 0);
    }

    parsed
        .records
        .iter()
        .fold((0usize, 0usize), |(added, removed), record| {
            let DiffRecord::Change { sign, .. } = record else {
                return (added, removed);
            };
            match sign {
                '+' => (added.saturating_add(1), removed),
                '-' => (added, removed.saturating_add(1)),
                _ => (added, removed),
            }
        })
}

fn render_records(records: &[DiffRecord], max_line_number: usize, wrap_cols: usize) -> Vec<String> {
    let number_width = line_number_width(max_line_number);
    let mut lines = Vec::new();

    for record in records {
        let rendered = match record {
            DiffRecord::FileHeader(path) => hard_wrap_display_width(path, wrap_cols),
            DiffRecord::HunkSeparator => {
                vec![render_hunk_separator(number_width)]
            }
            DiffRecord::Change {
                number,
                sign,
                content,
            } => render_change_line(*number, *sign, content, number_width, wrap_cols),
            DiffRecord::Other(line) => hard_wrap_display_width(line, wrap_cols),
        };
        lines.extend(rendered);
    }

    lines
}

fn split_diff_files(records: &[DiffRecord]) -> Vec<DiffFile> {
    let mut files = Vec::new();
    let mut current: Option<DiffFile> = None;

    for (idx, record) in records.iter().enumerate() {
        if let DiffRecord::FileHeader(path) = record {
            if let Some(file) = current.take()
                && (file.path.is_some() || !file.records.is_empty())
            {
                files.push(file);
            }
            current = Some(DiffFile {
                path: Some(path.clone()),
                records: Vec::new(),
                max_line_number: 0,
                added: 0,
                removed: 0,
            });
            continue;
        }

        if matches!(record, DiffRecord::HunkSeparator)
            && matches!(records.get(idx + 1), Some(DiffRecord::FileHeader(_)))
        {
            continue;
        }

        let file = current.get_or_insert_with(|| DiffFile {
            path: None,
            records: Vec::new(),
            max_line_number: 0,
            added: 0,
            removed: 0,
        });

        if let DiffRecord::Change { number, sign, .. } = record {
            if let Some(number) = number {
                file.max_line_number = file.max_line_number.max(*number);
            }
            match sign {
                '+' => file.added = file.added.saturating_add(1),
                '-' => file.removed = file.removed.saturating_add(1),
                _ => {}
            }
        }

        file.records.push(record.clone());
    }

    if let Some(file) = current
        && (file.path.is_some() || !file.records.is_empty())
    {
        files.push(file);
    }

    files
}

fn push_limited_line(lines: &mut Vec<String>, line: String, max_rows: usize) -> bool {
    if lines.len() >= max_rows {
        return false;
    }
    lines.push(line);
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedDiff {
    records: Vec<DiffRecord>,
    max_line_number: usize,
    has_hunk: bool,
}

fn parse_unified_diff(diff: &str) -> ParsedDiff {
    let mut records = Vec::new();
    let mut old_line: Option<usize> = None;
    let mut new_line: Option<usize> = None;
    let mut max_line_number = 0usize;
    let mut saw_hunk = false;
    let mut in_hunk = false;
    let mut pending_rename_from: Option<String> = None;

    for raw_line in diff.lines() {
        if is_git_diff_boundary(raw_line) {
            if !records.is_empty() && records.last() != Some(&DiffRecord::HunkSeparator) {
                records.push(DiffRecord::HunkSeparator);
            }
            if let Some(path) = parse_git_diff_path(raw_line) {
                records.push(DiffRecord::FileHeader(path));
            }
            pending_rename_from = None;
            in_hunk = false;
            continue;
        }

        if !in_hunk {
            if let Some(path) = parse_rename_metadata_path(raw_line, "rename from ") {
                pending_rename_from = Some(path);
                continue;
            }
            if let Some(to_path) = parse_rename_metadata_path(raw_line, "rename to ") {
                let display_path = pending_rename_from
                    .take()
                    .map(|from_path| format!("{from_path} → {to_path}"))
                    .unwrap_or(to_path);
                replace_last_file_header(&mut records, display_path);
                continue;
            }
        }

        if should_skip_diff_metadata(raw_line, in_hunk) {
            continue;
        }

        if is_no_newline_marker(raw_line) {
            continue;
        }

        if let Some((old_start, new_start)) = parse_unified_hunk_header(raw_line) {
            if saw_hunk
                && !matches!(
                    records.last(),
                    Some(DiffRecord::HunkSeparator | DiffRecord::FileHeader(_))
                )
            {
                records.push(DiffRecord::HunkSeparator);
            }
            saw_hunk = true;
            in_hunk = true;
            old_line = Some(old_start);
            new_line = Some(new_start);
            max_line_number = max_line_number.max(old_start).max(new_start);
            continue;
        }

        let Some(sign) = raw_line.chars().next() else {
            records.push(DiffRecord::Other(String::new()));
            continue;
        };

        match sign {
            '+' => {
                let number = new_line;
                if let Some(number) = number {
                    max_line_number = max_line_number.max(number);
                }
                increment(&mut new_line);
                records.push(DiffRecord::Change {
                    number,
                    sign,
                    content: raw_line[sign.len_utf8()..].to_string(),
                });
            }
            '-' => {
                let number = old_line;
                if let Some(number) = number {
                    max_line_number = max_line_number.max(number);
                }
                increment(&mut old_line);
                records.push(DiffRecord::Change {
                    number,
                    sign,
                    content: raw_line[sign.len_utf8()..].to_string(),
                });
            }
            ' ' => {
                let number = new_line.or(old_line);
                if let Some(number) = number {
                    max_line_number = max_line_number.max(number);
                }
                increment(&mut old_line);
                increment(&mut new_line);
                records.push(DiffRecord::Change {
                    number,
                    sign: ' ',
                    content: raw_line[sign.len_utf8()..].to_string(),
                });
            }
            _ => records.push(DiffRecord::Other(raw_line.to_string())),
        }
    }

    ParsedDiff {
        records,
        max_line_number,
        has_hunk: saw_hunk,
    }
}

fn increment(line: &mut Option<usize>) {
    if let Some(line) = line.as_mut() {
        *line = line.saturating_add(1);
    }
}

fn is_git_diff_boundary(line: &str) -> bool {
    line.starts_with("diff --git ")
}

fn parse_git_diff_path(line: &str) -> Option<String> {
    let rest = line.strip_prefix("diff --git ")?;
    split_git_diff_paths(rest)
        .last()
        .map(String::as_str)
        .map(strip_diff_path_prefix)
        .filter(|path| !path.is_empty())
}

fn split_git_diff_paths(rest: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut current = String::new();
    let mut chars = rest.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' => in_quotes = !in_quotes,
            '\\' if in_quotes => {
                if let Some(next) = chars.next() {
                    current.push(match next {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        other => other,
                    });
                }
            }
            ch if ch.is_whitespace() && !in_quotes => {
                if !current.is_empty() {
                    paths.push(std::mem::take(&mut current));
                }
            }
            other => current.push(other),
        }
    }

    if !current.is_empty() {
        paths.push(current);
    }

    paths
}

fn strip_diff_path_prefix(path: &str) -> String {
    let path = decode_git_quoted_path(path.trim());
    path.strip_prefix("b/")
        .or_else(|| path.strip_prefix("a/"))
        .unwrap_or(&path)
        .to_string()
}

fn decode_git_quoted_path(path: &str) -> String {
    let Some(inner) = path
        .strip_prefix('"')
        .and_then(|path| path.strip_suffix('"'))
    else {
        return path.to_string();
    };

    let mut decoded = String::new();
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            decoded.push(ch);
            continue;
        }
        let Some(next) = chars.next() else {
            decoded.push('\\');
            break;
        };
        decoded.push(match next {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            other => other,
        });
    }
    decoded
}

fn parse_rename_metadata_path(line: &str, marker: &str) -> Option<String> {
    line.strip_prefix(marker)
        .map(strip_diff_path_prefix)
        .filter(|path| !path.is_empty())
}

fn replace_last_file_header(records: &mut Vec<DiffRecord>, path: String) {
    if let Some(DiffRecord::FileHeader(existing)) = records
        .iter_mut()
        .rev()
        .find(|record| matches!(record, DiffRecord::FileHeader(_)))
    {
        *existing = path;
    } else {
        records.push(DiffRecord::FileHeader(path));
    }
}

fn should_skip_diff_metadata(line: &str, in_hunk: bool) -> bool {
    if !in_hunk && (line.starts_with("--- ") || line.starts_with("+++ ")) {
        return true;
    }

    line.starts_with("index ")
        || line.starts_with("new file mode ")
        || line.starts_with("deleted file mode ")
        || line.starts_with("old mode ")
        || line.starts_with("new mode ")
        || line.starts_with("similarity index ")
        || line.starts_with("dissimilarity index ")
        || line.starts_with("rename from ")
        || line.starts_with("rename to ")
        || line.starts_with("copy from ")
        || line.starts_with("copy to ")
        || line.starts_with("Binary files ")
}

fn is_no_newline_marker(line: &str) -> bool {
    line == r"\ No newline at end of file"
}

fn parse_diff_range_start(range: &str, prefix: char) -> Option<usize> {
    let range = range.strip_prefix(prefix)?;
    range.split(',').next()?.parse().ok()
}

fn parse_unified_hunk_header(line: &str) -> Option<(usize, usize)> {
    let rest = line.strip_prefix("@@ ")?;
    let mut parts = rest.split_whitespace();
    let old_range = parts.next()?;
    let new_range = parts.next()?;
    Some((
        parse_diff_range_start(old_range, '-')?,
        parse_diff_range_start(new_range, '+')?,
    ))
}

fn render_hunk_separator(number_width: usize) -> String {
    format!("{:width$}  ⋮", "", width = number_width.max(1))
}

fn render_change_line(
    number: Option<usize>,
    sign: char,
    content: &str,
    number_width: usize,
    wrap_cols: usize,
) -> Vec<String> {
    let number_width = number_width.max(1);
    let gutter = match number {
        Some(number) => format!("{number:>number_width$} "),
        None => format!("{:>number_width$} ", ""),
    };
    let first_prefix = format!("{gutter}{sign}");
    let continuation_prefix = format!("{:number_width$}  ", "");
    let content_width = wrap_cols
        .saturating_sub(display_width(&first_prefix))
        .max(1);
    let chunks = hard_wrap_display_width(content, content_width);

    chunks
        .into_iter()
        .enumerate()
        .map(|(idx, chunk)| {
            if idx == 0 {
                format!("{first_prefix}{chunk}")
            } else {
                format!("{continuation_prefix}{chunk}")
            }
        })
        .collect()
}

fn hard_wrap_display_width(text: &str, max_cols: usize) -> Vec<String> {
    let max_cols = max_cols.max(1);
    if text.is_empty() {
        return vec![String::new()];
    }

    let mut lines = Vec::new();
    let mut current = String::new();
    let mut used = 0usize;
    for ch in text.chars() {
        let ch_width = char_display_width(ch);
        if used > 0 && used.saturating_add(ch_width) > max_cols {
            trim_ascii_spaces(&mut current);
            lines.push(std::mem::take(&mut current));
            used = 0;
        }
        current.push(ch);
        used = used.saturating_add(ch_width);
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn trim_ascii_spaces(text: &mut String) {
    while text.ends_with(' ') {
        text.pop();
    }
}

fn display_width(text: &str) -> usize {
    text.chars().map(char_display_width).sum()
}

fn char_display_width(ch: char) -> usize {
    ch.width().unwrap_or(if ch == '\t' { TAB_WIDTH } else { 0 })
}

fn line_number_width(max_line_number: usize) -> usize {
    max_line_number.to_string().len().max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(diff: &str, wrap_cols: usize) -> RenderedDiff {
        render_unified_diff(diff, RenderDiffOptions::new(wrap_cols, 80))
    }

    #[test]
    fn renders_numbered_rows_without_hunk_headers() {
        let rendered = render("@@ -1 +1 @@\n-old\n+new", 80);

        assert_eq!(rendered.lines, vec!["1 -old", "1 +new"]);
        assert!(!rendered.truncated);
    }

    #[test]
    fn renders_vertical_ellipsis_between_hunks() {
        let rendered = render("@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-old2\n+new2", 80);

        assert_eq!(
            rendered.lines,
            vec![" 1 -old", " 1 +new", "    ⋮", "10 -old2", "10 +new2"]
        );
    }

    #[test]
    fn wraps_long_lines_under_content_column() {
        let rendered = render("@@ -1 +1 @@\n+abcdefghijklmnop", 10);

        assert_eq!(rendered.lines, vec!["1 +abcdefg", "   hijklmn", "   op"]);
    }

    #[test]
    fn apply_update_wraps_long_lines_text_core() {
        let rendered = render(
            concat!(
                "@@ -1,4 +1,4 @@\n",
                " 1\n",
                "-2\n",
                "+added long line which wraps and_if_there_is_a_long_token_it_will_be_broken\n",
                " 3\n",
                "-4\n",
                "+4 context line which also wraps across",
            ),
            24,
        );

        assert_eq!(
            rendered.lines,
            vec![
                "1  1",
                "2 -2",
                "2 +added long line which",
                "    wraps and_if_there_i",
                "   s_a_long_token_it_wil",
                "   l_be_broken",
                "3  3",
                "4 -4",
                "4 +4 context line which",
                "   also wraps across",
            ]
        );
    }

    #[test]
    fn apply_update_handles_three_digit_line_numbers_text_core() {
        let rendered = render(
            concat!(
                "@@ -97,7 +97,7 @@\n",
                " line 97\n",
                " line 98\n",
                " line 99\n",
                "-line 100\n",
                "+line 100 changed\n",
                " line 101\n",
                " line 102\n",
                " line 103",
            ),
            80,
        );

        assert_eq!(
            rendered.lines,
            vec![
                " 97  line 97",
                " 98  line 98",
                " 99  line 99",
                "100 -line 100",
                "100 +line 100 changed",
                "101  line 101",
                "102  line 102",
                "103  line 103",
            ]
        );
    }

    #[test]
    fn handles_diff_lines_without_hunk_headers() {
        let rendered = render("-old\n+new", 80);

        assert_eq!(rendered.lines, vec!["  -old", "  +new"]);
    }

    #[test]
    fn caps_rendered_rows_after_wrapping() {
        let rendered = render_unified_diff(
            "@@ -1 +1 @@\n+abcdefghijklmnop",
            RenderDiffOptions::new(10, 2),
        );

        assert_eq!(rendered.lines, vec!["1 +abcdefg", "   hijklmn"]);
        assert!(rendered.truncated);
    }

    #[test]
    fn counts_adds_and_removes_ignoring_file_headers() {
        assert_eq!(
            calculate_add_remove_from_diff("--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n context"),
            (1, 1)
        );
    }

    #[test]
    fn counts_zero_for_non_unified_diff_text() {
        assert_eq!(
            calculate_add_remove_from_diff("--- a\n+++ b\n-old\n+new"),
            (0, 0)
        );
    }

    #[test]
    fn skips_git_metadata_headers() {
        let rendered = render(
            "diff --git a/new.txt b/new.txt\n\
             new file mode 100644\n\
             index 0000000..1111111\n\
             --- /dev/null\n\
             +++ b/new.txt\n\
             @@ -0,0 +1 @@\n\
             +hello",
            80,
        );

        assert_eq!(rendered.lines, vec!["new.txt", "1 +hello"]);
        assert_eq!(
            calculate_add_remove_from_diff(
                "diff --git a/new.txt b/new.txt\n\
                 new file mode 100644\n\
                 index 0000000..1111111\n\
                 --- /dev/null\n\
                 +++ b/new.txt\n\
                 @@ -0,0 +1 @@\n\
                 +hello"
            ),
            (1, 0)
        );
    }

    #[test]
    fn renders_file_headers_between_git_diff_files() {
        let rendered = render(
            "diff --git a/one.txt b/one.txt\n\
             index 1111111..2222222 100644\n\
             --- a/one.txt\n\
             +++ b/one.txt\n\
             @@ -1 +1 @@\n\
             -old\n\
             +new\n\
             diff --git a/two.txt b/two.txt\n\
             new file mode 100644\n\
             index 0000000..3333333\n\
             --- /dev/null\n\
             +++ b/two.txt\n\
             @@ -0,0 +1 @@\n\
             +fresh",
            80,
        );

        assert_eq!(
            rendered.lines,
            vec!["one.txt", "1 -old", "1 +new", "   ⋮", "two.txt", "1 +fresh",]
        );
    }

    #[test]
    fn renders_quoted_git_diff_file_headers_with_spaces() {
        let rendered = render(
            "diff --git \"a/path with spaces.txt\" \"b/path with spaces.txt\"\n\
             index 1111111..2222222 100644\n\
             --- \"a/path with spaces.txt\"\n\
             +++ \"b/path with spaces.txt\"\n\
             @@ -1 +1 @@\n\
             -old\n\
             +new",
            80,
        );

        assert_eq!(
            rendered.lines,
            vec!["path with spaces.txt", "1 -old", "1 +new"]
        );
    }

    #[test]
    fn renders_rename_file_header_from_git_metadata() {
        let rendered = render(
            concat!(
                "diff --git a/old_name.rs b/new_name.rs\n",
                "similarity index 88%\n",
                "rename from old_name.rs\n",
                "rename to new_name.rs\n",
                "index 1111111..2222222 100644\n",
                "--- a/old_name.rs\n",
                "+++ b/new_name.rs\n",
                "@@ -1,3 +1,3 @@\n",
                " A\n",
                "-B\n",
                "+B changed\n",
                " C",
            ),
            80,
        );

        assert_eq!(
            rendered.lines,
            vec![
                "old_name.rs → new_name.rs",
                "1  A",
                "2 -B",
                "2 +B changed",
                "3  C"
            ]
        );
    }

    #[test]
    fn renders_quoted_rename_file_header_with_spaces() {
        let rendered = render(
            concat!(
                "diff --git \"a/old path.rs\" \"b/new path.rs\"\n",
                "similarity index 88%\n",
                "rename from \"old path.rs\"\n",
                "rename to \"new path.rs\"\n",
                "index 1111111..2222222 100644\n",
                "--- \"a/old path.rs\"\n",
                "+++ \"b/new path.rs\"\n",
                "@@ -1 +1 @@\n",
                "-old\n",
                "+new",
            ),
            80,
        );

        assert_eq!(
            rendered.lines,
            vec!["old path.rs → new path.rs", "1 -old", "1 +new"]
        );
    }

    #[test]
    fn keeps_hunk_lines_that_look_like_file_headers() {
        let rendered = render("@@ -1 +1 @@\n--- removed heading\n+++ added heading", 80);

        assert_eq!(
            rendered.lines,
            vec!["1 --- removed heading", "1 +++ added heading"]
        );
        assert_eq!(
            calculate_add_remove_from_diff("@@ -1 +1 @@\n--- removed heading\n+++ added heading"),
            (1, 1)
        );
    }

    #[test]
    fn skips_no_newline_markers() {
        let diff =
            "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file";
        let rendered = render(diff, 80);

        assert_eq!(rendered.lines, vec!["1 -old", "1 +new"]);
        assert_eq!(calculate_add_remove_from_diff(diff), (1, 1));
    }
}
