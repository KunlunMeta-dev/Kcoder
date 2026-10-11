#![allow(dead_code)]

//! KCoder TUI theme system.
//!
//! `UiTheme` centralizes semantic colors used by components. Markdown styling
//! combines terminal defaults, a small accent palette, and text modifiers.

use ratatui::style::{Color, Modifier, Style};
use std::sync::OnceLock;

/// KCoder brand colors and local surface colors that require fixed RGB values.
pub const KCODER_TEXT_BODY_RGB: (u8, u8, u8) = (210, 210, 210); // #D2D2D2
pub const KCODER_TEXT_SOFT_RGB: (u8, u8, u8) = (178, 178, 178); // #B2B2B2
pub const KCODER_TEXT_MUTED_RGB: (u8, u8, u8) = (128, 128, 128); // #808080
pub const KCODER_TEXT_HINT_RGB: (u8, u8, u8) = (96, 96, 96); // #606060
pub const KCODER_ACCENT_PRIMARY_RGB: (u8, u8, u8) = (0, 255, 255); // terminal cyan
pub const KCODER_ACCENT_SECONDARY_RGB: (u8, u8, u8) = (180, 180, 180); // neutral accent
pub const KCODER_ACCENT_ACTION_RGB: (u8, u8, u8) = (0, 255, 255);
pub const KCODER_WELCOME_ORANGE_RGB: (u8, u8, u8) = (255, 154, 72); // Startup accent.
pub const KCODER_ERROR_SURFACE_RGB: (u8, u8, u8) = (36, 18, 22);
pub const KCODER_BORDER_RGB: (u8, u8, u8) = (58, 58, 58);
pub const KCODER_REASONING_TEXT_RGB: (u8, u8, u8) = (165, 140, 95);
pub const KCODER_REASONING_SURFACE_RGB: (u8, u8, u8) = (24, 22, 18);
pub const KCODER_REASONING_TINT_RGB: (u8, u8, u8) = (18, 18, 18);

pub const KCODER_DIFF_ADDED_BG_RGB: (u8, u8, u8) = (33, 58, 43); // #213A2B
pub const KCODER_DIFF_DELETED_BG_RGB: (u8, u8, u8) = (74, 34, 29); // #4A221D
const KCODER_DIFF_DARK_256_ADDED_BG_INDEX: u8 = 22;
const KCODER_DIFF_DARK_256_DELETED_BG_INDEX: u8 = 52;
const KCODER_DIFF_LIGHT_ADDED_BG_RGB: (u8, u8, u8) = (218, 251, 225); // #DAFBE1
const KCODER_DIFF_LIGHT_DELETED_BG_RGB: (u8, u8, u8) = (255, 235, 233); // #FFEBE9
const KCODER_DIFF_LIGHT_ADDED_NUM_BG_RGB: (u8, u8, u8) = (172, 238, 187); // #ACEEBB
const KCODER_DIFF_LIGHT_DELETED_NUM_BG_RGB: (u8, u8, u8) = (255, 206, 203); // #FFCECB
const KCODER_DIFF_LIGHT_GUTTER_FG_RGB: (u8, u8, u8) = (31, 35, 40); // #1F2328
const KCODER_DIFF_LIGHT_256_ADDED_BG_INDEX: u8 = 194;
const KCODER_DIFF_LIGHT_256_DELETED_BG_INDEX: u8 = 224;
const KCODER_DIFF_LIGHT_256_ADDED_NUM_BG_INDEX: u8 = 157;
const KCODER_DIFF_LIGHT_256_DELETED_NUM_BG_INDEX: u8 = 217;
const KCODER_DIFF_LIGHT_256_GUTTER_FG_INDEX: u8 = 236;

/// A full semantic theme for the TUI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UiTheme {
    pub name: &'static str,
    // Surface hierarchy
    pub surface_bg: Color,
    pub panel_bg: Color,
    pub elevated_bg: Color,
    pub composer_bg: Color,
    pub selection_bg: Color,
    pub header_bg: Color,
    pub footer_bg: Color,
    // Text hierarchy
    pub text_dim: Color,
    pub text_hint: Color,
    pub text_muted: Color,
    pub text_body: Color,
    pub text_soft: Color,
    pub border: Color,
    // Accent roles
    pub accent_primary: Color,
    pub accent_secondary: Color,
    pub accent_action: Color,
    // Error / destructive
    pub error_fg: Color,
    pub error_hover: Color,
    pub error_surface: Color,
    pub error_border: Color,
    pub error_text: Color,
    // Status roles
    pub warning: Color,
    pub success: Color,
    pub info: Color,
    // Mode badge colors
    pub mode_agent: Color,
    pub mode_yolo: Color,
    pub mode_plan: Color,
    // Footer statusline colors
    pub status_ready: Color,
    pub status_working: Color,
    pub status_warning: Color,
    // Diff colors
    pub diff_added_fg: Color,
    pub diff_deleted_fg: Color,
    pub diff_added_bg: Color,
    pub diff_deleted_bg: Color,
    // Tool cell colors
    pub tool_running: Color,
    pub tool_success: Color,
    pub tool_failed: Color,
    // Reasoning
    pub reasoning_text: Color,
    pub reasoning_surface: Color,
    pub reasoning_tint: Color,
}

/// Reusable semantic text styles for the TUI.
///
/// Color values belong to [`UiTheme`], while Markdown, transcript messages, and
/// tool summaries depend only on semantic roles. Body, muted text, and Markdown
/// details can then change without rebuilding `Style` independently in every renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UiTextStyles {
    pub body: Style,
    pub soft: Style,
    pub muted: Style,
    pub dim: Style,
    pub heading_h1: Style,
    pub heading_h2: Style,
    pub heading_h3: Style,
    pub heading_h4: Style,
    pub heading_h5: Style,
    pub heading_h6: Style,
    pub inline_code: Style,
    pub link: Style,
    pub unordered_list_marker: Style,
    pub ordered_list_marker: Style,
    pub task_unchecked: Style,
    pub task_checked: Style,
    pub blockquote: Style,
    pub blockquote_prefix: Style,
    pub rule: Style,
    pub table_header: Style,
    pub table_body: Style,
    pub table_separator: Style,
}

/// Tool calls use semantic layers: status emphasizes only its marker, titles remain
/// bold, and commands/results use syntax highlighting and muted text respectively.
/// Tool-family colors identify summaries and names without tinting entire outputs uniformly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UiToolStyles {
    pub running: Style,
    pub success: Style,
    pub failure: Style,
    pub diff: Style,
    pub title: Style,
    pub output: Style,
    pub output_preview: Style,
    pub path: Style,
    pub line_number: Style,
    pub summary_header: Style,
    pub summary_count: Style,
    pub summary_hint: Style,
    pub read: Style,
    pub patch: Style,
    pub run: Style,
    pub find: Style,
    pub mcp: Style,
    pub delegate: Style,
    pub generic: Style,
}

impl UiTheme {
    /// Return semantic styles shared by body text and Markdown details.
    pub(crate) fn text_styles(self) -> UiTextStyles {
        UiTextStyles {
            body: Style::default(),
            soft: Style::default().fg(self.text_soft),
            muted: Style::default().fg(self.text_muted),
            dim: Style::default().add_modifier(Modifier::DIM),
            heading_h1: Style::default()
                .add_modifier(ratatui::style::Modifier::BOLD)
                .add_modifier(ratatui::style::Modifier::UNDERLINED),
            heading_h2: Style::default().add_modifier(ratatui::style::Modifier::BOLD),
            heading_h3: Style::default()
                .add_modifier(ratatui::style::Modifier::BOLD)
                .add_modifier(ratatui::style::Modifier::ITALIC),
            heading_h4: Style::default().add_modifier(ratatui::style::Modifier::ITALIC),
            heading_h5: Style::default().add_modifier(ratatui::style::Modifier::ITALIC),
            heading_h6: Style::default().add_modifier(ratatui::style::Modifier::ITALIC),
            inline_code: Style::default().fg(Color::Cyan),
            link: Style::default()
                .fg(Color::Cyan)
                .add_modifier(ratatui::style::Modifier::UNDERLINED),
            unordered_list_marker: Style::default(),
            ordered_list_marker: Style::default().fg(Color::LightBlue),
            task_unchecked: Style::default(),
            task_checked: Style::default(),
            blockquote: Style::default().fg(Color::Green),
            blockquote_prefix: Style::default().fg(Color::Green),
            rule: Style::default(),
            table_header: Style::default().add_modifier(ratatui::style::Modifier::BOLD),
            table_body: Style::default(),
            table_separator: Style::default().add_modifier(Modifier::DIM),
        }
    }

    /// Return semantic styles shared across tool-call phases.
    pub(crate) fn tool_styles(self) -> UiToolStyles {
        UiToolStyles {
            running: Style::default()
                .fg(self.tool_running)
                .add_modifier(Modifier::BOLD),
            success: Style::default()
                .fg(self.success)
                .add_modifier(Modifier::BOLD),
            failure: Style::default()
                .fg(self.error_fg)
                .add_modifier(Modifier::BOLD),
            diff: Style::default()
                .fg(self.accent_primary)
                .add_modifier(Modifier::BOLD),
            title: Style::default().add_modifier(Modifier::BOLD),
            output: Style::default().add_modifier(Modifier::DIM),
            output_preview: Style::default().add_modifier(Modifier::DIM),
            path: Style::default().add_modifier(Modifier::DIM),
            line_number: Style::default().add_modifier(Modifier::DIM),
            summary_header: Style::default()
                .fg(self.accent_primary)
                .add_modifier(Modifier::BOLD),
            summary_count: Style::default().fg(self.text_soft),
            summary_hint: Style::default().add_modifier(Modifier::DIM),
            read: Style::default().fg(self.info),
            patch: Style::default().fg(self.accent_primary),
            run: Style::default().fg(self.warning),
            find: Style::default().fg(self.accent_secondary),
            mcp: Style::default().fg(self.accent_primary),
            delegate: Style::default().fg(self.mode_agent),
            generic: Style::default().add_modifier(Modifier::DIM),
        }
    }
}

const USER_SURFACE_DARK_ALPHA: f32 = 0.12;
const USER_SURFACE_LIGHT_ALPHA: f32 = 0.04;
const SELECTION_DARK_ALPHA: f32 = 0.18;
const SELECTION_LIGHT_ALPHA: f32 = 0.08;

fn blend_channel(base: u8, overlay: u8, alpha: f32) -> u8 {
    (base as f32 * (1.0 - alpha) + overlay as f32 * alpha).round() as u8
}

fn blend_rgb(base: (u8, u8, u8), overlay: (u8, u8, u8), alpha: f32) -> (u8, u8, u8) {
    (
        blend_channel(base.0, overlay.0, alpha),
        blend_channel(base.1, overlay.1, alpha),
        blend_channel(base.2, overlay.2, alpha),
    )
}

fn adaptive_surface_bg_for(
    terminal_bg: Option<(u8, u8, u8)>,
    dark_alpha: f32,
    light_alpha: f32,
) -> Option<Color> {
    terminal_bg.map(|background| {
        let (overlay, alpha) = if is_light_rgb(background) {
            ((0, 0, 0), light_alpha)
        } else {
            ((255, 255, 255), dark_alpha)
        };
        let (r, g, b) = blend_rgb(background, overlay, alpha);
        Color::Rgb(r, g, b)
    })
}

pub(crate) fn user_surface_bg_for(terminal_bg: Option<(u8, u8, u8)>) -> Option<Color> {
    adaptive_surface_bg_for(
        terminal_bg,
        USER_SURFACE_DARK_ALPHA,
        USER_SURFACE_LIGHT_ALPHA,
    )
}

pub(crate) fn selection_surface_bg_for(terminal_bg: Option<(u8, u8, u8)>) -> Option<Color> {
    adaptive_surface_bg_for(terminal_bg, SELECTION_DARK_ALPHA, SELECTION_LIGHT_ALPHA)
}

pub(crate) fn user_surface_style() -> Style {
    user_surface_bg_for(crate::terminal_palette::default_bg())
        .map_or_else(Style::default, |background| Style::default().bg(background))
}

pub(crate) fn user_surface_bg() -> Color {
    user_surface_bg_for(crate::terminal_palette::default_bg()).unwrap_or(Color::Reset)
}

pub(crate) fn selection_surface_bg() -> Color {
    selection_surface_bg_for(crate::terminal_palette::default_bg()).unwrap_or(Color::Reset)
}

macro_rules! rgb {
    ($rgb:expr) => {
        Color::Rgb($rgb.0, $rgb.1, $rgb.2)
    };
}

pub const KCODER_UI_THEME: UiTheme = UiTheme {
    name: "kcoder-dark",
    surface_bg: Color::Reset,
    panel_bg: Color::Reset,
    elevated_bg: Color::Reset,
    composer_bg: Color::Reset,
    selection_bg: Color::Reset,
    header_bg: Color::Reset,
    footer_bg: Color::Reset,
    text_dim: Color::DarkGray,
    text_hint: rgb!(KCODER_TEXT_HINT_RGB),
    text_muted: rgb!(KCODER_TEXT_MUTED_RGB),
    text_body: rgb!(KCODER_TEXT_BODY_RGB),
    text_soft: rgb!(KCODER_TEXT_SOFT_RGB),
    border: rgb!(KCODER_BORDER_RGB),
    accent_primary: Color::Cyan,
    accent_secondary: rgb!(KCODER_ACCENT_SECONDARY_RGB),
    accent_action: rgb!(KCODER_ACCENT_ACTION_RGB),
    error_fg: Color::Red,
    error_hover: Color::LightRed,
    error_surface: rgb!(KCODER_ERROR_SURFACE_RGB),
    error_border: Color::Red,
    error_text: Color::LightRed,
    warning: Color::Yellow,
    success: Color::Green,
    info: Color::Cyan,
    mode_agent: Color::Cyan,
    mode_yolo: Color::Red,
    mode_plan: Color::Yellow,
    status_ready: rgb!(KCODER_TEXT_MUTED_RGB),
    status_working: Color::Cyan,
    status_warning: Color::Yellow,
    diff_added_fg: Color::Green,
    diff_deleted_fg: Color::Red,
    diff_added_bg: rgb!(KCODER_DIFF_ADDED_BG_RGB),
    diff_deleted_bg: rgb!(KCODER_DIFF_DELETED_BG_RGB),
    tool_running: Color::Cyan,
    tool_success: Color::Green,
    tool_failed: Color::Red,
    reasoning_text: rgb!(KCODER_REASONING_TEXT_RGB),
    reasoning_surface: rgb!(KCODER_REASONING_SURFACE_RGB),
    reasoning_tint: rgb!(KCODER_REASONING_TINT_RGB),
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiffTheme {
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiffColorLevel {
    TrueColor,
    Ansi256,
    Ansi16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiffLineKind {
    Insert,
    Delete,
    Context,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RichDiffColorLevel {
    TrueColor,
    Ansi256,
}

impl RichDiffColorLevel {
    fn from_diff_color_level(level: DiffColorLevel) -> Option<Self> {
        match level {
            DiffColorLevel::TrueColor => Some(Self::TrueColor),
            DiffColorLevel::Ansi256 => Some(Self::Ansi256),
            DiffColorLevel::Ansi16 => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct DiffScopeBackgroundRgbs {
    pub inserted: Option<(u8, u8, u8)>,
    pub deleted: Option<(u8, u8, u8)>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ResolvedDiffBackgrounds {
    pub add: Option<Color>,
    pub del: Option<Color>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DiffStyleContext {
    pub theme: DiffTheme,
    pub color_level: DiffColorLevel,
    pub backgrounds: ResolvedDiffBackgrounds,
}

impl DiffStyleContext {
    pub(crate) fn current() -> Self {
        Self::for_theme(diff_theme_for_bg(crate::terminal_palette::default_bg()))
    }

    pub(crate) fn current_dark() -> Self {
        Self::for_theme(DiffTheme::Dark)
    }

    pub(crate) fn for_theme(theme: DiffTheme) -> Self {
        Self::for_theme_and_color_level(theme, current_diff_color_level())
    }

    pub(crate) fn for_theme_and_color_level(theme: DiffTheme, color_level: DiffColorLevel) -> Self {
        Self {
            theme,
            color_level,
            backgrounds: resolve_diff_backgrounds_for(
                theme,
                color_level,
                DiffScopeBackgroundRgbs::default(),
            ),
        }
    }
}

pub(crate) fn diff_theme_for_bg(bg: Option<(u8, u8, u8)>) -> DiffTheme {
    if bg.is_some_and(is_light_rgb) {
        DiffTheme::Light
    } else {
        DiffTheme::Dark
    }
}

pub(crate) fn current_diff_color_level() -> DiffColorLevel {
    static LEVEL: OnceLock<DiffColorLevel> = OnceLock::new();
    *LEVEL.get_or_init(|| {
        diff_color_level_from_env(
            std::env::var("KCODER_DIFF_COLOR_LEVEL").ok().as_deref(),
            std::env::var("COLORTERM").ok().as_deref(),
            std::env::var("TERM").ok().as_deref(),
        )
    })
}

pub(crate) fn diff_color_level_from_env(
    override_value: Option<&str>,
    colorterm: Option<&str>,
    term: Option<&str>,
) -> DiffColorLevel {
    if let Some(value) = override_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match value.to_ascii_lowercase().as_str() {
            "ansi16" | "16" => return DiffColorLevel::Ansi16,
            "ansi256" | "256" => return DiffColorLevel::Ansi256,
            "truecolor" | "24bit" | "rgb" => return DiffColorLevel::TrueColor,
            _ => {}
        }
    }

    if colorterm.is_some_and(|value| {
        let value = value.to_ascii_lowercase();
        value.contains("truecolor") || value.contains("24bit")
    }) {
        return DiffColorLevel::TrueColor;
    }

    if term.is_some_and(|value| {
        let value = value.to_ascii_lowercase();
        value.contains("truecolor") || value.contains("direct")
    }) {
        return DiffColorLevel::TrueColor;
    }

    if term.is_some_and(|value| value.to_ascii_lowercase().contains("256color")) {
        return DiffColorLevel::Ansi256;
    }

    DiffColorLevel::TrueColor
}

pub(crate) fn resolve_diff_backgrounds_for(
    theme: DiffTheme,
    color_level: DiffColorLevel,
    scope_backgrounds: DiffScopeBackgroundRgbs,
) -> ResolvedDiffBackgrounds {
    let mut resolved = fallback_diff_backgrounds(theme, color_level);
    let Some(level) = RichDiffColorLevel::from_diff_color_level(color_level) else {
        return resolved;
    };

    if let Some(rgb) = scope_backgrounds.inserted {
        resolved.add = Some(color_from_rgb_for_rich_level(rgb, level));
    }
    if let Some(rgb) = scope_backgrounds.deleted {
        resolved.del = Some(color_from_rgb_for_rich_level(rgb, level));
    }
    resolved
}

pub(crate) fn fallback_diff_backgrounds(
    theme: DiffTheme,
    color_level: DiffColorLevel,
) -> ResolvedDiffBackgrounds {
    match RichDiffColorLevel::from_diff_color_level(color_level) {
        Some(level) => ResolvedDiffBackgrounds {
            add: Some(diff_add_line_bg(theme, level)),
            del: Some(diff_del_line_bg(theme, level)),
        },
        None => ResolvedDiffBackgrounds::default(),
    }
}

pub(crate) fn diff_added_style(context: DiffStyleContext) -> Style {
    diff_change_style(
        Color::Green,
        context.theme,
        context.color_level,
        context.backgrounds.add,
    )
}

pub(crate) fn diff_deleted_style(context: DiffStyleContext) -> Style {
    diff_change_style(
        Color::Red,
        context.theme,
        context.color_level,
        context.backgrounds.del,
    )
}

pub(crate) fn diff_line_background_style(
    kind: DiffLineKind,
    backgrounds: ResolvedDiffBackgrounds,
) -> Style {
    match kind {
        DiffLineKind::Insert => backgrounds
            .add
            .map_or_else(Style::default, |bg| Style::default().bg(bg)),
        DiffLineKind::Delete => backgrounds
            .del
            .map_or_else(Style::default, |bg| Style::default().bg(bg)),
        DiffLineKind::Context => Style::default(),
    }
}

pub(crate) fn diff_gutter_style(
    kind: DiffLineKind,
    theme: DiffTheme,
    color_level: DiffColorLevel,
) -> Style {
    match (
        theme,
        kind,
        RichDiffColorLevel::from_diff_color_level(color_level),
    ) {
        (DiffTheme::Light, DiffLineKind::Insert, None)
        | (DiffTheme::Light, DiffLineKind::Delete, None) => {
            Style::default().fg(light_diff_gutter_fg(color_level))
        }
        (DiffTheme::Light, DiffLineKind::Insert, Some(level)) => Style::default()
            .fg(light_diff_gutter_fg(color_level))
            .bg(light_diff_add_num_bg(level)),
        (DiffTheme::Light, DiffLineKind::Delete, Some(level)) => Style::default()
            .fg(light_diff_gutter_fg(color_level))
            .bg(light_diff_del_num_bg(level)),
        _ => diff_gutter_dim_style(),
    }
}

pub(crate) fn diff_gutter_dim_style() -> Style {
    Style::default().add_modifier(ratatui::style::Modifier::DIM)
}

fn diff_change_style(
    foreground: Color,
    theme: DiffTheme,
    color_level: DiffColorLevel,
    background: Option<Color>,
) -> Style {
    match (theme, color_level, background) {
        (_, DiffColorLevel::Ansi16, _) => Style::default().fg(foreground),
        (DiffTheme::Light, DiffColorLevel::TrueColor | DiffColorLevel::Ansi256, Some(bg)) => {
            Style::default().bg(bg)
        }
        (DiffTheme::Dark, DiffColorLevel::TrueColor | DiffColorLevel::Ansi256, Some(bg)) => {
            Style::default().fg(foreground).bg(bg)
        }
        (DiffTheme::Light, DiffColorLevel::TrueColor | DiffColorLevel::Ansi256, None) => {
            Style::default()
        }
        (DiffTheme::Dark, DiffColorLevel::TrueColor | DiffColorLevel::Ansi256, None) => {
            Style::default().fg(foreground)
        }
    }
}

fn diff_add_line_bg(theme: DiffTheme, color_level: RichDiffColorLevel) -> Color {
    match (theme, color_level) {
        (DiffTheme::Dark, RichDiffColorLevel::TrueColor) => rgb_color(KCODER_DIFF_ADDED_BG_RGB),
        (DiffTheme::Dark, RichDiffColorLevel::Ansi256) => {
            indexed_color(KCODER_DIFF_DARK_256_ADDED_BG_INDEX)
        }
        (DiffTheme::Light, RichDiffColorLevel::TrueColor) => {
            rgb_color(KCODER_DIFF_LIGHT_ADDED_BG_RGB)
        }
        (DiffTheme::Light, RichDiffColorLevel::Ansi256) => {
            indexed_color(KCODER_DIFF_LIGHT_256_ADDED_BG_INDEX)
        }
    }
}

fn diff_del_line_bg(theme: DiffTheme, color_level: RichDiffColorLevel) -> Color {
    match (theme, color_level) {
        (DiffTheme::Dark, RichDiffColorLevel::TrueColor) => rgb_color(KCODER_DIFF_DELETED_BG_RGB),
        (DiffTheme::Dark, RichDiffColorLevel::Ansi256) => {
            indexed_color(KCODER_DIFF_DARK_256_DELETED_BG_INDEX)
        }
        (DiffTheme::Light, RichDiffColorLevel::TrueColor) => {
            rgb_color(KCODER_DIFF_LIGHT_DELETED_BG_RGB)
        }
        (DiffTheme::Light, RichDiffColorLevel::Ansi256) => {
            indexed_color(KCODER_DIFF_LIGHT_256_DELETED_BG_INDEX)
        }
    }
}

fn light_diff_gutter_fg(color_level: DiffColorLevel) -> Color {
    match color_level {
        DiffColorLevel::TrueColor => rgb_color(KCODER_DIFF_LIGHT_GUTTER_FG_RGB),
        DiffColorLevel::Ansi256 => indexed_color(KCODER_DIFF_LIGHT_256_GUTTER_FG_INDEX),
        DiffColorLevel::Ansi16 => Color::Black,
    }
}

fn light_diff_add_num_bg(color_level: RichDiffColorLevel) -> Color {
    match color_level {
        RichDiffColorLevel::TrueColor => rgb_color(KCODER_DIFF_LIGHT_ADDED_NUM_BG_RGB),
        RichDiffColorLevel::Ansi256 => indexed_color(KCODER_DIFF_LIGHT_256_ADDED_NUM_BG_INDEX),
    }
}

fn light_diff_del_num_bg(color_level: RichDiffColorLevel) -> Color {
    match color_level {
        RichDiffColorLevel::TrueColor => rgb_color(KCODER_DIFF_LIGHT_DELETED_NUM_BG_RGB),
        RichDiffColorLevel::Ansi256 => indexed_color(KCODER_DIFF_LIGHT_256_DELETED_NUM_BG_INDEX),
    }
}

fn color_from_rgb_for_rich_level(rgb: (u8, u8, u8), color_level: RichDiffColorLevel) -> Color {
    match color_level {
        RichDiffColorLevel::TrueColor => rgb_color(rgb),
        RichDiffColorLevel::Ansi256 => quantize_rgb_to_ansi256(rgb),
    }
}

fn quantize_rgb_to_ansi256((r, g, b): (u8, u8, u8)) -> Color {
    fn component_to_ansi_cube(value: u8) -> u8 {
        if value < 48 {
            0
        } else if value < 114 {
            1
        } else {
            ((value.saturating_sub(35) as u16) / 40).min(5) as u8
        }
    }

    let r = component_to_ansi_cube(r);
    let g = component_to_ansi_cube(g);
    let b = component_to_ansi_cube(b);
    indexed_color(16 + 36 * r + 6 * g + b)
}

fn rgb_color((r, g, b): (u8, u8, u8)) -> Color {
    Color::Rgb(r, g, b)
}

fn indexed_color(index: u8) -> Color {
    Color::Indexed(index)
}

fn is_light_rgb((r, g, b): (u8, u8, u8)) -> bool {
    let luminance = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
    luminance > 128.0
}

/// Legacy helpers kept for easy migration of old code.
pub const TEXT_PRIMARY: Color = KCODER_UI_THEME.text_body;
pub const TEXT_MUTED: Color = KCODER_UI_THEME.text_muted;
pub const TEXT_DIM: Color = KCODER_UI_THEME.text_dim;
pub const TEXT_HINT: Color = KCODER_UI_THEME.text_hint;
pub const TEXT_SOFT: Color = KCODER_UI_THEME.text_soft;
pub const TEXT_ACCENT: Color = KCODER_UI_THEME.accent_secondary;
pub const BORDER_COLOR: Color = KCODER_UI_THEME.border;
pub const ACCENT_PRIMARY: Color = KCODER_UI_THEME.accent_primary;
pub const ACCENT_SECONDARY: Color = KCODER_UI_THEME.accent_secondary;
pub const STATUS_SUCCESS: Color = KCODER_UI_THEME.success;
pub const STATUS_WARNING: Color = KCODER_UI_THEME.warning;
pub const STATUS_ERROR: Color = KCODER_UI_THEME.error_fg;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_has_expected_name() {
        assert_eq!(KCODER_UI_THEME.name, "kcoder-dark");
    }

    #[test]
    fn theme_uses_kcoder_brand_colors() {
        assert_eq!(KCODER_UI_THEME.surface_bg, Color::Reset);
        assert_eq!(KCODER_UI_THEME.panel_bg, Color::Reset);
        assert_eq!(KCODER_UI_THEME.composer_bg, Color::Reset);
        assert_eq!(KCODER_UI_THEME.accent_primary, Color::Cyan);
        assert_eq!(KCODER_UI_THEME.accent_secondary, Color::Rgb(180, 180, 180));
    }

    #[test]
    fn adaptive_surfaces_use_dark_and_light_blends() {
        assert_eq!(user_surface_bg_for(None), None);
        assert_eq!(
            user_surface_bg_for(Some((0, 0, 0))),
            Some(Color::Rgb(31, 31, 31))
        );
        assert_eq!(
            user_surface_bg_for(Some((255, 255, 255))),
            Some(Color::Rgb(245, 245, 245))
        );
        assert_eq!(
            selection_surface_bg_for(Some((0, 0, 0))),
            Some(Color::Rgb(46, 46, 46))
        );
        assert_eq!(selection_surface_bg_for(None), None);
    }

    #[test]
    fn theme_text_hierarchy_is_consistent() {
        // Body should be the brightest, dim the darkest.
        let body = KCODER_UI_THEME.text_body;
        let soft = KCODER_UI_THEME.text_soft;
        let muted = KCODER_UI_THEME.text_muted;
        let dim = KCODER_UI_THEME.text_dim;
        assert_ne!(body, soft);
        assert_ne!(soft, muted);
        assert_ne!(muted, dim);
    }

    #[test]
    fn semantic_text_styles_follow_theme_roles() {
        let styles = KCODER_UI_THEME.text_styles();
        assert_eq!(styles.body, Style::default());
        assert_eq!(styles.soft.fg, Some(KCODER_UI_THEME.text_soft));
        assert_eq!(styles.muted.fg, Some(KCODER_UI_THEME.text_muted));
        assert_eq!(styles.dim.fg, None);
        assert!(styles.dim.add_modifier.contains(Modifier::DIM));
        assert_eq!(styles.inline_code.fg, Some(KCODER_UI_THEME.accent_primary));
    }

    #[test]
    fn markdown_semantics_use_expected_styles() {
        let styles = KCODER_UI_THEME.text_styles();
        assert_eq!(styles.body, Style::default());
        assert_eq!(
            styles.heading_h1,
            Style::default()
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::UNDERLINED)
        );
        assert_eq!(
            styles.heading_h2,
            Style::default().add_modifier(Modifier::BOLD)
        );
        assert_eq!(
            styles.heading_h3,
            Style::default()
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::ITALIC)
        );
        for heading in [styles.heading_h4, styles.heading_h5, styles.heading_h6] {
            assert_eq!(heading, Style::default().add_modifier(Modifier::ITALIC));
        }
        assert_eq!(styles.inline_code, Style::default().fg(Color::Cyan));
        assert_eq!(
            styles.link,
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::UNDERLINED)
        );
        assert_eq!(styles.unordered_list_marker, Style::default());
        assert_eq!(
            styles.ordered_list_marker,
            Style::default().fg(Color::LightBlue)
        );
        assert_eq!(styles.task_unchecked, Style::default());
        assert_eq!(styles.task_checked, Style::default());
        assert_eq!(styles.blockquote, Style::default().fg(Color::Green));
        assert_eq!(styles.blockquote_prefix, styles.blockquote);
        assert_eq!(styles.rule, Style::default());
        assert!(styles.table_header.add_modifier.contains(Modifier::BOLD));
        assert!(styles.table_separator.add_modifier.contains(Modifier::DIM));
    }

    #[test]
    fn tool_styles_keep_status_and_content_roles_separate() {
        let styles = KCODER_UI_THEME.tool_styles();
        assert_eq!(styles.running.fg, Some(KCODER_UI_THEME.tool_running));
        assert_eq!(styles.success.fg, Some(KCODER_UI_THEME.success));
        assert_eq!(styles.failure.fg, Some(KCODER_UI_THEME.error_fg));
        assert_eq!(styles.title.fg, None);
        assert_eq!(styles.output.fg, None);
        assert!(styles.output.add_modifier.contains(Modifier::DIM));
        assert_eq!(
            styles.summary_header.fg,
            Some(KCODER_UI_THEME.accent_primary)
        );
        assert_eq!(styles.mcp.fg, Some(KCODER_UI_THEME.accent_primary));
    }

    #[test]
    fn legacy_color_helpers_match_theme() {
        assert_eq!(TEXT_PRIMARY, KCODER_UI_THEME.text_body);
        assert_eq!(ACCENT_PRIMARY, KCODER_UI_THEME.accent_primary);
        assert_eq!(ACCENT_SECONDARY, KCODER_UI_THEME.accent_secondary);
        assert_eq!(STATUS_SUCCESS, KCODER_UI_THEME.success);
        assert_eq!(STATUS_ERROR, KCODER_UI_THEME.error_fg);
    }

    #[test]
    fn diff_palette_matches_dark_truecolor_defaults() {
        assert_eq!(KCODER_UI_THEME.diff_added_fg, Color::Green);
        assert_eq!(KCODER_UI_THEME.diff_deleted_fg, Color::Red);
        assert_eq!(KCODER_UI_THEME.diff_added_bg, Color::Rgb(33, 58, 43));
        assert_eq!(KCODER_UI_THEME.diff_deleted_bg, Color::Rgb(74, 34, 29));
    }

    #[test]
    fn diff_theme_for_background_matches_lightness_policy() {
        assert_eq!(diff_theme_for_bg(None), DiffTheme::Dark);
        assert_eq!(diff_theme_for_bg(Some((17, 17, 17))), DiffTheme::Dark);
        assert_eq!(diff_theme_for_bg(Some((240, 240, 240))), DiffTheme::Light);
    }

    #[test]
    fn diff_style_context_for_theme_resolves_matching_backgrounds() {
        let dark =
            DiffStyleContext::for_theme_and_color_level(DiffTheme::Dark, DiffColorLevel::TrueColor);
        assert_eq!(dark.theme, DiffTheme::Dark);
        assert_eq!(dark.backgrounds.add, Some(Color::Rgb(33, 58, 43)));

        let light = DiffStyleContext::for_theme_and_color_level(
            DiffTheme::Light,
            DiffColorLevel::TrueColor,
        );
        assert_eq!(light.theme, DiffTheme::Light);
        assert_eq!(light.backgrounds.add, Some(Color::Rgb(218, 251, 225)));
    }

    #[test]
    fn diff_ansi16_styles_use_foreground_only_fallback() {
        let context = DiffStyleContext {
            theme: DiffTheme::Dark,
            color_level: DiffColorLevel::Ansi16,
            backgrounds: fallback_diff_backgrounds(DiffTheme::Dark, DiffColorLevel::Ansi16),
        };

        let added = diff_added_style(context);
        assert_eq!(added.fg, Some(Color::Green));
        assert_eq!(added.bg, None);

        let deleted = diff_deleted_style(context);
        assert_eq!(deleted.fg, Some(Color::Red));
        assert_eq!(deleted.bg, None);
    }

    #[test]
    fn diff_ansi256_dark_backgrounds_are_distinct() {
        let backgrounds = fallback_diff_backgrounds(DiffTheme::Dark, DiffColorLevel::Ansi256);

        assert_eq!(
            backgrounds.add,
            Some(Color::Indexed(KCODER_DIFF_DARK_256_ADDED_BG_INDEX))
        );
        assert_eq!(
            backgrounds.del,
            Some(Color::Indexed(KCODER_DIFF_DARK_256_DELETED_BG_INDEX))
        );
        assert_ne!(backgrounds.add, backgrounds.del);
    }

    #[test]
    fn diff_line_background_styles_use_dark_truecolor_defaults() {
        let backgrounds = fallback_diff_backgrounds(DiffTheme::Dark, DiffColorLevel::TrueColor);

        assert_eq!(
            diff_line_background_style(DiffLineKind::Insert, backgrounds),
            Style::default().bg(Color::Rgb(33, 58, 43))
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Delete, backgrounds),
            Style::default().bg(Color::Rgb(74, 34, 29))
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Context, backgrounds),
            Style::default()
        );
        assert_eq!(
            diff_gutter_style(
                DiffLineKind::Insert,
                DiffTheme::Dark,
                DiffColorLevel::TrueColor
            ),
            diff_gutter_dim_style()
        );
        assert_eq!(
            diff_gutter_style(
                DiffLineKind::Delete,
                DiffTheme::Dark,
                DiffColorLevel::TrueColor
            ),
            diff_gutter_dim_style()
        );
    }

    #[test]
    fn diff_line_background_styles_use_dark_ansi256_defaults() {
        let backgrounds = fallback_diff_backgrounds(DiffTheme::Dark, DiffColorLevel::Ansi256);

        assert_eq!(
            diff_line_background_style(DiffLineKind::Insert, backgrounds),
            Style::default().bg(Color::Indexed(KCODER_DIFF_DARK_256_ADDED_BG_INDEX))
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Delete, backgrounds),
            Style::default().bg(Color::Indexed(KCODER_DIFF_DARK_256_DELETED_BG_INDEX))
        );
        assert_ne!(
            diff_line_background_style(DiffLineKind::Insert, backgrounds),
            diff_line_background_style(DiffLineKind::Delete, backgrounds)
        );
    }

    #[test]
    fn diff_theme_scope_backgrounds_override_truecolor_fallback() {
        let backgrounds = resolve_diff_backgrounds_for(
            DiffTheme::Dark,
            DiffColorLevel::TrueColor,
            DiffScopeBackgroundRgbs {
                inserted: Some((12, 34, 56)),
                deleted: None,
            },
        );

        assert_eq!(backgrounds.add, Some(Color::Rgb(12, 34, 56)));
        assert_eq!(backgrounds.del, Some(Color::Rgb(74, 34, 29)));
        assert_eq!(
            diff_line_background_style(DiffLineKind::Insert, backgrounds),
            Style::default().bg(Color::Rgb(12, 34, 56))
        );
    }

    #[test]
    fn diff_theme_scope_backgrounds_quantize_to_ansi256() {
        let backgrounds = resolve_diff_backgrounds_for(
            DiffTheme::Dark,
            DiffColorLevel::Ansi256,
            DiffScopeBackgroundRgbs {
                inserted: Some((0, 95, 0)),
                deleted: None,
            },
        );

        assert_eq!(backgrounds.add, Some(Color::Indexed(22)));
        assert_eq!(
            backgrounds.del,
            Some(Color::Indexed(KCODER_DIFF_DARK_256_DELETED_BG_INDEX))
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Insert, backgrounds),
            Style::default().bg(Color::Indexed(22))
        );
    }

    #[test]
    fn diff_color_level_env_override_matches_fallback_modes() {
        assert_eq!(
            diff_color_level_from_env(Some("ansi16"), Some("truecolor"), Some("xterm-256color")),
            DiffColorLevel::Ansi16
        );
        assert_eq!(
            diff_color_level_from_env(None, None, Some("xterm-256color")),
            DiffColorLevel::Ansi256
        );
        assert_eq!(
            diff_color_level_from_env(None, Some("truecolor"), Some("xterm")),
            DiffColorLevel::TrueColor
        );
    }

    #[test]
    fn diff_ansi16_disables_line_backgrounds_and_uses_foreground_only() {
        let dark_backgrounds = fallback_diff_backgrounds(DiffTheme::Dark, DiffColorLevel::Ansi16);
        let light_backgrounds = fallback_diff_backgrounds(DiffTheme::Light, DiffColorLevel::Ansi16);

        assert_eq!(dark_backgrounds, ResolvedDiffBackgrounds::default());
        assert_eq!(light_backgrounds, ResolvedDiffBackgrounds::default());
        assert_eq!(
            diff_line_background_style(DiffLineKind::Insert, dark_backgrounds),
            Style::default()
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Delete, light_backgrounds),
            Style::default()
        );
        assert_eq!(
            diff_gutter_style(
                DiffLineKind::Insert,
                DiffTheme::Light,
                DiffColorLevel::Ansi16
            ),
            Style::default().fg(Color::Black)
        );
        assert_eq!(
            diff_gutter_style(
                DiffLineKind::Delete,
                DiffTheme::Light,
                DiffColorLevel::Ansi16
            ),
            Style::default().fg(Color::Black)
        );

        let themed_backgrounds = resolve_diff_backgrounds_for(
            DiffTheme::Light,
            DiffColorLevel::Ansi16,
            DiffScopeBackgroundRgbs {
                inserted: Some((8, 9, 10)),
                deleted: Some((11, 12, 13)),
            },
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Insert, themed_backgrounds),
            Style::default()
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Delete, themed_backgrounds),
            Style::default()
        );
    }

    #[test]
    fn diff_light_truecolor_uses_codex_line_and_gutter_backgrounds() {
        let backgrounds = fallback_diff_backgrounds(DiffTheme::Light, DiffColorLevel::TrueColor);

        assert_eq!(
            diff_line_background_style(DiffLineKind::Insert, backgrounds),
            Style::default().bg(Color::Rgb(218, 251, 225))
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Delete, backgrounds),
            Style::default().bg(Color::Rgb(255, 235, 233))
        );
        assert_eq!(
            diff_gutter_style(
                DiffLineKind::Insert,
                DiffTheme::Light,
                DiffColorLevel::TrueColor
            ),
            Style::default()
                .fg(Color::Rgb(31, 35, 40))
                .bg(Color::Rgb(172, 238, 187))
        );
        assert_eq!(
            diff_gutter_style(
                DiffLineKind::Delete,
                DiffTheme::Light,
                DiffColorLevel::TrueColor
            ),
            Style::default()
                .fg(Color::Rgb(31, 35, 40))
                .bg(Color::Rgb(255, 206, 203))
        );
    }

    #[test]
    fn diff_light_ansi256_uses_codex_indexed_line_and_gutter_backgrounds() {
        let backgrounds = fallback_diff_backgrounds(DiffTheme::Light, DiffColorLevel::Ansi256);

        assert_eq!(
            diff_line_background_style(DiffLineKind::Insert, backgrounds),
            Style::default().bg(Color::Indexed(KCODER_DIFF_LIGHT_256_ADDED_BG_INDEX))
        );
        assert_eq!(
            diff_line_background_style(DiffLineKind::Delete, backgrounds),
            Style::default().bg(Color::Indexed(KCODER_DIFF_LIGHT_256_DELETED_BG_INDEX))
        );
        assert_eq!(
            diff_gutter_style(
                DiffLineKind::Insert,
                DiffTheme::Light,
                DiffColorLevel::Ansi256
            ),
            Style::default()
                .fg(Color::Indexed(KCODER_DIFF_LIGHT_256_GUTTER_FG_INDEX))
                .bg(Color::Indexed(KCODER_DIFF_LIGHT_256_ADDED_NUM_BG_INDEX))
        );
        assert_eq!(
            diff_gutter_style(
                DiffLineKind::Delete,
                DiffTheme::Light,
                DiffColorLevel::Ansi256
            ),
            Style::default()
                .fg(Color::Indexed(KCODER_DIFF_LIGHT_256_GUTTER_FG_INDEX))
                .bg(Color::Indexed(KCODER_DIFF_LIGHT_256_DELETED_NUM_BG_INDEX))
        );
    }
}
