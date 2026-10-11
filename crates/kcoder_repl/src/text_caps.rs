pub(crate) const ACTIVE_TURN_TEXT_MAX_CHARS: usize = 1_000_000;
pub(crate) const ACTIVE_TOOL_INPUT_MAX_CHARS: usize = 8_000;
pub(crate) const TUI_TRUNCATION_MARKER: &str = "TUI display truncated";

fn append_tui_truncation_notice(existing: &mut String, label: &str, max_chars: usize) {
    if existing.contains(TUI_TRUNCATION_MARKER) {
        return;
    }
    existing.push_str(&format!(
        "\n\n[{label} TUI display truncated after {max_chars} chars; full content remains in session state.]"
    ));
}

pub(crate) fn append_capped_tui_text(
    existing: &mut String,
    text: &str,
    max_chars: usize,
    label: &str,
) {
    if text.is_empty() || existing.contains(TUI_TRUNCATION_MARKER) {
        return;
    }

    let current_chars = existing.chars().count();
    if current_chars >= max_chars {
        append_tui_truncation_notice(existing, label, max_chars);
        return;
    }

    let remaining = max_chars - current_chars;
    let mut chars = text.chars();
    for ch in chars.by_ref().take(remaining) {
        existing.push(ch);
    }
    if chars.next().is_some() {
        append_tui_truncation_notice(existing, label, max_chars);
    }
}

pub(crate) fn capped_tui_text(text: &str, max_chars: usize, label: &str) -> String {
    let mut out = String::new();
    append_capped_tui_text(&mut out, text, max_chars, label);
    out
}
