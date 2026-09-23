//! Shared syntax highlighting helpers for TUI renderers.
//!
//! Syntax/theme lookup, guardrails, and syntect-to-ratatui style conversion
//! live in one render module instead of each renderer carrying its own rules.

use ratatui::style::Color;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use std::collections::BTreeMap;
use std::sync::OnceLock;
#[cfg(test)]
use syntect::easy::HighlightLines;
use syntect::highlighting::Color as SyntectColor;
use syntect::highlighting::FontStyle;
use syntect::highlighting::Highlighter;
use syntect::highlighting::Style as SyntectStyle;
use syntect::highlighting::Theme;
use syntect::parsing::Scope;
use syntect::parsing::SyntaxReference;
use syntect::parsing::SyntaxSet;
#[cfg(test)]
use syntect::util::LinesWithEndings;
use two_face::theme::EmbeddedThemeName;

mod streaming;

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static THEME_SET: OnceLock<BTreeMap<String, Theme>> = OnceLock::new();

const DEFAULT_THEME_NAME: &str = "auto";
const ANSI_ALPHA_INDEX: u8 = 0x00;
const ANSI_ALPHA_DEFAULT: u8 = 0x01;
const OPAQUE_ALPHA: u8 = 0xff;
// Limit syntax highlighting for one code block without disabling Markdown for the entire message.
const MAX_HIGHLIGHT_BYTES: usize = 512 * 1024;
const MAX_HIGHLIGHT_LINES: usize = 10_000;
const MAX_HIGHLIGHT_LINE_BYTES: usize = 4 * 1024;

fn syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(two_face::syntax::extra_newlines)
}

fn theme_set() -> &'static BTreeMap<String, Theme> {
    THEME_SET.get_or_init(|| {
        let bundled = two_face::theme::extra();
        embedded_themes()
            .iter()
            .map(|(name, embedded)| ((*name).to_string(), bundled.get(*embedded).clone()))
            .collect()
    })
}

fn theme(theme_name: &str) -> &'static Theme {
    let set = theme_set();
    let theme_name = canonical_theme_name(theme_name);
    set.get(theme_name)
        .or_else(|| set.get(adaptive_default_theme_name()))
        .or_else(|| set.values().next())
        .expect("theme set is non-empty")
}

pub(crate) fn theme_names() -> Vec<String> {
    let mut themes = vec![DEFAULT_THEME_NAME.to_string()];
    themes.extend(theme_set().keys().cloned());
    themes.sort_by_key(|theme| theme.to_ascii_lowercase());
    themes
}

fn adaptive_default_theme_name() -> &'static str {
    match crate::theme::diff_theme_for_bg(crate::terminal_palette::default_bg()) {
        crate::theme::DiffTheme::Light => "catppuccin-latte",
        crate::theme::DiffTheme::Dark => "catppuccin-mocha",
    }
}

fn canonical_theme_name(theme_name: &str) -> &str {
    match theme_name {
        "" | "auto" => adaptive_default_theme_name(),
        "base16-eighties.dark" => "base16-eighties-dark",
        "base16-mocha.dark" => "base16-mocha-dark",
        "base16-ocean.dark" => "base16-ocean-dark",
        "base16-ocean.light" => "base16-ocean-light",
        "InspiredGitHub" => "inspired-github",
        "Solarized (dark)" => "solarized-dark",
        "Solarized (light)" => "solarized-light",
        theme_name => theme_name,
    }
}

const fn embedded_themes() -> &'static [(&'static str, EmbeddedThemeName)] {
    &[
        ("1337", EmbeddedThemeName::Leet),
        ("ansi", EmbeddedThemeName::Ansi),
        ("base16", EmbeddedThemeName::Base16),
        ("base16-256", EmbeddedThemeName::Base16_256),
        (
            "base16-eighties-dark",
            EmbeddedThemeName::Base16EightiesDark,
        ),
        ("base16-mocha-dark", EmbeddedThemeName::Base16MochaDark),
        ("base16-ocean-dark", EmbeddedThemeName::Base16OceanDark),
        ("base16-ocean-light", EmbeddedThemeName::Base16OceanLight),
        ("catppuccin-frappe", EmbeddedThemeName::CatppuccinFrappe),
        ("catppuccin-latte", EmbeddedThemeName::CatppuccinLatte),
        (
            "catppuccin-macchiato",
            EmbeddedThemeName::CatppuccinMacchiato,
        ),
        ("catppuccin-mocha", EmbeddedThemeName::CatppuccinMocha),
        ("coldark-cold", EmbeddedThemeName::ColdarkCold),
        ("coldark-dark", EmbeddedThemeName::ColdarkDark),
        ("dark-neon", EmbeddedThemeName::DarkNeon),
        ("dracula", EmbeddedThemeName::Dracula),
        ("github", EmbeddedThemeName::Github),
        ("gruvbox-dark", EmbeddedThemeName::GruvboxDark),
        ("gruvbox-light", EmbeddedThemeName::GruvboxLight),
        ("inspired-github", EmbeddedThemeName::InspiredGithub),
        ("monokai-extended", EmbeddedThemeName::MonokaiExtended),
        (
            "monokai-extended-bright",
            EmbeddedThemeName::MonokaiExtendedBright,
        ),
        (
            "monokai-extended-light",
            EmbeddedThemeName::MonokaiExtendedLight,
        ),
        (
            "monokai-extended-origin",
            EmbeddedThemeName::MonokaiExtendedOrigin,
        ),
        ("nord", EmbeddedThemeName::Nord),
        ("one-half-dark", EmbeddedThemeName::OneHalfDark),
        ("one-half-light", EmbeddedThemeName::OneHalfLight),
        ("solarized-dark", EmbeddedThemeName::SolarizedDark),
        ("solarized-light", EmbeddedThemeName::SolarizedLight),
        ("sublime-snazzy", EmbeddedThemeName::SublimeSnazzy),
        ("two-dark", EmbeddedThemeName::TwoDark),
        ("zenburn", EmbeddedThemeName::Zenburn),
    ]
}

fn find_syntax(lang: &str) -> Option<&'static SyntaxReference> {
    let ss = syntax_set();
    let patched = match lang {
        "csharp" | "c-sharp" => "c#",
        "golang" => "go",
        "python3" => "python",
        "shell" => "bash",
        _ => lang,
    };

    if let Some(syntax) = ss.find_syntax_by_token(patched) {
        return Some(syntax);
    }
    if let Some(syntax) = ss.find_syntax_by_name(patched) {
        return Some(syntax);
    }

    let lower = patched.to_ascii_lowercase();
    if let Some(syntax) = ss
        .syntaxes()
        .iter()
        .find(|syntax| syntax.name.to_ascii_lowercase() == lower)
    {
        return Some(syntax);
    }

    ss.find_syntax_by_extension(lang)
}

pub(crate) fn exceeds_highlight_limits(total_bytes: usize, total_lines: usize) -> bool {
    total_bytes > MAX_HIGHLIGHT_BYTES || total_lines > MAX_HIGHLIGHT_LINES
}

#[cfg(test)]
fn highlight_to_line_spans_with_theme(
    code: &str,
    lang: &str,
    theme: &Theme,
) -> Option<Vec<Vec<Span<'static>>>> {
    if !can_highlight(code) {
        return None;
    }

    let syntax = find_syntax(lang)?;
    let mut highlighter = HighlightLines::new(syntax, theme);
    let mut lines = Vec::new();

    for line in LinesWithEndings::from(code) {
        let ranges = highlighter.highlight_line(line, syntax_set()).ok()?;
        lines.push(highlighted_line_spans(ranges));
    }

    Some(lines)
}

fn can_highlight(code: &str) -> bool {
    !code.is_empty()
        && !exceeds_highlight_limits(code.len(), code.lines().count())
        && !code
            .lines()
            .any(|line| line.len() > MAX_HIGHLIGHT_LINE_BYTES)
}

fn highlighted_line_spans(ranges: Vec<(SyntectStyle, &str)>) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    for (style, text) in ranges {
        let text = text.trim_end_matches(['\n', '\r']);
        if !text.is_empty() {
            spans.push(Span::styled(text.to_string(), convert_style(style)));
        }
    }
    if spans.is_empty() {
        spans.push(Span::raw(String::new()));
    }
    spans
}

fn plain_code_lines(code: &str) -> Vec<Line<'static>> {
    let mut lines = code
        .lines()
        .map(|line| Line::from(line.to_string()))
        .collect::<Vec<_>>();
    if lines.is_empty() {
        lines.push(Line::from(String::new()));
    }
    lines
}

pub(crate) fn highlight_code_to_lines(code: &str, lang: &str) -> Vec<Line<'static>> {
    highlight_code_to_lines_with_theme(code, lang, DEFAULT_THEME_NAME)
}

pub(crate) fn highlight_code_to_lines_with_theme(
    code: &str,
    lang: &str,
    theme_name: &str,
) -> Vec<Line<'static>> {
    match highlight_code_to_styled_spans_with_theme(code, lang, theme_name) {
        Some(line_spans) => line_spans.into_iter().map(Line::from).collect(),
        None => plain_code_lines(code),
    }
}

pub(crate) fn highlight_bash_to_lines(script: &str) -> Vec<Line<'static>> {
    highlight_code_to_lines(script, "bash")
}

pub(crate) fn highlight_code_to_styled_spans(
    code: &str,
    lang: &str,
) -> Option<Vec<Vec<Span<'static>>>> {
    highlight_code_to_styled_spans_with_theme(code, lang, DEFAULT_THEME_NAME)
}

pub(crate) fn highlight_code_to_styled_spans_with_theme(
    code: &str,
    lang: &str,
    theme_name: &str,
) -> Option<Vec<Vec<Span<'static>>>> {
    streaming::highlight_cached(code, lang, theme(theme_name))
}

/// Read the first available semantic foreground color from the active code theme for reuse by elements such as Markdown table headers.
pub(crate) fn foreground_style_for_scopes_with_theme(
    theme_name: &str,
    scope_names: &[&str],
) -> Option<Style> {
    let highlighter = Highlighter::new(theme(theme_name));
    for scope_name in scope_names {
        let Ok(scope) = Scope::new(scope_name) else {
            continue;
        };
        let Some(foreground) = highlighter.style_mod_for_stack(&[scope]).foreground else {
            continue;
        };
        if let Some(color) = convert_syntect_color(foreground) {
            return Some(Style::default().fg(color));
        }
    }
    None
}

fn convert_style(syn_style: SyntectStyle) -> Style {
    let mut rt_style = Style::default();
    if let Some(fg) = convert_syntect_color(syn_style.foreground) {
        rt_style = rt_style.fg(fg);
    }

    if syn_style.font_style.contains(FontStyle::BOLD) {
        rt_style = rt_style.add_modifier(Modifier::BOLD);
    }

    rt_style
}

#[allow(clippy::disallowed_methods)]
fn ansi_palette_color(index: u8) -> Color {
    match index {
        0x00 => Color::Black,
        0x01 => Color::Red,
        0x02 => Color::Green,
        0x03 => Color::Yellow,
        0x04 => Color::Blue,
        0x05 => Color::Magenta,
        0x06 => Color::Cyan,
        0x07 => Color::Gray,
        n => Color::Indexed(n),
    }
}

#[allow(clippy::disallowed_methods)]
fn convert_syntect_color(color: SyntectColor) -> Option<Color> {
    match color.a {
        ANSI_ALPHA_INDEX => Some(ansi_palette_color(color.r)),
        ANSI_ALPHA_DEFAULT => None,
        OPAQUE_ALPHA => Some(Color::Rgb(color.r, color.g, color.b)),
        _ => Some(Color::Rgb(color.r, color.g, color.b)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syntect_test_style(foreground: SyntectColor, font_style: FontStyle) -> SyntectStyle {
        SyntectStyle {
            foreground,
            background: SyntectColor {
                r: 0,
                g: 0,
                b: 0,
                a: OPAQUE_ALPHA,
            },
            font_style,
        }
    }

    fn line_text(line: &Line<'_>) -> String {
        line.spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect()
    }

    #[test]
    fn ansi_alpha_maps_to_terminal_palette_colors() {
        let low = SyntectColor {
            r: 0x07,
            g: 0,
            b: 0,
            a: ANSI_ALPHA_INDEX,
        };
        assert_eq!(convert_syntect_color(low), Some(Color::Gray));

        let indexed = SyntectColor {
            r: 0x9a,
            g: 0,
            b: 0,
            a: ANSI_ALPHA_INDEX,
        };
        assert_eq!(convert_syntect_color(indexed), Some(Color::Indexed(0x9a)));
    }

    #[test]
    fn default_alpha_leaves_terminal_foreground_unchanged() {
        let color = SyntectColor {
            r: 1,
            g: 2,
            b: 3,
            a: ANSI_ALPHA_DEFAULT,
        };
        assert_eq!(convert_syntect_color(color), None);
    }

    #[test]
    fn style_conversion_preserves_bold_but_not_italic_or_underline() {
        let rt_style = convert_style(syntect_test_style(
            SyntectColor {
                r: 10,
                g: 20,
                b: 30,
                a: OPAQUE_ALPHA,
            },
            FontStyle::BOLD | FontStyle::ITALIC | FontStyle::UNDERLINE,
        ));

        assert_eq!(rt_style.fg, Some(Color::Rgb(10, 20, 30)));
        assert!(rt_style.add_modifier.contains(Modifier::BOLD));
        assert!(!rt_style.add_modifier.contains(Modifier::ITALIC));
        assert!(!rt_style.add_modifier.contains(Modifier::UNDERLINED));
    }

    #[test]
    fn highlight_known_language_preserves_content() {
        let lines = highlight_code_to_lines("let x = 1;\n", "rust");

        assert_eq!(
            lines.iter().map(line_text).collect::<Vec<_>>(),
            vec!["let x = 1;"]
        );
        assert!(
            lines[0]
                .spans
                .iter()
                .any(|span| span.style != Style::default())
        );
    }

    #[test]
    fn highlight_unknown_language_falls_back_to_plain_text() {
        let lines = highlight_code_to_lines("x = 1\n", "xyzlang");

        assert_eq!(
            lines.iter().map(line_text).collect::<Vec<_>>(),
            vec!["x = 1"]
        );
        assert!(
            lines[0]
                .spans
                .iter()
                .all(|span| span.style == Style::default())
        );
    }

    #[test]
    fn patched_language_aliases_resolve() {
        assert!(highlight_code_to_styled_spans("echo ok", "shell").is_some());
        assert!(highlight_code_to_styled_spans("print('ok')", "python3").is_some());
    }

    #[test]
    fn large_inputs_skip_highlighting() {
        let big = "x".repeat(MAX_HIGHLIGHT_BYTES + 1);

        assert!(highlight_code_to_styled_spans(&big, "rust").is_none());
    }

    #[test]
    fn theme_names_are_sorted() {
        let names = theme_names();
        let mut sorted = names.clone();
        sorted.sort_by_key(|name| name.to_lowercase());

        assert_eq!(names, sorted);
        assert!(names.iter().any(|name| name == DEFAULT_THEME_NAME));
        assert_eq!(names.len(), 33);
        assert!(names.iter().any(|name| name == "catppuccin-mocha"));
    }

    #[test]
    fn auto_and_legacy_theme_names_resolve_compatibly() {
        assert_eq!(canonical_theme_name("auto"), "catppuccin-mocha");
        assert_eq!(
            canonical_theme_name("base16-ocean.dark"),
            "base16-ocean-dark"
        );
        assert!(
            highlight_code_to_styled_spans_with_theme(
                "let value = true;",
                "rust",
                "base16-ocean.dark"
            )
            .is_some()
        );
    }

    #[test]
    fn table_semantic_scope_uses_selected_theme_foreground() {
        let style = foreground_style_for_scopes_with_theme(
            "base16-ocean.dark",
            &["entity.name.type", "support.type", "variable"],
        )
        .expect("默认主题应提供表头语义色");

        assert!(style.fg.is_some());
    }
}
