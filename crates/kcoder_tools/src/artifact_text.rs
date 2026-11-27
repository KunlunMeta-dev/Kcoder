//! Comparable text of a produced artifact, for self-evolution edit
//! detection.
//!
//! Office Open XML documents use the same bounded, read-only converters as
//! `read` (no macros, no external relationships). Plain text files are
//! decoded as UTF-8. Other binaries (including PDF, whose text layer needs
//! an external renderer) have no comparable text: callers compare their
//! content hash only.

use std::path::Path;

/// Largest source file read for comparison.
pub const ARTIFACT_SOURCE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// How an artifact's content is compared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactText {
    /// Extracted or decoded text.
    Text(String),
    /// Binary content without a comparable text form.
    Binary,
}

/// Extract comparable text from `bytes` of the file at `path`.
pub fn artifact_text(path: &Path, bytes: &[u8]) -> ArtifactText {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let office = match extension.as_str() {
        "docx" | "docm" => Some(kcoder_document_parsers::extract_docx_for_read(bytes)),
        "pptx" | "pptm" => Some(kcoder_document_parsers::extract_pptx_for_read(bytes)),
        "xlsx" | "xlsm" => Some(kcoder_document_parsers::extract_xlsx_for_read(bytes)),
        _ => None,
    };
    match office {
        Some(Ok(extracted)) => ArtifactText::Text(extracted.text),
        Some(Err(_)) => ArtifactText::Binary,
        None => match std::str::from_utf8(bytes) {
            Ok(text) if !text.contains('\0') => ArtifactText::Text(text.to_string()),
            _ => ArtifactText::Binary,
        },
    }
}

/// Fraction of `before` that changed in `after`, from a line-level longest
/// common subsequence: `1 - 2·LCS / (|before| + |after|)` over line counts.
/// Long inputs are compared on a bounded prefix of lines.
pub fn edit_ratio(before: &str, after: &str) -> f64 {
    const MAX_LINES: usize = 2000;
    let left: Vec<&str> = before
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .take(MAX_LINES)
        .collect();
    let right: Vec<&str> = after
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty())
        .take(MAX_LINES)
        .collect();
    if left.is_empty() && right.is_empty() {
        return 0.0;
    }
    let mut previous = vec![0usize; right.len() + 1];
    let mut current = vec![0usize; right.len() + 1];
    for line in &left {
        for (index, other) in right.iter().enumerate() {
            current[index + 1] = if line == other {
                previous[index] + 1
            } else {
                previous[index + 1].max(current[index])
            };
        }
        std::mem::swap(&mut previous, &mut current);
    }
    let common = previous[right.len()] as f64;
    (1.0 - 2.0 * common / (left.len() + right.len()) as f64).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_decodes_and_binary_is_hash_only() {
        assert_eq!(
            artifact_text(Path::new("a.md"), b"hello"),
            ArtifactText::Text("hello".into())
        );
        assert_eq!(
            artifact_text(Path::new("a.pdf"), b"%PDF\0\x01"),
            ArtifactText::Binary
        );
        assert_eq!(
            artifact_text(Path::new("broken.docx"), b"not a zip"),
            ArtifactText::Binary
        );
    }

    #[test]
    fn edit_ratio_tracks_changed_lines() {
        assert_eq!(edit_ratio("a\nb\nc", "a\nb\nc"), 0.0);
        assert_eq!(edit_ratio("a\nb", "x\ny"), 1.0);
        let ratio = edit_ratio("a\nb\nc\nd", "a\nb\nc\nchanged");
        assert!((ratio - 0.25).abs() < 1e-9);
    }
}
