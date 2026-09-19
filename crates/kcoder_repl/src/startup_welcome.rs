use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StartupWelcomeInfo {
    directory: String,
    session: String,
    model: String,
    version: String,
}

fn startup_field_value(text: &str) -> String {
    sanitize_tui_text(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn startup_welcome_info(app: &ReplApp) -> StartupWelcomeInfo {
    let model = model_footer_label(&app.model_name, app.reasoning_effort.as_ref());
    StartupWelcomeInfo {
        directory: startup_field_value(&app.display_cwd),
        session: startup_field_value(&app.session_id),
        model: startup_field_value(&model),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

fn welcome_accent_color() -> Color {
    let rgb = theme::KCODER_WELCOME_ORANGE_RGB;
    Color::Rgb(rgb.0, rgb.1, rgb.2)
}

fn truncate_welcome_line(line: Line<'static>, width: u16) -> Line<'static> {
    line_truncation::truncate_line_with_ellipsis_if_overflow(line, usize::from(width))
}

fn welcome_content_line(line: Line<'static>, inner_width: usize, accent: Color) -> Line<'static> {
    let line = line_truncation::truncate_line_with_ellipsis_if_overflow(line, inner_width);
    let used = line_truncation::line_width(&line);
    let Line {
        style,
        alignment,
        spans,
    } = line;
    let mut out = Vec::with_capacity(spans.len() + 4);
    out.push(Span::styled("│", Style::default().fg(accent)));
    out.push(Span::raw("  "));
    out.extend(spans);
    out.push(Span::raw(" ".repeat(inner_width.saturating_sub(used))));
    out.push(Span::styled("│", Style::default().fg(accent)));
    Line {
        style,
        alignment,
        spans: out,
    }
}

fn startup_info_line(label: &'static str, value: &str, accent: Color) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            label,
            Style::default().fg(accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            value.to_string(),
            Style::default().fg(KCODER_UI_THEME.text_soft),
        ),
    ])
}

const STARTUP_WELCOME_LOGO: [&str; 6] = [
    "        ▄▄▄▄▄        ", // Square antenna cap.
    "        ▄▄█▄▄        ", // Antenna stem.
    "    ▄▄▄███████▄▄▄   ",  // Stepped top edge of the head.
    "  █ █   ■   ■   █ █",   // Projecting square ears and square eyes.
    "  █ █  █ █ █ █  █ █",   // Projecting square ears and a vertical grille mouth.
    "    ▀▀▀▀▀▀▀▀▀▀▀▀▀    ", // Stepped bottom edge of the head.
];

// Classic Windows consoles use wider character cells than the Linux terminals
// this logo was designed for, and render U+25A0 as a two-cell CJK glyph. Pack
// the horizontal grid and use a half-block eye that stays square in those
// cells, so the same robot keeps its intended visible proportions.
#[cfg(windows)]
const WINDOWS_STARTUP_WELCOME_LOGO: [&str; 6] = [
    "     ▄▄▄▄▄     ",
    "     ▄▄█▄▄     ",
    "  ▄▄███████▄▄  ",
    "█ █  ▄   ▄  █ █",
    "█ █ █ █ █ █ █ █",
    "  ▀▀▀▀▀▀▀▀▀▀▀  ",
];

fn startup_welcome_logo() -> &'static [&'static str; 6] {
    #[cfg(windows)]
    {
        if windows_compat::use_compact_startup_logo() {
            &WINDOWS_STARTUP_WELCOME_LOGO
        } else {
            &STARTUP_WELCOME_LOGO
        }
    }

    #[cfg(not(windows))]
    {
        &STARTUP_WELCOME_LOGO
    }
}

fn startup_welcome_logo_width() -> usize {
    startup_welcome_logo()
        .iter()
        .map(|row| unicode_width::UnicodeWidthStr::width(*row))
        .max()
        .unwrap_or(0)
}

pub(super) fn render_startup_welcome(
    info: StartupWelcomeInfo,
    width: Option<u16>,
) -> Vec<Line<'static>> {
    let width = width.unwrap_or(80).max(1);
    let accent = welcome_accent_color();
    let title_style = Style::default().fg(accent).add_modifier(Modifier::BOLD);
    let dim_style = Style::default().fg(KCODER_UI_THEME.text_muted);

    if width < 24 {
        return vec![
            truncate_welcome_line(
                Line::from(Span::styled("Welcome to KCoder!", title_style)),
                width,
            ),
            truncate_welcome_line(
                Line::from(Span::styled("Send /help for help information.", dim_style)),
                width,
            ),
            truncate_welcome_line(startup_info_line("Model: ", &info.model, accent), width),
        ];
    }

    let logo_style = Style::default().fg(accent);
    // Windows conhost distorts block-element glyphs when bold is applied.
    // Keep Linux's original styling, but use normal weight on Windows so the
    // same robot glyphs retain their intended half-block geometry.
    #[cfg(not(windows))]
    let logo_style = logo_style.add_modifier(Modifier::BOLD);
    let logo_width = startup_welcome_logo_width();
    let gap = "  ";
    let right_rows = [
        Line::from(Span::styled("Welcome to KCoder!", title_style)),
        Line::from(Span::styled("Send /help for help information.", dim_style)),
        startup_info_line("Directory: ", &info.directory, accent),
        startup_info_line("Session:   ", &info.session, accent),
        startup_info_line("Model:     ", &info.model, accent),
        startup_info_line("Version:   ", &info.version, accent),
    ];
    let logo_rows = startup_welcome_logo();
    let content_height = logo_rows.len().max(right_rows.len());
    let logo_offset = (content_height.saturating_sub(logo_rows.len())) / 2;
    let right_offset = (content_height.saturating_sub(right_rows.len())) / 2;
    let content_rows = (0..content_height)
        .map(|row_idx| {
            let logo = row_idx
                .checked_sub(logo_offset)
                .and_then(|idx| logo_rows.get(idx))
                .copied()
                .unwrap_or("");
            let logo_pad =
                " ".repeat(logo_width.saturating_sub(unicode_width::UnicodeWidthStr::width(logo)));
            let mut spans = vec![Span::styled(format!("{logo}{logo_pad}"), logo_style)];
            spans.push(Span::raw(gap));
            if let Some(right_line) = row_idx
                .checked_sub(right_offset)
                .and_then(|idx| right_rows.get(idx))
            {
                spans.extend(right_line.spans.clone());
            }
            Line::from(spans)
        })
        .collect::<Vec<_>>();
    let safe_width = width.max(4);
    let inner_width = usize::from(safe_width.saturating_sub(4).max(1));
    let border_width = usize::from(safe_width.saturating_sub(2).max(1));
    let mut lines = Vec::new();
    lines.push(Line::from(Span::styled(
        format!("╭{}╮", "─".repeat(border_width)),
        Style::default().fg(accent),
    )));
    lines.push(Line::from(vec![
        Span::styled("│", Style::default().fg(accent)),
        Span::raw(" ".repeat(usize::from(safe_width.saturating_sub(2)))),
        Span::styled("│", Style::default().fg(accent)),
    ]));

    for line in content_rows {
        lines.push(welcome_content_line(line, inner_width, accent));
    }

    lines.push(Line::from(vec![
        Span::styled("│", Style::default().fg(accent)),
        Span::raw(" ".repeat(usize::from(safe_width.saturating_sub(2)))),
        Span::styled("│", Style::default().fg(accent)),
    ]));
    lines.push(Line::from(Span::styled(
        format!("╰{}╯", "─".repeat(border_width)),
        Style::default().fg(accent),
    )));
    lines
        .into_iter()
        .map(|line| truncate_welcome_line(line, safe_width))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines_to_text(lines: &[Line<'_>]) -> String {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn startup_welcome_renders_orange_card_with_metadata() {
        let mut app = ReplApp {
            display_cwd: "/tmp/kcoder-project".to_string(),
            session_id: "session_test".to_string(),
            model_name: "KCoder".to_string(),
            ..ReplApp::default()
        };
        app.reasoning_effort = Some(ReasoningEffort::High);

        let lines = render_startup_welcome(startup_welcome_info(&app), Some(80));
        let rendered = lines_to_text(&lines);

        assert!(rendered.contains("╭"));
        for logo_row in startup_welcome_logo() {
            assert!(rendered.contains(logo_row));
        }
        assert!(rendered.contains("Welcome to KCoder!"));
        assert!(rendered.contains("Directory: /tmp/kcoder-project"));
        assert!(rendered.contains("Session:   session_test"));
        assert!(rendered.contains("Model:     KCoder high"));
        assert!(rendered.contains(&format!("Version:   {}", env!("CARGO_PKG_VERSION"))));
        assert_eq!(lines[0].spans[0].style.fg, Some(welcome_accent_color()));
    }

    #[test]
    fn startup_welcome_keeps_the_original_robot_logo() {
        assert_eq!(
            STARTUP_WELCOME_LOGO,
            [
                "        ▄▄▄▄▄        ",
                "        ▄▄█▄▄        ",
                "    ▄▄▄███████▄▄▄   ",
                "  █ █   ■   ■   █ █",
                "  █ █  █ █ █ █  █ █",
                "    ▀▀▀▀▀▀▀▀▀▀▀▀▀    ",
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn startup_welcome_compensates_for_wide_windows_console_cells() {
        assert_eq!(
            WINDOWS_STARTUP_WELCOME_LOGO,
            [
                "     ▄▄▄▄▄     ",
                "     ▄▄█▄▄     ",
                "  ▄▄███████▄▄  ",
                "█ █  ▄   ▄  █ █",
                "█ █ █ █ █ █ █ █",
                "  ▀▀▀▀▀▀▀▀▀▀▀  ",
            ]
        );
        assert!(
            WINDOWS_STARTUP_WELCOME_LOGO
                .iter()
                .all(|row| unicode_width::UnicodeWidthStr::width(*row) == 15)
        );
    }

    #[cfg(windows)]
    #[test]
    fn startup_welcome_avoids_conhost_bold_block_distortion() {
        let lines = render_startup_welcome(startup_welcome_info(&ReplApp::default()), Some(80));
        let logo_span = &lines[2].spans[2];

        assert!(logo_span.content.contains("▄▄▄▄▄"));
        assert!(!logo_span.style.add_modifier.contains(Modifier::BOLD));
    }

    #[test]
    fn startup_welcome_uses_available_width_instead_of_content_width() {
        let app = ReplApp {
            display_cwd: "/tmp/kcoder-project".to_string(),
            session_id: "session_test_with_extra_width".to_string(),
            model_name: "MiniMax-M3".to_string(),
            ..ReplApp::default()
        };

        let width = 160;
        let lines = render_startup_welcome(startup_welcome_info(&app), Some(width));

        assert_eq!(lines.len(), 10);
        for line in &lines {
            assert_eq!(
                line_truncation::line_width(line),
                usize::from(width),
                "welcome line should span the available TUI width: {line:?}"
            );
        }
    }
}
