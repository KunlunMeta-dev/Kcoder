//! Programmatically generated terminal-compatible glyphs.

/// Table headers use a heavier ASCII separator so ambiguous-width glyphs cannot invade the scrollbar column.
pub(crate) const TABLE_HEADER_SEPARATOR: char = '=';
/// Table bodies use a single-width ASCII separator.
pub(crate) const TABLE_BODY_SEPARATOR: char = '-';
/// Sub-agent status areas use a single-width ASCII separator.
pub(crate) const PANEL_STATUS_SEPARATOR: char = '-';

#[cfg(test)]
mod tests {
    use super::*;
    use unicode_width::UnicodeWidthChar;

    #[test]
    fn generated_horizontal_separators_are_single_width_in_all_policies() {
        for glyph in [
            TABLE_HEADER_SEPARATOR,
            TABLE_BODY_SEPARATOR,
            PANEL_STATUS_SEPARATOR,
        ] {
            assert!(glyph.is_ascii());
            assert_eq!(glyph.width(), Some(1));
            assert_eq!(glyph.width_cjk(), Some(1));
        }
    }
}
