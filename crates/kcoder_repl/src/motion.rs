//! Centralized motion primitives for the TUI.
//!
//! Widgets choose animated or reduced motion here instead of hand-rolling
//! activity markers or loading text styles.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::Span;

pub(crate) const SPINNER_FRAME_INTERVAL: Duration = Duration::from_millis(80);
#[cfg(not(windows))]
const SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
#[cfg(windows)]
const SPINNER_FRAMES: [&str; 10] = ["|", "/", "-", "\\", "|", "/", "-", "\\", "|", "/"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MotionMode {
    Animated,
    Reduced,
}

impl MotionMode {
    pub(crate) fn from_animations_enabled(animations_enabled: bool) -> Self {
        if animations_enabled {
            Self::Animated
        } else {
            Self::Reduced
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReducedMotionIndicator {
    Hidden,
    #[allow(dead_code)] // Reserved for history and execution cells.
    StaticBullet,
}

pub(crate) fn activity_indicator(
    start_time: Option<Instant>,
    motion_mode: MotionMode,
    reduced_motion_indicator: ReducedMotionIndicator,
) -> Option<Span<'static>> {
    match motion_mode {
        MotionMode::Animated => Some(animated_activity_indicator(start_time)),
        MotionMode::Reduced => match reduced_motion_indicator {
            ReducedMotionIndicator::Hidden => None,
            ReducedMotionIndicator::StaticBullet => {
                Some(if cfg!(windows) { "*" } else { "•" }.dim())
            }
        },
    }
}

pub(crate) fn shimmer_text(text: &str, motion_mode: MotionMode) -> Vec<Span<'static>> {
    match motion_mode {
        MotionMode::Animated => shimmer_spans(text),
        MotionMode::Reduced => {
            if text.is_empty() {
                Vec::new()
            } else {
                vec![text.to_string().into()]
            }
        }
    }
}

fn animated_activity_indicator(start_time: Option<Instant>) -> Span<'static> {
    let elapsed = start_time.map(|st| st.elapsed()).unwrap_or_default();
    spinner_frame(elapsed).to_string().into()
}

pub(crate) fn spinner_frame(elapsed: Duration) -> &'static str {
    let interval_ms = SPINNER_FRAME_INTERVAL.as_millis().max(1);
    let index = (elapsed.as_millis() / interval_ms) as usize % SPINNER_FRAMES.len();
    SPINNER_FRAMES[index]
}

pub(crate) fn tool_summary_frame(elapsed: Duration) -> &'static str {
    #[cfg(not(windows))]
    const FRAMES: [&str; 4] = ["◇", "◈", "◆", "◈"];
    #[cfg(windows)]
    const FRAMES: [&str; 4] = ["o", "O", "o", "O"];
    let index = (elapsed.as_millis() / 240) as usize % FRAMES.len();
    FRAMES[index]
}

fn shimmer_spans(text: &str) -> Vec<Span<'static>> {
    shimmer_spans_for(
        text,
        elapsed_since_process_start(),
        stdout_supports_truecolor(),
    )
}

fn shimmer_spans_for(text: &str, elapsed: Duration, has_truecolor: bool) -> Vec<Span<'static>> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    let len = chars.len();
    let base_color = (128, 128, 128);
    let highlight_color = (255, 255, 255);
    chars
        .into_iter()
        .enumerate()
        .map(|(idx, ch)| {
            let intensity = shimmer_intensity(idx, len, elapsed);
            let style = if has_truecolor {
                let (r, g, b) = blend_rgb(highlight_color, base_color, intensity * 0.9);
                Style::default()
                    .fg(Color::Rgb(r, g, b))
                    .add_modifier(Modifier::BOLD)
            } else {
                style_for_shimmer_intensity(intensity)
            };
            Span::styled(ch.to_string(), style)
        })
        .collect()
}

fn elapsed_since_process_start() -> Duration {
    static PROCESS_START: OnceLock<Instant> = OnceLock::new();
    PROCESS_START.get_or_init(Instant::now).elapsed()
}

fn shimmer_intensity(index: usize, len: usize, elapsed: Duration) -> f32 {
    let padding = 10usize;
    let period = len.saturating_add(padding.saturating_mul(2)).max(1);
    let sweep_seconds = 2.0f32;
    let pos = ((elapsed.as_secs_f32() % sweep_seconds) / sweep_seconds * period as f32) as isize;
    let char_pos = index as isize + padding as isize;
    let dist = (char_pos - pos).abs() as f32;
    let band_half_width = 5.0;
    if dist > band_half_width {
        return 0.0;
    }
    let x = std::f32::consts::PI * (dist / band_half_width);
    (0.5 * (1.0 + x.cos())).clamp(0.0, 1.0)
}

fn style_for_shimmer_intensity(intensity: f32) -> Style {
    if intensity < 0.2 {
        Style::default().add_modifier(Modifier::DIM)
    } else if intensity < 0.6 {
        Style::default()
    } else {
        Style::default().add_modifier(Modifier::BOLD)
    }
}

fn blend_rgb(fg: (u8, u8, u8), bg: (u8, u8, u8), alpha: f32) -> (u8, u8, u8) {
    let alpha = alpha.clamp(0.0, 1.0);
    let r = (fg.0 as f32 * alpha + bg.0 as f32 * (1.0 - alpha)) as u8;
    let g = (fg.1 as f32 * alpha + bg.1 as f32 * (1.0 - alpha)) as u8;
    let b = (fg.2 as f32 * alpha + bg.2 as f32 * (1.0 - alpha)) as u8;
    (r, g, b)
}

fn stdout_supports_truecolor() -> bool {
    static SUPPORTS_TRUECOLOR: OnceLock<bool> = OnceLock::new();
    *SUPPORTS_TRUECOLOR.get_or_init(|| {
        truecolor_supported_from_env(
            std::env::var("COLORTERM").ok().as_deref(),
            std::env::var("TERM").ok().as_deref(),
            std::env::var("TERM_PROGRAM").ok().as_deref(),
            std::env::var("FORCE_COLOR").ok().as_deref(),
        )
    })
}

fn truecolor_supported_from_env(
    colorterm: Option<&str>,
    term: Option<&str>,
    term_program: Option<&str>,
    force_color: Option<&str>,
) -> bool {
    if force_color.is_some_and(|value| value != "0") {
        return true;
    }
    colorterm.is_some_and(|value| {
        let value = value.to_ascii_lowercase();
        value.contains("truecolor") || value.contains("24bit")
    }) || term.is_some_and(|value| {
        let value = value.to_ascii_lowercase();
        value.contains("truecolor") || value.contains("direct")
    }) || term_program.is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "iterm.app" | "wezterm" | "vscode"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduced_motion_activity_indicator_uses_explicit_fallback() {
        assert_eq!(
            activity_indicator(None, MotionMode::Reduced, ReducedMotionIndicator::Hidden),
            None
        );
        assert_eq!(
            activity_indicator(
                None,
                MotionMode::Reduced,
                ReducedMotionIndicator::StaticBullet
            ),
            Some(if cfg!(windows) { "*" } else { "•" }.dim())
        );
    }

    #[test]
    fn reduced_motion_shimmer_text_is_plain_text() {
        assert_eq!(
            shimmer_text("Loading", MotionMode::Reduced),
            vec!["Loading".into()]
        );
        assert_eq!(
            shimmer_text("", MotionMode::Reduced),
            Vec::<Span<'static>>::new()
        );
    }

    #[test]
    fn animated_shimmer_preserves_text_content() {
        let rendered = shimmer_text("Work", MotionMode::Animated)
            .into_iter()
            .map(|span| span.content.into_owned())
            .collect::<String>();

        assert_eq!(rendered, "Work");
    }

    #[test]
    fn shimmer_sweeps_single_glyph() {
        let dim = shimmer_spans_for("•", Duration::from_secs(0), false)
            .pop()
            .expect("single glyph should render");
        let bright = shimmer_spans_for("•", Duration::from_secs(1), false)
            .pop()
            .expect("single glyph should render");

        assert!(dim.style.add_modifier.contains(Modifier::DIM));
        assert!(bright.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn spinner_uses_braille_frames_at_a_fixed_interval() {
        let frames = (0..SPINNER_FRAMES.len())
            .map(|index| spinner_frame(SPINNER_FRAME_INTERVAL * index as u32))
            .collect::<Vec<_>>();

        assert_eq!(frames, SPINNER_FRAMES);
        assert_eq!(
            spinner_frame(SPINNER_FRAME_INTERVAL * SPINNER_FRAMES.len() as u32),
            SPINNER_FRAMES[0]
        );
        assert!(
            frames
                .iter()
                .all(|frame| unicode_width::UnicodeWidthStr::width(*frame) == 1)
        );
    }

    #[test]
    fn tool_summary_animation_returns_to_its_fixed_resting_symbol() {
        let frames = (0..4)
            .map(|index| tool_summary_frame(Duration::from_millis(240 * index)))
            .collect::<Vec<_>>();
        let expected = if cfg!(windows) {
            ["o", "O", "o", "O"]
        } else {
            ["◇", "◈", "◆", "◈"]
        };
        assert_eq!(frames, expected);
        assert_eq!(tool_summary_frame(Duration::from_millis(960)), expected[0]);
    }

    #[test]
    fn truecolor_shimmer_uses_rgb_foreground() {
        let span = shimmer_spans_for("•", Duration::from_secs(1), true)
            .pop()
            .expect("single glyph should render");

        assert!(matches!(span.style.fg, Some(Color::Rgb(_, _, _))));
        assert!(span.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn truecolor_detection_recognizes_common_terminal_env() {
        assert!(truecolor_supported_from_env(
            Some("truecolor"),
            None,
            None,
            None
        ));
        assert!(truecolor_supported_from_env(
            Some("24bit"),
            None,
            None,
            None
        ));
        assert!(truecolor_supported_from_env(
            None,
            Some("xterm-direct"),
            None,
            None
        ));
        assert!(truecolor_supported_from_env(
            None,
            None,
            Some("WezTerm"),
            None
        ));
        assert!(truecolor_supported_from_env(None, None, None, Some("1")));
        assert!(!truecolor_supported_from_env(None, None, None, Some("0")));
    }
}
