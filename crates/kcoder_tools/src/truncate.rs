//! Head+tail truncation helpers for tool output and streamed content.
//!
//! Tools historically returned raw `String` outputs of unbounded size. A single
//! `cat` of a 200 MB log file would freeze the TUI for seconds while
//! `ratatui::Paragraph` re-wrapped every line on each frame, and would also
//! blow the API context budget on the next request.
//!
//! [`truncate_text`] enforces an upper bound by keeping the first `head`
//! bytes, then a small truncation marker, then the last `tail` bytes. The
//! remainder is replaced with an explicit notice that tells the model (and
//! the user) what was dropped and how to recover the full content.

use std::path::{Path, PathBuf};

/// Reason describing why a payload was truncated. Used in the marker so the
/// model knows whether to retry with a smaller scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TruncationReason {
    /// Tool output exceeded the configured byte cap.
    OutputTooLarge,
    /// A sub-agent's completion text exceeded the TUI preview cap.
    BackgroundPreview,
    /// Caller supplied a custom reason (for tests / future use).
    Custom(&'static str),
}

impl TruncationReason {
    fn label(self) -> String {
        match self {
            TruncationReason::OutputTooLarge => "tool output exceeded size limit".to_string(),
            TruncationReason::BackgroundPreview => {
                "background sub-agent result preview truncated".to_string()
            }
            TruncationReason::Custom(s) => s.to_string(),
        }
    }
}

/// Outcome of a truncation attempt, useful when the caller wants to log or
/// surface the original length to the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TruncatedText {
    pub text: String,
    pub truncated: bool,
    pub original_bytes: usize,
    pub kept_bytes: usize,
    pub dropped_bytes: usize,
}

/// Directory holding full pre-truncation copies of tool output.
///
/// Lives in the session's state directory when one is known. History-less
/// client/forked engines may install an external session artifact root; only
/// legacy interactive states without either location fall back to the
/// workspace `.kcoder/tool-results` directory.
pub fn spill_dir_for_state(state: &kcoder_state::AppState) -> PathBuf {
    if let Some(session_dir) = state
        .session_state_path()
        .and_then(|path| path.parent().map(|dir| dir.to_path_buf()))
    {
        session_dir.join("tool-results")
    } else if let Some(project_dir) = state.session_artifact_project_dir() {
        kcoder_state::session_dir_path(project_dir, &state.artifact_session_id())
            .join("tool-results")
    } else {
        state.cwd().join(".kcoder").join("tool-results")
    }
}

/// Persist the full (pre-truncation) text to `dir` and return its path.
/// Returns `None` when the directory cannot be created or written; callers
/// should treat that as "no spill available" rather than an error.
pub fn spill_full_text(dir: &Path, text: &str) -> Option<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let path = dir.join(format!("spill-{nanos:x}.txt"));
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&path, text).ok()?;
    Some(path)
}

/// Truncate `text` with head+tail splicing; when content is dropped, first
/// persist the full text to `spill_dir` and embed a `Full output at: <path>`
/// reference inside the truncation marker — the byte cap is still honored
/// because the reference is budgeted into the marker overhead. Falls back to
/// plain truncation when the spill cannot be written.
pub fn truncate_and_spill(
    text: &str,
    max_bytes: usize,
    head: usize,
    tail: usize,
    spill_dir: &Path,
) -> String {
    if max_bytes == 0 || text.len() <= max_bytes {
        return text.to_string();
    }
    match spill_full_text(spill_dir, text) {
        Some(path) => {
            truncate_text_with_trailer(
                text,
                max_bytes,
                head,
                tail,
                TruncationReason::OutputTooLarge,
                Some(&format!(" Full output at: {}.", path.display())),
            )
            .text
        }
        None => truncate_text(text, max_bytes, head, tail).text,
    }
}

impl TruncatedText {
    pub fn passthrough(text: String) -> Self {
        let len = text.len();
        Self {
            text,
            truncated: false,
            original_bytes: len,
            kept_bytes: len,
            dropped_bytes: 0,
        }
    }
}

/// Truncate `text` to at most `max_bytes`, preserving `head` bytes from the
/// front and `tail` bytes from the back. If `max_bytes` is `0` the input is
/// returned unchanged (legacy "no limit" escape hatch).
///
/// Returns a [`TruncatedText`] describing how much was dropped. When the input
/// is small enough to fit, `truncated` is `false` and the original string is
/// returned verbatim.
///
/// The truncation is byte-oriented on purpose: tools return UTF-8 strings and
/// counting bytes (rather than graphemes) is a stable, fast upper bound on
/// memory usage. The marker is always emitted at a UTF-8 boundary.
pub fn truncate_text(text: &str, max_bytes: usize, head: usize, tail: usize) -> TruncatedText {
    truncate_text_with_reason(
        text,
        max_bytes,
        head,
        tail,
        TruncationReason::OutputTooLarge,
    )
}

pub fn truncate_text_with_reason(
    text: &str,
    max_bytes: usize,
    head: usize,
    tail: usize,
    reason: TruncationReason,
) -> TruncatedText {
    truncate_text_with_trailer(text, max_bytes, head, tail, reason, None)
}

pub fn truncate_text_with_trailer(
    text: &str,
    max_bytes: usize,
    head: usize,
    tail: usize,
    reason: TruncationReason,
    trailer: Option<&str>,
) -> TruncatedText {
    let trailer = trailer.unwrap_or("");
    let len = text.len();
    if max_bytes == 0 || len <= max_bytes {
        return TruncatedText::passthrough(text.to_string());
    }

    // Use the largest possible decimal fields for this input so the reserved
    // marker space is a true upper bound, not an estimate. A final prefix
    // clamp would destroy the retained tail.
    let marker_template = format!(
        "\n\n[… {}: {} bytes dropped (kept {} of {}). Use a smaller scope, set max_tool_output_bytes to 0 to disable, or read the result via the `read`/`grep` tools with a tighter filter.{}]\n\n",
        reason.label(),
        len,
        len,
        len,
        trailer,
    );
    let marker_overhead = marker_template.len();
    let usable_budget = max_bytes.saturating_sub(marker_overhead);

    // Reserve room for both halves inside the usable budget. If the caller
    // asked for head/tail that together exceed `usable_budget`, scale them
    // down proportionally so the marker still fits.
    let (head, tail) = if head.saturating_add(tail) > usable_budget {
        let total = head.saturating_add(tail);
        let new_head = head.saturating_mul(usable_budget) / total;
        let new_tail = usable_budget.saturating_sub(new_head);
        (new_head, new_tail)
    } else {
        (head, tail)
    };

    if head == 0 && tail == 0 {
        // No room for content at all: emit a marker-only result that fits in
        // `max_bytes` so the caller still sees something meaningful.
        let marker = format!(
            "\n[… {}: {} bytes dropped (kept 0 of {}). Set max_tool_output_bytes higher or read the result via a tighter filter.{}]\n",
            reason.label(),
            len,
            len,
            trailer,
        );
        let cut = floor_char_boundary(&marker, max_bytes.min(marker.len()));
        return TruncatedText {
            text: marker[..cut].to_string(),
            truncated: true,
            original_bytes: len,
            kept_bytes: cut,
            dropped_bytes: len,
        };
    }

    let head_end = floor_char_boundary(text, head.min(len));
    let tail_cap = tail.min(len.saturating_sub(head_end));
    // Snap upward so the retained tail never exceeds its byte budget.
    let raw_tail_start = len.saturating_sub(tail_cap);
    let tail_start = ceil_char_boundary(text, raw_tail_start);
    let kept_content_bytes = head_end + (len - tail_start);
    let dropped = len.saturating_sub(kept_content_bytes);

    let marker = format!(
        "\n\n[… {}: {} bytes dropped (kept {} of {}). Use a smaller scope, set max_tool_output_bytes to 0 to disable, or read the result via the `read`/`grep` tools with a tighter filter.{}]\n\n",
        reason.label(),
        dropped,
        kept_content_bytes,
        len,
        trailer,
    );

    let mut out = String::with_capacity(kept_content_bytes + marker.len());
    out.push_str(&text[..head_end]);
    out.push_str(&marker);
    out.push_str(&text[tail_start..]);

    debug_assert!(out.len() <= max_bytes);

    TruncatedText {
        kept_bytes: out.len(),
        text: out,
        truncated: true,
        original_bytes: len,
        dropped_bytes: dropped,
    }
}

/// Return a UTF-8 safe prefix of `text` with `marker` appended when the
/// character count exceeds `max_chars`.
///
/// This is for protocol fields whose limits are expressed in characters
/// rather than bytes, such as web result previews. It deliberately keeps the
/// first `max_chars` characters instead of head+tail context.
pub fn truncate_chars_with_marker(text: &str, max_chars: usize, marker: &str) -> String {
    let mut out = String::new();
    let mut chars = 0usize;
    for ch in text.chars() {
        if chars == max_chars {
            out.push_str(marker);
            return out;
        }
        out.push(ch);
        chars = chars.saturating_add(1);
    }
    out
}

/// Walk backwards from `idx` to the nearest UTF-8 char boundary at or below
/// `idx`. Avoids panicking on multi-byte sequences when callers compute
/// indices via byte arithmetic.
fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// Convenience wrapper that truncates the text content of every `Text`
/// content block in a `ToolOutput`. Non-text blocks are preserved unchanged.
pub fn truncate_tool_output(
    blocks: &[kcoder_types::ContentBlock],
    max_bytes: usize,
    head: usize,
    tail: usize,
) -> (Vec<kcoder_types::ContentBlock>, Vec<TruncatedText>) {
    let mut out = Vec::with_capacity(blocks.len());
    let mut infos = Vec::new();
    for block in blocks {
        match block {
            kcoder_types::ContentBlock::Text { text } => {
                let info = truncate_text(text, max_bytes, head, tail);
                if info.truncated {
                    infos.push(info.clone());
                }
                out.push(kcoder_types::ContentBlock::Text { text: info.text });
            }
            other => out.push(other.clone()),
        }
    }
    (out, infos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_passes_through() {
        let s = "hello".to_string();
        let r = truncate_text(&s, 100, 30, 20);
        assert!(!r.truncated);
        assert_eq!(r.text, "hello");
        assert_eq!(r.original_bytes, 5);
    }

    #[test]
    fn zero_max_means_unlimited() {
        let s = "a".repeat(10_000);
        let r = truncate_text(&s, 0, 30, 20);
        assert!(!r.truncated);
        assert_eq!(r.original_bytes, 10_000);
        assert_eq!(r.text.len(), 10_000);
    }

    #[test]
    fn large_text_is_head_tail_truncated() {
        let s = "x".repeat(200_000);
        let r = truncate_text(&s, 1000, 600, 400);
        assert!(r.truncated);
        assert!(r.text.len() <= 1000, "kept {} bytes", r.text.len());
        assert!(r.text.contains("[…"));
        assert!(r.dropped_bytes > 190_000);
        // Head bytes preserved verbatim up to whatever fit after marker overhead.
        let head_in_output: String = r.text.chars().take_while(|c| *c == 'x').collect();
        assert!(
            head_in_output.len() >= 300 && head_in_output.len() <= 600,
            "expected head 300..=600 bytes preserved, got {}",
            head_in_output.len()
        );
        // Tail bytes preserved verbatim.
        let tail_in_output: String = r
            .text
            .chars()
            .rev()
            .take_while(|c| *c == 'x')
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        assert!(
            tail_in_output.len() >= 200 && tail_in_output.len() <= 400,
            "expected tail 200..=400 bytes preserved, got {}",
            tail_in_output.len()
        );
    }

    #[test]
    fn head_tail_does_not_panic_on_multibyte_boundary() {
        // Each emoji is 4 bytes. Cutting at byte 3 would split one.
        let s: String = "😀".repeat(1000);
        let r = truncate_text(&s, 500, 300, 200);
        assert!(r.truncated);
        // The marker text itself is ASCII so the result is valid UTF-8.
        assert!(r.text.is_char_boundary(r.text.len()));
        assert!(std::str::from_utf8(r.text.as_bytes()).is_ok());
    }

    #[test]
    fn exact_limit_preserves_distinct_tail_marker() {
        let text = format!("HEAD_MARK{}TAIL_MARK", "x".repeat(300_000));
        let result = truncate_text(&text, 4096, 2048, 2048);

        assert!(result.text.len() <= 4096);
        assert!(result.text.starts_with("HEAD_MARK"));
        assert!(result.text.ends_with("TAIL_MARK"));
    }

    #[test]
    fn custom_reason_is_propagated() {
        let s = "y".repeat(10_000);
        let r = truncate_text_with_reason(&s, 100, 50, 30, TruncationReason::BackgroundPreview);
        assert!(r.truncated);
        assert!(
            r.text
                .contains("background sub-agent result preview truncated")
        );
    }

    #[test]
    fn char_marker_truncation_preserves_utf8_boundaries() {
        let text = "你好世界abc";

        let truncated = truncate_chars_with_marker(text, 3, "\n[truncated]");

        assert_eq!(truncated, "你好世\n[truncated]");
    }

    #[test]
    fn char_marker_truncation_leaves_exact_limit_unchanged() {
        assert_eq!(truncate_chars_with_marker("abcd", 4, "..."), "abcd");
    }

    #[test]
    fn spill_full_text_persists_and_reference_stays_inside_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let full = format!("HEAD_MARK{}TAIL_MARK", "x".repeat(300_000));

        let out = truncate_and_spill(&full, 4096, 2048, 2048, tmp.path());

        assert!(out.len() <= 4096, "len={}", out.len());
        assert!(out.starts_with("HEAD_MARK"));
        assert!(out.ends_with("TAIL_MARK"));
        let marker = format!("Full output at: {}", tmp.path().display());
        assert!(out.contains(&marker), "{marker}");

        let spilled = std::fs::read_dir(tmp.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(std::fs::read_to_string(spilled.path()).unwrap(), full);
    }

    #[test]
    fn historyless_client_spills_use_external_session_artifacts() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        let project_dir = tmp.path().join("client-data/project");
        let state = kcoder_state::AppState::new(&workspace);
        state.with_session_artifact_project_dir(&project_dir, "client-session");
        let spill_dir = spill_dir_for_state(&state);

        assert_eq!(
            spill_dir,
            project_dir.join("client-session").join("tool-results")
        );
        let output = truncate_and_spill(&"x".repeat(10_000), 512, 200, 200, &spill_dir);

        assert!(output.contains("Full output at:"));
        assert!(spill_dir.is_dir());
        assert!(!workspace.join(".kcoder").exists());
    }

    #[test]
    fn truncate_and_spill_degrades_to_plain_truncation_when_dir_unwritable() {
        let full = format!("HEAD_MARK{}TAIL_MARK", "y".repeat(300_000));
        let invalid_dir = tempfile::NamedTempFile::new().unwrap();

        let out = truncate_and_spill(&full, 4096, 2048, 2048, invalid_dir.path());

        assert!(out.len() <= 4096);
        assert!(out.starts_with("HEAD_MARK"));
        assert!(out.ends_with("TAIL_MARK"));
        assert!(!out.contains("Full output at:"));
    }

    #[test]
    fn tool_output_truncation_handles_text_blocks() {
        use kcoder_types::ContentBlock;
        let blocks = vec![
            ContentBlock::Text {
                text: "a".repeat(2000),
            },
            ContentBlock::Text {
                text: "small".to_string(),
            },
        ];
        let (out, infos) = truncate_tool_output(&blocks, 1000, 500, 400);
        assert_eq!(out.len(), 2);
        assert_eq!(infos.len(), 1);
        if let ContentBlock::Text { text } = &out[0] {
            assert!(text.len() < 2000);
        } else {
            panic!("expected text block");
        }
        if let ContentBlock::Text { text } = &out[1] {
            assert_eq!(text, "small");
        } else {
            panic!("expected text block");
        }
    }
}
