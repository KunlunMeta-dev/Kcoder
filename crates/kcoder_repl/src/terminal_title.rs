//! Terminal-title output helpers for the TUI.
//!
//! The title payload can be assembled from project paths, user-provided
//! session names, and model/tool status. Treat it as untrusted text before
//! writing it into an OSC sequence.

use std::fmt;
use std::io;
use std::io::Write;

use crossterm::Command;
use unicode_segmentation::UnicodeSegmentation;

const MAX_TERMINAL_TITLE_CHARS: usize = 240;

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) enum TerminalTitleWrite {
    Applied(String),
    NoVisibleContent,
}

pub(crate) fn write_terminal_title(
    writer: &mut impl Write,
    title: &str,
) -> io::Result<TerminalTitleWrite> {
    let title = sanitize_terminal_title(title);
    if title.is_empty() {
        return Ok(TerminalTitleWrite::NoVisibleContent);
    }
    write_sanitized_terminal_title(writer, &title)?;
    Ok(TerminalTitleWrite::Applied(title))
}

pub(crate) fn write_sanitized_terminal_title(
    writer: &mut impl Write,
    title: &str,
) -> io::Result<()> {
    let mut ansi = String::new();
    SetWindowTitle(title.to_string())
        .write_ansi(&mut ansi)
        .map_err(io::Error::other)?;
    writer.write_all(ansi.as_bytes())
}

pub(crate) fn clear_terminal_title(writer: &mut impl Write) -> io::Result<()> {
    write_sanitized_terminal_title(writer, "")
}

#[derive(Debug, Clone)]
struct SetWindowTitle(String);

impl Command for SetWindowTitle {
    fn write_ansi(&self, f: &mut impl fmt::Write) -> fmt::Result {
        // Match crossterm's SetTitle command and terminate OSC 0 with BEL.
        write!(f, "\x1b]0;{}\x07", self.0)
    }

    #[cfg(windows)]
    fn execute_winapi(&self) -> io::Result<()> {
        Err(io::Error::other(
            "tried to execute SetWindowTitle using WinAPI; use ANSI instead",
        ))
    }

    #[cfg(windows)]
    fn is_ansi_code_supported(&self) -> bool {
        true
    }
}

pub(crate) fn sanitize_terminal_title(title: &str) -> String {
    let mut sanitized = String::new();
    let mut chars_written = 0;
    let mut pending_space = false;

    for ch in title.chars() {
        if ch.is_whitespace() {
            pending_space = !sanitized.is_empty();
            continue;
        }

        if is_disallowed_terminal_title_char(ch) {
            continue;
        }

        if pending_space {
            let remaining = MAX_TERMINAL_TITLE_CHARS.saturating_sub(chars_written);
            if remaining > 1 {
                sanitized.push(' ');
                chars_written += 1;
                pending_space = false;
            }
        }

        if chars_written >= MAX_TERMINAL_TITLE_CHARS {
            break;
        }

        sanitized.push(ch);
        chars_written += 1;
    }

    sanitized
}

/// Truncates a title segment by grapheme cluster and appends `...` when needed.
pub(crate) fn truncate_terminal_title_part(value: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }

    let mut graphemes = value.graphemes(true);
    let head: String = graphemes.by_ref().take(max_chars).collect();
    if graphemes.next().is_none() || max_chars <= 3 {
        return head;
    }

    let mut truncated = head.graphemes(true).take(max_chars - 3).collect::<String>();
    truncated.push_str("...");
    truncated
}

fn is_disallowed_terminal_title_char(ch: char) -> bool {
    if ch.is_control() {
        return true;
    }

    matches!(
        ch,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{E0100}'..='\u{E01EF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_terminal_title() {
        let sanitized =
            sanitize_terminal_title("  Project\t|\nWorking\x1b\x07\u{009D}\u{009C} |  Thread  ");

        assert_eq!(sanitized, "Project | Working | Thread");
    }

    #[test]
    fn strips_invisible_format_chars_from_terminal_title() {
        let sanitized = sanitize_terminal_title(
            "Pro\u{202E}j\u{2066}e\u{200F}c\u{061C}t\u{200B} \u{FEFF}T\u{2060}itle",
        );

        assert_eq!(sanitized, "Project Title");
    }

    #[test]
    fn truncates_terminal_title() {
        let input = "a".repeat(MAX_TERMINAL_TITLE_CHARS + 10);
        let sanitized = sanitize_terminal_title(&input);

        assert_eq!(sanitized.len(), MAX_TERMINAL_TITLE_CHARS);
    }

    #[test]
    fn truncation_prefers_visible_char_over_pending_space() {
        let input = format!("{} b", "a".repeat(MAX_TERMINAL_TITLE_CHARS - 1));
        let sanitized = sanitize_terminal_title(&input);

        assert_eq!(sanitized.len(), MAX_TERMINAL_TITLE_CHARS);
        assert_eq!(sanitized.chars().last(), Some('b'));
    }

    #[test]
    fn truncates_title_part_by_grapheme_cluster() {
        let family = "👨‍👩‍👧‍👦";
        let value = format!("{family}{family}{family}{family}abcd");

        assert_eq!(
            truncate_terminal_title_part(&value, 5),
            format!("{family}{family}...")
        );
        assert_eq!(truncate_terminal_title_part(&value, 0), "");
        assert_eq!(truncate_terminal_title_part("abcdef", 3), "abc");
    }

    #[test]
    fn writes_osc_title_with_bel_terminator() {
        let mut out = Vec::new();

        let result = write_terminal_title(&mut out, "hello").expect("write title");

        assert_eq!(result, TerminalTitleWrite::Applied("hello".to_string()));
        assert_eq!(String::from_utf8(out).unwrap(), "\x1b]0;hello\x07");
    }

    #[test]
    fn set_window_title_command_uses_expected_osc_encoding() {
        let mut out = String::new();

        SetWindowTitle("hello".to_string())
            .write_ansi(&mut out)
            .expect("encode terminal title");

        assert_eq!(out, "\x1b]0;hello\x07");
    }

    #[test]
    fn skips_title_when_no_visible_content_remains() {
        let mut out = Vec::new();

        let result =
            write_terminal_title(&mut out, "\x1b\u{202E}\u{200B}\n").expect("skip empty title");

        assert_eq!(result, TerminalTitleWrite::NoVisibleContent);
        assert!(out.is_empty());
    }

    #[test]
    fn clears_title_with_empty_payload() {
        let mut out = Vec::new();

        clear_terminal_title(&mut out).expect("clear title");

        assert_eq!(String::from_utf8(out).unwrap(), "\x1b]0;\x07");
    }
}
