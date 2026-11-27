//! Bounded, read-only text extraction for Office Open XML files read by `read`.
//!
//! The converters are shared with Wiki and never run macros, follow external
//! relationships or recalculate formulas. Output uses synthetic numbered lines so
//! `offset`/`limit` continue large documents; nothing is silently truncated.
use super::{DEFAULT_MAX_LINES_TO_READ, FileReadInput, read_access};
use crate::{ToolContext, ToolError, ToolOutput};
use kcoder_document_parsers::{
    DocumentParseError, OfficeReadText, extract_docx_for_read, extract_pptx_for_read,
    extract_xlsx_for_read,
};
use std::{path::Path, time::Duration};

/// Source files above this size are rejected before reading.
pub(super) const MAX_OFFICE_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
/// Extracted lines longer than this are wrapped so every line fits one page.
const WRAP_LINE_BYTES: usize = 4096;
const MAX_SECTION_HINTS: usize = 50;
const SOURCE_READ_TIMEOUT: Duration = Duration::from_secs(20);
const EXTRACTION_TIMEOUT: Duration = Duration::from_secs(45);
/// Room kept for the continuation footer when filling the output budget.
const FOOTER_RESERVE_BYTES: usize = 512;
const OLE_COMPOUND_FILE_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OfficeKind {
    Word,
    Excel,
    PowerPoint,
}

impl OfficeKind {
    fn label(self) -> &'static str {
        match self {
            Self::Word => "Word document",
            Self::Excel => "Excel workbook",
            Self::PowerPoint => "PowerPoint presentation",
        }
    }

    fn scope(self) -> &'static str {
        match self {
            Self::Word => {
                "body paragraphs and tables in reading order (tables as Markdown rows); tracked deletions excluded; headers, footers, footnotes, comments and images (no OCR) are not included."
            }
            Self::Excel => {
                "each worksheet in workbook order with its used range, then one line per row as ADDRESS: value; formulas are never recalculated; charts and images are not included."
            }
            Self::PowerPoint => {
                "each slide in presentation order with its title, text, tables (Markdown rows) and speaker notes; images and charts are not OCRed or described."
            }
        }
    }
}

/// Office Open XML packages `read` extracts. Macro-enabled variants share the
/// same XML parts; macros are never executed.
pub(super) fn office_kind(ext: &str) -> Option<OfficeKind> {
    match ext {
        "docx" | "docm" => Some(OfficeKind::Word),
        "xlsx" | "xlsm" => Some(OfficeKind::Excel),
        "pptx" | "pptm" => Some(OfficeKind::PowerPoint),
        _ => None,
    }
}

/// Clear rejection for legacy binary and OpenDocument formats.
pub(super) fn unsupported_office_message(ext: &str) -> Option<String> {
    let (description, target) = match ext {
        "doc" | "dot" => ("legacy Word 97-2003", "docx"),
        "xls" | "xlt" => ("legacy Excel 97-2003", "xlsx"),
        "xlsb" => ("binary Excel", "xlsx"),
        "ppt" | "pps" | "pot" => ("legacy PowerPoint 97-2003", "pptx"),
        "odt" => ("OpenDocument text", "docx"),
        "ods" => ("OpenDocument spreadsheet", "xlsx"),
        "odp" => ("OpenDocument presentation", "pptx"),
        _ => return None,
    };
    Some(format!(
        "read cannot extract {description} .{ext} files; it supports Office Open XML .docx/.xlsx/.pptx (and macro-enabled .docm/.xlsm/.pptm). Convert the file to .{target} first (for example with LibreOffice: soffice --headless --convert-to {target} <file>, if installed), then read the converted copy."
    ))
}

pub(super) async fn read_office(
    path: &Path,
    ext: &str,
    kind: OfficeKind,
    input: &FileReadInput,
    ctx: &ToolContext,
) -> Result<ToolOutput, ToolError> {
    if input.limit == Some(0) {
        return Err(ToolError::InvalidInput(
            "read.limit must be at least 1 for Office documents".into(),
        ));
    }
    if ctx.is_aborted() {
        return Err(ToolError::Aborted);
    }
    // Like PDF reads, re-check the sandbox against the resolved target.
    let resolved = tokio::fs::canonicalize(path)
        .await
        .map_err(|e| ToolError::Execution(format!("failed to resolve {}: {e}", path.display())))?;
    if let Some(sandbox) = &ctx.sandbox {
        sandbox
            .check_path(&resolved, false)
            .map_err(ToolError::Execution)?;
    }
    let metadata = tokio::fs::metadata(&resolved)
        .await
        .map_err(|e| ToolError::Execution(format!("failed to stat {}: {e}", path.display())))?;
    if metadata.len() > MAX_OFFICE_SOURCE_BYTES {
        return Ok(ToolOutput::error(format!(
            "Cannot read '{}': the {} is {} bytes, over the 32 MiB Office extraction limit. Split the file or export the needed part to a smaller document.",
            path.display(),
            kind.label(),
            metadata.len()
        )));
    }
    let source = read_access::read_actual(&resolved, MAX_OFFICE_SOURCE_BYTES);
    let (bytes, access) = tokio::select! {
        _ = ctx.cancelled() => return Err(ToolError::Aborted),
        result = tokio::time::timeout(SOURCE_READ_TIMEOUT, source) => match result {
            Ok(Ok(read)) => read,
            Ok(Err(error)) => {
                return Ok(ToolOutput::error(format!(
                    "Cannot read {} {}: {error}",
                    kind.label(),
                    path.display()
                )));
            }
            Err(_) => return Err(ToolError::Execution("Office source read timed out".into())),
        },
    };
    if bytes.starts_with(&OLE_COMPOUND_FILE_MAGIC) {
        return Ok(ToolOutput::error(format!(
            "Cannot read {}: it is an OLE compound file, not an Office Open XML package. It is either password-protected (encrypted) or a legacy binary file renamed to .{ext}. Remove the password or re-save it as .{ext}, then read the saved copy.",
            path.display()
        )));
    }
    let work = tokio::task::spawn_blocking(move || extract(kind, &bytes));
    let extracted = tokio::select! {
        _ = ctx.cancelled() => return Err(ToolError::Aborted),
        result = tokio::time::timeout(EXTRACTION_TIMEOUT, work) => match result {
            Ok(Ok(extracted)) => extracted,
            Ok(Err(_)) => return Err(ToolError::Execution("Office extraction worker failed".into())),
            Err(_) => return Err(ToolError::Execution("Office text extraction timed out".into())),
        },
    };
    let extracted = match extracted {
        Ok(extracted) => extracted,
        Err(error) => {
            return Ok(ToolOutput::error(format!(
                "Cannot extract text from {} {}: {error}",
                kind.label(),
                path.display()
            )));
        }
    };
    let budget = if ctx.max_output_bytes == 0 {
        usize::MAX
    } else {
        ctx.max_output_bytes
    };
    let page = render_page(path, kind, &extracted, input.offset, input.limit, budget);
    Ok(read_access::attach(
        ToolOutput::text(ctx.truncate(&page)),
        access,
    ))
}

fn extract(kind: OfficeKind, bytes: &[u8]) -> Result<OfficeReadText, DocumentParseError> {
    match kind {
        OfficeKind::Word => extract_docx_for_read(bytes),
        OfficeKind::Excel => extract_xlsx_for_read(bytes),
        OfficeKind::PowerPoint => extract_pptx_for_read(bytes),
    }
}

struct Lines<'a> {
    lines: Vec<&'a str>,
    /// One-based start line and label for each sheet or slide.
    sections: Vec<(usize, &'a str)>,
    wrapped: bool,
}

fn split_lines(extracted: &OfficeReadText) -> Lines<'_> {
    let mut result = Lines {
        lines: Vec::new(),
        sections: Vec::new(),
        wrapped: false,
    };
    let mut sections = extracted.sections.iter().peekable();
    let mut position = 0;
    for raw in extracted.text.split_inclusive('\n') {
        let start = position;
        position += raw.len();
        while let Some((offset, label)) = sections.peek() {
            if *offset >= position {
                break;
            }
            if *offset >= start {
                result
                    .sections
                    .push((result.lines.len() + 1, label.as_str()));
            }
            sections.next();
        }
        let mut line = raw.trim_end_matches(['\n', '\r']);
        while line.len() > WRAP_LINE_BYTES {
            let mut end = WRAP_LINE_BYTES;
            while !line.is_char_boundary(end) {
                end -= 1;
            }
            result.lines.push(&line[..end]);
            line = &line[end..];
            result.wrapped = true;
        }
        result.lines.push(line);
    }
    result
}

fn render_page(
    path: &Path,
    kind: OfficeKind,
    extracted: &OfficeReadText,
    offset: Option<usize>,
    limit: Option<usize>,
    budget: usize,
) -> String {
    let lines = split_lines(extracted);
    let total = lines.lines.len();
    let start = offset.unwrap_or(1).saturating_sub(1);
    let mut header = format!(
        "{}: {}\nExtracted: {}\n",
        kind.label(),
        path.display(),
        kind.scope()
    );
    for note in &extracted.notes {
        header.push_str(&format!("Note: {note}\n"));
    }
    if lines.wrapped {
        header.push_str(&format!(
            "Note: lines longer than {WRAP_LINE_BYTES} bytes are wrapped onto numbered continuation lines.\n"
        ));
    }
    if start >= total {
        return format!(
            "{header}<system-reminder>Warning: the extracted text of {} is shorter than the provided offset ({}). It has {total} lines.</system-reminder>",
            path.display(),
            start + 1
        );
    }
    let requested_end = start
        .saturating_add(limit.unwrap_or(DEFAULT_MAX_LINES_TO_READ))
        .min(total);
    let partial = start > 0 || requested_end < total;
    if partial && !lines.sections.is_empty() {
        header.push_str(&section_hints(&lines.sections, start + 1));
    }
    // Reserve the range line before filling the body within the output budget.
    let range_reserve = 64;
    let mut used = header.len() + range_reserve + FOOTER_RESERVE_BYTES;
    let mut body = String::new();
    let mut end = start;
    for (index, line) in lines.lines[start..requested_end].iter().enumerate() {
        let numbered = format!("{:>6}\t{line}\n", start + index + 1);
        if end > start && used.saturating_add(numbered.len()) > budget {
            break;
        }
        used += numbered.len();
        body.push_str(&numbered);
        end += 1;
    }
    let mut output = header;
    output.push_str(&format!(
        "Showing lines {}-{end} of {total}.\n\n",
        start + 1
    ));
    output.push_str(body.trim_end_matches('\n'));
    if end < total {
        let reason = if end < requested_end {
            " (stopped at the tool output size budget)"
        } else {
            ""
        };
        output.push_str(&format!(
            "\n\n[Continuation: lines {}-{total} were not shown{reason}. Call read with the same file_path and offset={} to continue.]",
            end + 1,
            end + 1
        ));
    }
    output
}

fn section_hints(sections: &[(usize, &str)], current_line: usize) -> String {
    let first = sections
        .iter()
        .rposition(|(line, _)| *line <= current_line)
        .unwrap_or(0);
    let shown = &sections[first..sections.len().min(first + MAX_SECTION_HINTS)];
    let mut hints = String::from("Sections (start line):");
    if first > 0 {
        hints.push_str(&format!(" ({first} earlier);"));
    }
    for (line, label) in shown {
        hints.push_str(&format!(" {label} L{line};"));
    }
    let later = sections.len() - first - shown.len();
    if later > 0 {
        hints.push_str(&format!(" ({later} more)"));
    }
    if hints.ends_with(';') {
        hints.pop();
    }
    hints.push('\n');
    hints
}

#[cfg(test)]
#[path = "office_read_tests.rs"]
mod tests;
