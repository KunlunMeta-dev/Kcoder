use crate::navigation_render::{
    MAX_NAVIGATION_LINE_BYTES, NavigationBudget, NavigationHeading, NavigationRenderError,
};
use crate::render::highlight::{
    foreground_style_for_scopes_with_theme, highlight_code_to_lines_with_theme,
};
use crate::render::wrapping::text_contains_url_like;
use crate::table_detect::{
    is_markdown_fence_info, is_table_delimiter_line, is_table_header_line, parse_fence_marker,
    strip_blockquote_prefix,
};
use crate::terminal_glyphs::{TABLE_BODY_SEPARATOR, TABLE_HEADER_SEPARATOR};
use crate::terminal_hyperlinks::{
    HyperlinkLine, TerminalHyperlink, visible_lines, web_destination, web_links_in_text,
};
use crate::theme::{KCODER_UI_THEME, UiTextStyles};
use pulldown_cmark::{Alignment, Event, Options, Parser, Tag, TagEnd};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use std::borrow::Cow;
use std::iter::Peekable;
use std::ops::Range;
use std::path::{Path, PathBuf};
use url::Url;

mod web_links;

const TABLE_COLUMN_GAP: usize = 2;
const TABLE_CELL_PADDING: usize = 1;
const TABLE_MIN_COLUMN_WIDTH: usize = 3;
const FIELD_LEADING_PADDING: usize = 1;
const FIELD_GAP: usize = 2;
const MIN_RECORD_VALUE_WIDTH: usize = 3;
const MIN_ALIGNED_COMPACT_VALUE_WIDTH: usize = 12;
const MIN_ALIGNED_EXPANSIVE_VALUE_WIDTH: usize = 24;
const STACKED_RECORD_VALUE_INDENT: usize = 2;
const MIN_SCANNABLE_NARRATIVE_WIDTH: usize = 12;
const MIN_SCANNABLE_TOKEN_HEAVY_WIDTH: usize = 12;
const CRAMPED_EXPANSIVE_CELL_LINES: usize = 4;
const CATASTROPHIC_NARRATIVE_CELL_LINES: usize = 7;

/// Render Markdown text into styled `Line`s for ratatui using the default theme.
#[allow(dead_code)]
pub fn render_markdown(text: &str) -> Vec<Line<'static>> {
    render_markdown_with_theme(text, "auto")
}

/// Render Markdown with a specific syntect code theme.
pub fn render_markdown_with_theme(text: &str, code_theme: &str) -> Vec<Line<'static>> {
    let cwd = std::env::current_dir().ok();
    visible_lines(render_markdown_hyperlink_lines_with_theme_and_cwd(
        text,
        code_theme,
        cwd.as_deref(),
        None,
    ))
}

#[cfg(test)]
fn render_markdown_with_theme_and_cwd(
    text: &str,
    code_theme: &str,
    cwd: Option<&Path>,
) -> Vec<Line<'static>> {
    visible_lines(render_markdown_hyperlink_lines_with_theme_and_cwd(
        text, code_theme, cwd, None,
    ))
}

pub(crate) fn render_markdown_hyperlink_lines_with_theme(
    text: &str,
    code_theme: &str,
) -> Vec<HyperlinkLine> {
    let cwd = std::env::current_dir().ok();
    render_markdown_hyperlink_lines_with_theme_and_cwd(text, code_theme, cwd.as_deref(), None)
}

pub(crate) fn render_markdown_hyperlink_lines_with_theme_and_width(
    text: &str,
    code_theme: &str,
    width: Option<usize>,
) -> Vec<HyperlinkLine> {
    let cwd = std::env::current_dir().ok();
    render_markdown_hyperlink_lines_with_theme_and_cwd(text, code_theme, cwd.as_deref(), width)
}

pub(crate) fn render_agent_markdown_hyperlink_lines_with_theme(
    text: &str,
    code_theme: &str,
) -> Vec<HyperlinkLine> {
    let cwd = std::env::current_dir().ok();
    let normalized = unwrap_markdown_fences(text);
    render_markdown_hyperlink_lines_with_theme_and_cwd(
        &normalized,
        code_theme,
        cwd.as_deref(),
        None,
    )
}

pub(crate) fn render_agent_markdown_hyperlink_lines_with_theme_and_width(
    text: &str,
    code_theme: &str,
    width: Option<usize>,
) -> Vec<HyperlinkLine> {
    let cwd = std::env::current_dir().ok();
    let normalized = unwrap_markdown_fences(text);
    render_markdown_hyperlink_lines_with_theme_and_cwd(
        &normalized,
        code_theme,
        cwd.as_deref(),
        width,
    )
}

fn render_markdown_hyperlink_lines_with_theme_and_cwd(
    text: &str,
    code_theme: &str,
    cwd: Option<&Path>,
    width: Option<usize>,
) -> Vec<HyperlinkLine> {
    render_markdown_hyperlink_lines_with_theme_and_cwd_policy(
        text,
        code_theme,
        cwd,
        width,
        web_links::hide_web_link_destinations(),
    )
}

fn render_markdown_hyperlink_lines_with_theme_and_cwd_policy(
    text: &str,
    code_theme: &str,
    cwd: Option<&Path>,
    width: Option<usize>,
    hide_web_link_destinations: bool,
) -> Vec<HyperlinkLine> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = DecodedTextMerge::new(Parser::new_ext(text, options).into_offset_iter());
    let mut renderer =
        MarkdownRenderer::new(text, code_theme, cwd, width, hide_web_link_destinations);
    for (event, range) in parser {
        renderer.handle(event, range);
    }
    let lines = renderer.finish();
    if let Some(width) = width {
        wrap_markdown_hyperlink_lines(lines, width)
    } else {
        lines
    }
}

/// Pre-load Markdown rendering resources so the first TUI frame does not
/// pay the cost of initializing syntect and pulldown-cmark on the hot path.
pub fn warm_up(code_theme: &str) {
    const SAMPLE: &str = r#"
# Warm-up
Some **bold** text and `inline code`.

```rust
fn main() {
    println!("hello");
}
```
"#;
    let _ = render_markdown_with_theme(SAMPLE, code_theme);
}

mod navigation;
pub(super) use navigation::{navigation_headings, stream_navigation_markdown};
mod parser;
use parser::*;
mod state;
use state::*;
mod blocks;
mod code;
use code::*;
mod inline;
use inline::*;
mod tables;
use tables::*;
mod links;
use links::*;


#[cfg(test)]
#[rustfmt::skip]
#[path = "markdown/tests.rs"]
mod tests;
