use std::borrow::Cow;

#[cfg(windows)]
pub(crate) const UI_SEPARATOR: &str = " | ";
#[cfg(not(windows))]
pub(crate) const UI_SEPARATOR: &str = " · ";

#[cfg(windows)]
pub(crate) const UI_ELLIPSIS: &str = "~";
#[cfg(not(windows))]
pub(crate) const UI_ELLIPSIS: &str = "…";

#[cfg(windows)]
pub(crate) fn use_compact_startup_logo() -> bool {
    // Windows Terminal and other modern terminal emulators provide their own
    // wcwidth-compatible renderer. The compact grid is only for classic
    // conhost, where CJK ambiguous-width glyphs and wide cells distort the
    // original Linux proportions.
    std::env::var_os("TERM").is_none()
        && std::env::var_os("TERM_PROGRAM").is_none()
        && std::env::var_os("WT_SESSION").is_none()
}

/// Keep application-owned status text single-cell on the legacy Windows
/// Console. Conhost may render East Asian Ambiguous glyphs as two cells while
/// ratatui/unicode-width accounts for them as one.
pub(crate) fn status_text(text: &str) -> Cow<'_, str> {
    #[cfg(not(windows))]
    {
        Cow::Borrowed(text)
    }

    #[cfg(windows)]
    {
        if !text.chars().any(is_ambiguous_ui_glyph) {
            return Cow::Borrowed(text);
        }

        Cow::Owned(
            text.chars()
                .map(|ch| match ch {
                    '·' => '-',
                    '•' => '*',
                    '…' => '~',
                    '◇' => 'o',
                    '◈' | '◆' => 'O',
                    '▁' | '▃' | '▆' | '█' | '▄' | '▀' | '■' | '░' => '#',
                    '⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏' => {
                        '*'
                    }
                    _ => ch,
                })
                .collect(),
        )
    }
}

#[cfg(windows)]
fn is_ambiguous_ui_glyph(ch: char) -> bool {
    matches!(
        ch,
        '·' | '•'
            | '…'
            | '◇'
            | '◈'
            | '◆'
            | '▁'
            | '▃'
            | '▆'
            | '█'
            | '▄'
            | '▀'
            | '■'
            | '░'
            | '⠋'
            | '⠙'
            | '⠹'
            | '⠸'
            | '⠼'
            | '⠴'
            | '⠦'
            | '⠧'
            | '⠇'
            | '⠏'
    )
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn status_text_replaces_ambiguous_console_glyphs() {
        let rendered = status_text("◇ Running · waiting… ▁▃▆█");
        assert_eq!(rendered, "o Running - waiting~ ####");
        assert!(rendered.is_ascii());
    }
}
