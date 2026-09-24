use super::*;
use kcoder_types::MessageRole;
use ratatui::{
    Terminal as RatatuiTerminal,
    backend::TestBackend,
    text::{Line, Text},
    widgets::{Paragraph, Wrap},
};

fn make_msg(role: MessageRole, text: &str) -> DisplayMessage {
    DisplayMessage {
        role,
        text: text.to_string(),
    }
}

fn line_texts(lines: Vec<Line<'static>>) -> Vec<String> {
    lines
        .into_iter()
        .map(|line| {
            line.spans
                .into_iter()
                .map(|span| span.content.into_owned())
                .collect()
        })
        .collect()
}

fn backend_row_texts(lines: Vec<Line<'static>>, width: u16, height: u16) -> Vec<String> {
    let backend = TestBackend::new(width, height);
    let mut terminal = RatatuiTerminal::new(backend).expect("test backend should initialize");
    terminal
        .draw(|frame| {
            let paragraph = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
            frame.render_widget(paragraph, frame.area());
        })
        .expect("test backend should render");

    let buffer = terminal.backend().buffer();
    (0..height)
        .map(|y| {
            let mut row = String::new();
            let mut hidden_wide_cells = 0usize;
            for x in 0..width {
                let cell = &buffer[(x, y)];
                let symbol = cell.symbol();
                if symbol == " " && hidden_wide_cells > 0 {
                    hidden_wide_cells = hidden_wide_cells.saturating_sub(1);
                    continue;
                }
                row.push_str(symbol);
                hidden_wide_cells = unicode_width::UnicodeWidthStr::width(symbol).saturating_sub(1);
            }
            row.trim_end().to_string()
        })
        .collect()
}

#[derive(Debug)]
struct BackendCellSnapshot {
    symbol: String,
    fg: Color,
    bg: Color,
    modifier: Modifier,
}

fn backend_cell_rows(
    lines: Vec<Line<'static>>,
    width: u16,
    height: u16,
) -> Vec<Vec<BackendCellSnapshot>> {
    let backend = TestBackend::new(width, height);
    let mut terminal = RatatuiTerminal::new(backend).expect("test backend should initialize");
    terminal
        .draw(|frame| {
            let paragraph = Paragraph::new(Text::from(lines)).wrap(Wrap { trim: false });
            frame.render_widget(paragraph, frame.area());
        })
        .expect("test backend should render");

    let buffer = terminal.backend().buffer();
    (0..height)
        .map(|y| {
            (0..width)
                .map(|x| {
                    let cell = &buffer[(x, y)];
                    BackendCellSnapshot {
                        symbol: cell.symbol().to_string(),
                        fg: cell.fg,
                        bg: cell.bg,
                        modifier: cell.modifier,
                    }
                })
                .collect()
        })
        .collect()
}

fn backend_cell_row_text(row: &[BackendCellSnapshot]) -> String {
    row.iter()
        .map(|cell| cell.symbol.as_str())
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn current_diff_background(kind: theme::DiffLineKind) -> Color {
    let backgrounds = theme::DiffStyleContext::current().backgrounds;
    match kind {
        theme::DiffLineKind::Insert => backgrounds.add,
        theme::DiffLineKind::Delete => backgrounds.del,
        theme::DiffLineKind::Context => None,
    }
    .expect("diff 背景测试需要 truecolor 或 ANSI 256 色环境")
}

fn tool_diff_backend_rows(output: &str, height: u16) -> Vec<String> {
    tool_diff_backend_rows_at_width(output, 80, height)
}

fn tool_diff_backend_rows_at_width(output: &str, width: u16, height: u16) -> Vec<String> {
    let diff = format_tool_diff("edit", output).expect("diff should be extracted");
    let msg = make_msg(MessageRole::System, &diff);
    let rendered_lines =
        render_message_with_width(&msg, None, false, false, false, "", Some(width));
    backend_row_texts(rendered_lines, width, height)
}

fn assert_prefix_rows(rows: &[String], expected: &[&str]) {
    assert_eq!(
        &rows[..expected.len()],
        expected,
        "backend rows did not match expected prefix: {rows:?}"
    );
    assert!(
        rows[expected.len()..].iter().all(|row| row.is_empty()),
        "expected remaining backend rows to stay empty: {rows:?}"
    );
}

fn tool_diff_gallery_output() -> String {
    concat!(
        "Edited 6 files\n",
        "```diff\n",
        "diff --git a/assets/banner.txt b/assets/banner.txt\n",
        "new file mode 100644\n",
        "index 0000000..1111111\n",
        "--- /dev/null\n",
        "+++ b/assets/banner.txt\n",
        "@@ -0,0 +1,3 @@\n",
        "+HEADER\tVALUE\n",
        "+rocket\t🚀\n",
        "+city\t東京\n",
        "diff --git a/examples/new_sample.rs b/examples/new_sample.rs\n",
        "new file mode 100644\n",
        "index 0000000..2222222\n",
        "--- /dev/null\n",
        "+++ b/examples/new_sample.rs\n",
        "@@ -0,0 +1,3 @@\n",
        "+pub fn greet(name: &str) {\n",
        "+    println!(\"Hello, {name}!\");\n",
        "+}\n",
        "diff --git a/legacy/old_script.py b/legacy/old_script.py\n",
        "deleted file mode 100644\n",
        "index 3333333..0000000\n",
        "--- a/legacy/old_script.py\n",
        "+++ /dev/null\n",
        "@@ -1,3 +0,0 @@\n",
        "-def legacy(x):\n",
        "-    return x + 1\n",
        "-print(legacy(3))\n",
        "diff --git a/scripts/calc.txt b/scripts/calc.py\n",
        "similarity index 88%\n",
        "rename from scripts/calc.txt\n",
        "rename to scripts/calc.py\n",
        "index 4444444..5555555 100644\n",
        "--- a/scripts/calc.txt\n",
        "+++ b/scripts/calc.py\n",
        "@@ -1,4 +1,4 @@\n",
        " def add(a, b):\n",
        "-\treturn a + b\n",
        "+\treturn a + b + 42\n",
        " \n",
        " print(add(1, 2))\n",
        "diff --git a/src/lib.rs b/src/lib.rs\n",
        "index 6666666..7777777 100644\n",
        "--- a/src/lib.rs\n",
        "+++ b/src/lib.rs\n",
        "@@ -1,4 +1,4 @@\n",
        " fn greet(name: &str) {\n",
        "-    println!(\"hello\");\n",
        "-    println!(\"bye\");\n",
        "+    println!(\"hello {name}\");\n",
        "+    println!(\"emoji: 🚀✨ and CJK: 你好世界\");\n",
        " }\n",
        "diff --git a/tmp/obsolete.log b/tmp/obsolete.log\n",
        "deleted file mode 100644\n",
        "index 8888888..0000000\n",
        "--- a/tmp/obsolete.log\n",
        "+++ /dev/null\n",
        "@@ -1,3 +0,0 @@\n",
        "-old line 1\n",
        "-old line 2\n",
        "-old line 3\n",
        "```",
    )
    .to_string()
}

#[test]
fn user_message_still_renders() {
    let msg = make_msg(MessageRole::User, "hello");
    let lines = render_message(&msg, None, false, false, false, "");
    assert!(
        !lines.is_empty(),
        "user messages must keep producing some output"
    );
}

#[test]
fn user_message_omits_box_separators() {
    let msg = make_msg(MessageRole::User, "hello");
    let rendered = render_message(&msg, None, false, false, false, "")
        .into_iter()
        .flat_map(|line| line.spans.into_iter().map(|span| span.content.to_string()))
        .collect::<String>();
    for ch in ["╭", "╰", "│", "─"] {
        assert!(
            !rendered.contains(ch),
            "unexpected transcript border glyph {ch}"
        );
    }
}

#[test]
fn user_message_wraps_and_prefixes_visual_lines() {
    let msg = make_msg(MessageRole::User, "one two three four five six seven");
    let rendered = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "",
        Some(12),
    ));

    assert_eq!(
        rendered,
        vec!["", "› one two", "  three four", "  five six", "  seven", "",]
    );
}

#[test]
fn user_message_wraps_explicit_newlines_with_continuation_indent() {
    let msg = make_msg(MessageRole::User, "alpha beta\ngamma delta epsilon");
    let rendered = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "",
        Some(14),
    ));

    assert_eq!(
        rendered,
        vec!["", "› alpha beta", "  gamma delta", "  epsilon", ""]
    );
}

#[test]
fn user_message_wrap_preserves_url_like_tokens() {
    let url = "https://example.com/path/to/artifact";
    let msg = make_msg(MessageRole::User, &format!("see {url} now"));
    let rendered = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "",
        Some(12),
    ));

    assert!(
        rendered.iter().any(|line| line.trim() == url),
        "expected full URL token in rendered lines: {rendered:?}"
    );
}

#[test]
fn assistant_markdown_tiny_width_shows_prefix_only() {
    let msg = make_msg(MessageRole::Assistant, "narrow width coverage");
    let rendered = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        true,
        "base16-ocean.dark",
        Some(2),
    ));

    assert_eq!(rendered, vec!["• "]);
}

#[test]
fn assistant_markdown_ordered_list_first_item_keeps_marker() {
    let msg = make_msg(
        MessageRole::Assistant,
        "1. 我是KCoder-Arrangement，由昆仑元人工智能技术（上海）有限公司开发。\n2. Arrangement模式角色：主智能体是编排者。",
    );
    let rendered = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        true,
        "base16-ocean.dark",
        Some(120),
    ));

    assert_eq!(
        rendered,
        vec![
            "  1. 我是KCoder-Arrangement，由昆仑元人工智能技术（上海）有限公司开发。",
            "  2. Arrangement模式角色：主智能体是编排者。",
        ]
    );
}

#[test]
fn plain_system_message_still_renders() {
    let msg = make_msg(MessageRole::System, "Welcome to KCoder.");
    let lines = render_message(&msg, None, false, false, false, "");
    assert!(!lines.is_empty());
}

#[test]
fn tool_output_messages_are_suppressed() {
    // Verbose tool *output* messages are suppressed. Invocation and
    // one-line status messages remain visible.
    let suppressed = ["[Tool result: read\nok]", "[Tool error: write\nboom]"];
    for text in suppressed {
        let msg = make_msg(MessageRole::System, text);
        let lines: Vec<Line<'static>> = render_message(&msg, None, false, false, false, "");
        assert!(
            lines.is_empty(),
            "expected no output for {text:?}, got {} lines",
            lines.len()
        );
    }
}

#[test]
fn tool_invocation_and_status_messages_are_visible() {
    let visible = [
        "⟳ Running tool: read\nfoo",
        "[Tool use: read]",
        "✓ Tool succeeded: bash",
        "✗ Tool failed: write",
    ];
    for text in visible {
        let msg = make_msg(MessageRole::System, text);
        let lines: Vec<Line<'static>> = render_message(&msg, None, false, false, false, "");
        assert!(
            !lines.is_empty(),
            "expected visible output for {text:?}, got {} lines",
            lines.len()
        );
    }
}

#[test]
fn running_tool_header_uses_motion_activity_marker() {
    let msg = make_msg(MessageRole::System, "⟳ Running tool: bash - cargo test");
    let lines = render_message(&msg, None, false, false, false, "");
    let header = lines.first().expect("running tool header should render");
    let header_text = header
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();

    assert_eq!(
        header.spans[1].content.as_ref(),
        if cfg!(windows) { "*" } else { "•" }
    );
    assert!(header_text.contains("▶ run bash"));
    assert!(!header_text.contains("⟳"));
}

#[test]
fn tool_summary_shows_transcript_shortcut_hint() {
    let msg = make_msg(
        MessageRole::System,
        "[Tool summary] read x2 · bash x1\n[Tool latest] latest: bash done - ok",
    );
    let rendered = render_message(&msg, None, false, false, false, "")
        .into_iter()
        .flat_map(|line| line.spans.into_iter().map(|span| span.content.to_string()))
        .collect::<String>();

    assert!(rendered.contains("read x2 · bash x1"));
    assert!(rendered.contains("latest: bash done - ok"));
    assert!(rendered.contains("(alt + t to expand tools)"));
}

#[test]
fn tool_summary_uses_family_and_status_colors() {
    let msg = make_msg(
        MessageRole::System,
        "[Tool summary] read x2 · bash x1\n[Tool latest] latest: bash done - ok",
    );
    let lines = render_message(&msg, None, false, false, false, "");
    let spans = lines
        .iter()
        .flat_map(|line| line.spans.iter())
        .collect::<Vec<_>>();

    let bash_count = spans
        .iter()
        .find(|span| span.content.as_ref() == "bash")
        .expect("tool count should render the bash name");
    assert_eq!(
        bash_count.style.fg,
        family_style(ToolFamily::Run).fg,
        "tool names should use their family color"
    );

    let done = spans
        .iter()
        .find(|span| span.content.as_ref() == " done")
        .expect("latest status should be visible");
    assert_eq!(done.style.fg, Some(KCODER_UI_THEME.success));

    let shortcut = spans
        .iter()
        .find(|span| span.content.as_ref() == "alt + t")
        .expect("tool transcript shortcut should be visible");
    assert_eq!(shortcut.style.fg, KCODER_UI_THEME.text_styles().link.fg);
}

#[test]
fn tool_summary_bash_preview_uses_syntax_highlighting() {
    let command = "if true; then echo ok; fi";
    let msg = make_msg(
        MessageRole::System,
        &format!("[Tool summary] bash x1\n[Tool latest] latest: bash done - {command}"),
    );
    let lines = render_message(&msg, None, false, false, false, "base16-ocean.dark");
    let preview_line = lines
        .iter()
        .find(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
                .contains(command)
        })
        .expect("summary shell preview should render");

    assert!(
        preview_line.spans.len() > 4,
        "summary shell preview should be split into syntax spans"
    );
    assert!(
        preview_line.spans.iter().any(|span| {
            span.content.as_ref() == "if"
                && span.style.fg.is_some()
                && span.style.fg != Some(KCODER_UI_THEME.text_dim)
        }),
        "shell keywords in the summary should carry syntax colors"
    );
}

#[test]
fn tool_call_status_and_family_colors_cover_all_tool_families() {
    let cases = [
        ("read", ToolFamily::Read, "running", "•"),
        ("write", ToolFamily::Patch, "success", "✓"),
        ("bash", ToolFamily::Run, "error", "✗"),
        ("grep", ToolFamily::Find, "success", "✓"),
        ("mcp__docs__search", ToolFamily::Mcp, "success", "✓"),
        ("spawn_agent", ToolFamily::Delegate, "success", "✓"),
        ("custom_tool", ToolFamily::Generic, "success", "✓"),
    ];

    for (tool_name, family, status, status_icon) in cases {
        let message = match status {
            "running" => format!("⟳ Running tool: {tool_name} - input"),
            "error" => format!("✗ Tool failed: {tool_name} - failed"),
            _ => format!("✓ Tool succeeded: {tool_name} - done"),
        };
        let lines = render_message(
            &make_msg(MessageRole::System, &message),
            None,
            false,
            false,
            false,
            "",
        );
        let spans = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .collect::<Vec<_>>();

        let icon = spans
            .iter()
            .find(|span| span.content.as_ref() == status_icon)
            .unwrap_or_else(|| panic!("missing status icon for {tool_name}"));
        let expected_status = match status_icon {
            "•" => KCODER_UI_THEME
                .tool_styles()
                .running
                .add_modifier(ratatui::style::Modifier::DIM),
            "✗" => KCODER_UI_THEME.tool_styles().failure,
            _ => KCODER_UI_THEME.tool_styles().success,
        };
        assert_eq!(icon.style, expected_status, "status style for {tool_name}");

        let name = spans
            .iter()
            .find(|span| span.content.as_ref() == tool_name)
            .unwrap_or_else(|| panic!("missing tool name for {tool_name}"));
        assert_eq!(
            name.style.fg,
            family_style(family).fg,
            "family style for {tool_name}"
        );
    }
}

#[test]
fn thinking_message_stays_collapsed_when_tools_expand() {
    let msg = make_msg(
        MessageRole::System,
        "[Thinking] line one\nline two\nline three",
    );

    let collapsed = line_texts(render_message(&msg, None, false, false, false, ""));
    assert_eq!(
        collapsed,
        vec!["• line one", "  line two", "  ... (10 more chars)"]
    );

    let expanded = line_texts(render_message(&msg, None, false, true, false, ""));
    assert_eq!(expanded, collapsed);
}

#[test]
fn thinking_message_hidden_count_is_width_stable() {
    let msg = make_msg(
        MessageRole::System,
        "[Thinking] short visible\nsecond visible\nhidden tail stays width stable",
    );

    let narrow = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "",
        Some(28),
    ));
    let wide = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "",
        Some(80),
    ));

    assert!(
        narrow
            .iter()
            .any(|line| line.trim_end() == "  ... (30 more chars)"),
        "{narrow:?}"
    );
    assert!(
        wide.iter()
            .any(|line| line.trim_end() == "  ... (30 more chars)"),
        "{wide:?}"
    );
}

#[test]
fn thinking_message_counts_truncated_preview_tail() {
    let msg = make_msg(MessageRole::System, "[Thinking] abcdefghijklmnop");

    let collapsed = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "",
        Some(12),
    ));

    assert_eq!(collapsed[0], "• abcdefghij");
    assert!(collapsed[1].starts_with("  ... (6"), "{collapsed:?}");
    assert_eq!(render::wrapping::display_width(&collapsed[1]), 12);
}

#[test]
fn thinking_message_counts_wide_char_preview_tail() {
    let msg = make_msg(MessageRole::System, "[Thinking] 北京上海广州深圳");

    let collapsed = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "",
        Some(6),
    ));

    assert_eq!(collapsed[0], "• 北京");
    assert!(collapsed[1].starts_with("  ..."), "{collapsed:?}");
    assert_eq!(render::wrapping::display_width(&collapsed[1]), 6);
}

#[test]
fn expanded_thinking_message_does_not_pretruncate_to_width() {
    let msg = make_msg(MessageRole::System, "[Thinking] abcdefghijklmnop");

    let collapsed = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "",
        Some(12),
    ));
    let expanded = line_texts(render_message_with_width(
        &msg,
        None,
        false,
        true,
        false,
        "",
        Some(12),
    ));

    assert_eq!(expanded, collapsed);
}

#[test]
fn tool_input_and_result_previews_are_capped() {
    let long = (0..80)
        .map(|idx| format!("item{idx:03}-"))
        .collect::<String>();
    let expected_preview = format!("{}...", long.chars().take(117).collect::<String>());

    assert_eq!(
        format_tool_use("read", &long),
        format!("[Tool use: read] {expected_preview}")
    );
    assert_eq!(
        format_tool_status("read", &long, false),
        format!("✓ Tool succeeded: read - {expected_preview}")
    );

    let msg = make_msg(MessageRole::System, &format_tool_use("read", &long));
    let rendered = render_message(&msg, None, false, false, false, "")
        .into_iter()
        .flat_map(|line| line.spans.into_iter().map(|span| span.content.to_string()))
        .collect::<String>();

    let omitted_tail: String = long.chars().skip(140).take(20).collect();
    assert!(rendered.contains(&expected_preview));
    assert!(!rendered.contains(&omitted_tail));
}

#[test]
fn shell_tool_preview_uses_syntax_highlighting() {
    let command = "if true; then echo ok; fi";
    let msg = make_msg(MessageRole::System, &format!("[Tool use: bash] {command}"));
    let rendered_lines = render_message(&msg, None, false, false, false, "base16-ocean.dark");
    let preview_line = rendered_lines
        .iter()
        .find(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
                .contains(command)
        })
        .expect("shell preview should render");

    assert!(
        preview_line.spans.len() > 2,
        "highlighted shell preview should be split into syntax spans"
    );
    assert!(preview_line.spans.iter().skip(1).any(|span| {
        span.style.fg.is_some() && span.style.fg != Some(KCODER_UI_THEME.text_dim)
    }));
}

#[test]
fn non_shell_tool_preview_keeps_single_dim_span() {
    let preview = "{\"file\":\"a.rs\"}";
    let msg = make_msg(MessageRole::System, &format!("[Tool use: read] {preview}"));
    let rendered_lines = render_message(&msg, None, false, false, false, "base16-ocean.dark");
    let preview_line = rendered_lines
        .iter()
        .find(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
                .contains(preview)
        })
        .expect("non-shell preview should render");

    assert_eq!(preview_line.spans.len(), 2);
    assert_eq!(preview_line.spans[1].content.as_ref(), preview);
    assert_eq!(preview_line.spans[1].style.fg, None);
    assert!(
        preview_line.spans[1]
            .style
            .add_modifier
            .contains(Modifier::DIM)
    );
}

#[test]
fn permission_command_detail_uses_shell_syntax_highlighting() {
    let spans = permission_detail_spans(
        "bash",
        "Command: if true; then echo ok; fi",
        Style::default().fg(Color::Gray),
        "base16-ocean.dark",
    );
    let text = spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();

    assert_eq!(text, "Command: if true; then echo ok; fi");
    assert_eq!(spans.first().unwrap().content.as_ref(), "Command: ");
    assert!(
        spans
            .iter()
            .skip(1)
            .any(|span| span.style.fg.is_some() && span.style.fg != Some(Color::Gray))
    );
}

#[test]
fn permission_shell_input_fallback_renders_highlighted_command() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = PermissionDialog {
        tool_name: "bash".to_string(),
        description: "Run command".to_string(),
        input: serde_json::json!({ "command": "if true; then echo ok; fi" }),
        risk: PermissionRisk::Low,
        detail_lines: Vec::new(),
        response_tx: tx,
        selected: 0,
    };
    let spans = permission_input_spans(
        &dialog,
        Style::default().fg(Color::DarkGray),
        "base16-ocean.dark",
    );
    let text = spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();

    assert_eq!(text, "$ if true; then echo ok; fi");
    assert_eq!(spans.first().unwrap().content.as_ref(), "$ ");
    assert!(
        spans
            .iter()
            .skip(1)
            .any(|span| span.style.fg.is_some() && span.style.fg != Some(Color::DarkGray))
    );
}

#[test]
fn permission_generic_input_uses_compact_json_spacing() {
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let dialog = PermissionDialog {
        tool_name: "read".to_string(),
        description: "Read file".to_string(),
        input: serde_json::json!({
            "file": "src/lib.rs",
            "options": {
                "line": 12,
                "include": ["context", "symbols"]
            }
        }),
        risk: PermissionRisk::Low,
        detail_lines: Vec::new(),
        response_tx: tx,
        selected: 0,
    };
    let text = permission_input_spans(
        &dialog,
        Style::default().fg(Color::DarkGray),
        "base16-ocean.dark",
    )
    .iter()
    .map(|span| span.content.as_ref())
    .collect::<String>();

    assert_eq!(
        text,
        r#"Input: {"file": "src/lib.rs", "options": {"include": ["context", "symbols"], "line": 12}}"#
    );
}

#[test]
fn tool_preview_compacts_whitespace_and_caps_output() {
    let long = format!("alpha\n\tbeta  {}", "x".repeat(200));
    let preview = preview_tool_text(&long);

    assert!(preview.starts_with("alpha beta "));
    assert!(preview.ends_with("..."));
    assert_eq!(preview.chars().count(), TOOL_PREVIEW_CHARS);
    assert!(!preview.contains('\n'));
    assert!(!preview.contains('\t'));
}

#[test]
fn tool_error_preview_strips_terminal_control_sequences() {
    let raw = "\x1b[31mboom\x1b[0m\r\nbad\x07";

    let status = format_tool_status("bash", raw, true);

    assert_eq!(status, "✗ Tool failed: bash - boom bad");
    assert!(!status.contains('\x1b'));
    assert!(!status.contains("[31m"));
    assert!(!status.contains('\x07'));
    assert!(!status.contains('\r'));
}

#[test]
fn tool_diff_messages_render_added_and_deleted_lines() {
    let deleted_bg = current_diff_background(theme::DiffLineKind::Delete);
    let added_bg = current_diff_background(theme::DiffLineKind::Insert);
    let diff = format_tool_diff(
        "edit",
        "Edited src/lib.rs\n```diff\n@@ -1 +1 @@\n-old\n+new\n```",
    )
    .expect("diff should be extracted");
    let msg = make_msg(MessageRole::System, &diff);
    let rendered_lines = render_message(&msg, None, false, false, false, "");
    let rendered = rendered_lines
        .iter()
        .flat_map(|line| line.spans.iter().map(|span| span.content.to_string()))
        .collect::<String>();

    assert!(!rendered.contains("patch edit"));
    assert!(rendered.contains("• Edited src/lib.rs (+1 -1)"));
    assert!(rendered.contains("Edited src/lib.rs (+1 -1)"));
    assert!(rendered.contains("1 -old"));
    assert!(rendered.contains("1 +new"));

    let deleted_span = rendered_lines
        .iter()
        .flat_map(|line| line.spans.iter())
        .find(|span| span.content == "old")
        .expect("deleted line should render");
    assert_eq!(deleted_span.style.bg, Some(deleted_bg));

    let added_span = rendered_lines
        .iter()
        .flat_map(|line| line.spans.iter())
        .find(|span| span.content == "new")
        .expect("added line should render");
    assert_eq!(added_span.style.bg, Some(added_bg));
}

#[test]
fn tool_diff_update_block_visible_lines_match_expected_layout() {
    let diff = format_tool_diff(
            "edit",
            "Edited example.txt\n```diff\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line two changed\n line three\n```",
        )
        .expect("diff should be extracted");
    let msg = make_msg(MessageRole::System, &diff);
    let rendered_lines = render_message(&msg, None, false, false, false, "");

    assert_eq!(
        line_texts(rendered_lines),
        vec![
            "• Edited example.txt (+1 -1)",
            "    1  line one",
            "    2 -line two",
            "    2 +line two changed",
            "    3  line three",
        ]
    );
}

#[test]
fn tool_diff_update_block_backend_rows_match_expected_layout() {
    let rows = tool_diff_backend_rows(
        "Edited example.txt\n```diff\n@@ -1,3 +1,3 @@\n line one\n-line two\n+line two changed\n line three\n```",
        12,
    );

    assert_prefix_rows(
        &rows,
        &[
            "• Edited example.txt (+1 -1)",
            "    1  line one",
            "    2 -line two",
            "    2 +line two changed",
            "    3  line three",
        ],
    );
}

#[test]
fn tool_diff_add_block_backend_rows_match_expected_layout() {
    let rows = tool_diff_backend_rows(
        "Wrote 11 bytes to new_file.txt\n```diff\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n```",
        10,
    );

    assert_prefix_rows(
        &rows,
        &[
            "• Added new_file.txt (+2 -0)",
            "    1 +alpha",
            "    2 +beta",
        ],
    );
}

#[test]
fn tool_diff_delete_block_backend_rows_match_expected_layout() {
    let rows = tool_diff_backend_rows(
        "Edited tmp_delete_example.txt\n```diff\n@@ -1,3 +0,0 @@\n-first\n-second\n-third\n```",
        12,
    );

    assert_prefix_rows(
        &rows,
        &[
            "• Deleted tmp_delete_example.txt (+0 -3)",
            "    1 -first",
            "    2 -second",
            "    3 -third",
        ],
    );
}

#[test]
fn tool_diff_rename_block_backend_rows_match_expected_layout() {
    let rows = tool_diff_backend_rows(
        "Edited old_name.rs → new_name.rs\n```diff\n@@ -1,3 +1,3 @@\n A\n-B\n+B changed\n C\n```",
        12,
    );

    assert_prefix_rows(
        &rows,
        &[
            "• Edited old_name.rs → new_name.rs (+1 -1)",
            "    1  A",
            "    2 -B",
            "    2 +B changed",
            "    3  C",
        ],
    );
}

#[test]
fn tool_diff_multiple_files_backend_rows_match_expected_layout() {
    let rows = tool_diff_backend_rows(
        concat!(
            "Edited 2 files\n",
            "```diff\n",
            "diff --git a/a.txt b/a.txt\n",
            "index 1111111..2222222 100644\n",
            "--- a/a.txt\n",
            "+++ b/a.txt\n",
            "@@ -1 +1 @@\n",
            "-one\n",
            "+one changed\n",
            "diff --git a/b.txt b/b.txt\n",
            "new file mode 100644\n",
            "index 0000000..3333333\n",
            "--- /dev/null\n",
            "+++ b/b.txt\n",
            "@@ -0,0 +1 @@\n",
            "+new\n",
            "```",
        ),
        14,
    );

    assert_prefix_rows(
        &rows,
        &[
            "• Edited 2 files (+2 -1)",
            "  └ a.txt (+1 -1)",
            "    1 -one",
            "    1 +one changed",
            "",
            "  └ b.txt (+1 -0)",
            "    1 +new",
        ],
    );
}

#[test]
fn tool_diff_narrow_backend_wraps_with_codex_continuation_indent() {
    let rows = tool_diff_backend_rows_at_width(
        "Wrote 29 bytes to a.rs\n```diff\n@@ -0,0 +1 @@\n+abcdefghijklmnopqrstu\n```",
        24,
        6,
    );

    assert_prefix_rows(
        &rows,
        &[
            "• Added a.rs (+1 -0)",
            "    1 +abcdefghijklmnopq",
            "       rstu",
        ],
    );
}

#[test]
fn tool_diff_gallery_80x24_backend_rows_match_expected_layout() {
    let rows = tool_diff_backend_rows_at_width(&tool_diff_gallery_output(), 80, 24);

    assert_prefix_rows(
        &rows,
        &[
            "• Edited 6 files (+9 -9)",
            "  └ assets/banner.txt (+3 -0)",
            "    1 +HEADER\tVALUE",
            "    2 +rocket\t🚀",
            "    3 +city\t東京",
            "",
            "  └ examples/new_sample.rs (+3 -0)",
            "    1 +pub fn greet(name: &str) {",
            "    2 +    println!(\"Hello, {name}!\");",
            "    3 +}",
            "",
            "  └ legacy/old_script.py (+0 -3)",
            "    1 -def legacy(x):",
            "    2 -    return x + 1",
            "    3 -print(legacy(3))",
            "",
            "  └ scripts/calc.txt → scripts/calc.py (+1 -1)",
            "    1  def add(a, b):",
            "    2 -\treturn a + b",
            "    2 +\treturn a + b + 42",
            "    3",
            "    4  print(add(1, 2))",
            "",
            "  └ src/lib.rs (+2 -2)",
        ],
    );
}

#[test]
fn tool_diff_gallery_94x35_backend_rows_match_expected_layout() {
    let rows = tool_diff_backend_rows_at_width(&tool_diff_gallery_output(), 94, 35);

    assert_prefix_rows(
        &rows,
        &[
            "• Edited 6 files (+9 -9)",
            "  └ assets/banner.txt (+3 -0)",
            "    1 +HEADER\tVALUE",
            "    2 +rocket\t🚀",
            "    3 +city\t東京",
            "",
            "  └ examples/new_sample.rs (+3 -0)",
            "    1 +pub fn greet(name: &str) {",
            "    2 +    println!(\"Hello, {name}!\");",
            "    3 +}",
            "",
            "  └ legacy/old_script.py (+0 -3)",
            "    1 -def legacy(x):",
            "    2 -    return x + 1",
            "    3 -print(legacy(3))",
            "",
            "  └ scripts/calc.txt → scripts/calc.py (+1 -1)",
            "    1  def add(a, b):",
            "    2 -\treturn a + b",
            "    2 +\treturn a + b + 42",
            "    3",
            "    4  print(add(1, 2))",
            "",
            "  └ src/lib.rs (+2 -2)",
            "    1  fn greet(name: &str) {",
            "    2 -    println!(\"hello\");",
            "    3 -    println!(\"bye\");",
            "    2 +    println!(\"hello {name}\");",
            "    3 +    println!(\"emoji: 🚀✨ and CJK: 你好世界\");",
            "    4  }",
            "",
            "  └ tmp/obsolete.log (+0 -3)",
            "    1 -old line 1",
            "    2 -old line 2",
            "    3 -old line 3",
        ],
    );
}

#[test]
fn tool_diff_gallery_120x40_backend_rows_match_expected_layout() {
    let rows = tool_diff_backend_rows_at_width(&tool_diff_gallery_output(), 120, 40);

    assert_prefix_rows(
        &rows,
        &[
            "• Edited 6 files (+9 -9)",
            "  └ assets/banner.txt (+3 -0)",
            "    1 +HEADER\tVALUE",
            "    2 +rocket\t🚀",
            "    3 +city\t東京",
            "",
            "  └ examples/new_sample.rs (+3 -0)",
            "    1 +pub fn greet(name: &str) {",
            "    2 +    println!(\"Hello, {name}!\");",
            "    3 +}",
            "",
            "  └ legacy/old_script.py (+0 -3)",
            "    1 -def legacy(x):",
            "    2 -    return x + 1",
            "    3 -print(legacy(3))",
            "",
            "  └ scripts/calc.txt → scripts/calc.py (+1 -1)",
            "    1  def add(a, b):",
            "    2 -\treturn a + b",
            "    2 +\treturn a + b + 42",
            "    3",
            "    4  print(add(1, 2))",
            "",
            "  └ src/lib.rs (+2 -2)",
            "    1  fn greet(name: &str) {",
            "    2 -    println!(\"hello\");",
            "    3 -    println!(\"bye\");",
            "    2 +    println!(\"hello {name}\");",
            "    3 +    println!(\"emoji: 🚀✨ and CJK: 你好世界\");",
            "    4  }",
            "",
            "  └ tmp/obsolete.log (+0 -3)",
            "    1 -old line 1",
            "    2 -old line 2",
            "    3 -old line 3",
        ],
    );
}

#[test]
fn tool_diff_messages_apply_syntax_highlighting_to_diff_content() {
    let added_bg = current_diff_background(theme::DiffLineKind::Insert);
    let diff = format_tool_diff(
        "edit",
        "Edited src/lib.rs\n```diff\n@@ -1 +1 @@\n-let old = 1;\n+let new = 2;\n```",
    )
    .expect("diff should be extracted");
    let msg = make_msg(MessageRole::System, &diff);
    let rendered_lines = render_message(&msg, None, false, false, false, "base16-ocean.dark");

    let added_line = rendered_lines
        .iter()
        .find(|line| {
            line.spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
                .contains("1 +let new = 2;")
        })
        .expect("added syntax-highlighted line should render");

    assert!(
        added_line
            .spans
            .iter()
            .any(|span| span.content.as_ref() == "    ")
    );
    assert!(
        added_line
            .spans
            .iter()
            .any(|span| span.content.as_ref() == "1 ")
    );
    assert!(
        added_line
            .spans
            .iter()
            .any(|span| span.content.as_ref() == "+")
    );
    let syntax_span = added_line
        .spans
        .iter()
        .find(|span| {
            span.content.contains("let")
                && span.style.bg == Some(added_bg)
                && span.style.fg.is_some()
                && span.style.fg != Some(KCODER_UI_THEME.diff_added_fg)
        })
        .expect("diff content should carry syntax foreground over added background");
    assert_ne!(syntax_span.style, Style::default());
}

#[test]
fn tool_diff_wrapped_added_continuation_keeps_background_and_syntax() {
    let added_bg = current_diff_background(theme::DiffLineKind::Insert);
    let long_rust = "fn very_long_function_name(arg_one: String, arg_two: String, arg_three: String, arg_four: String) -> Result<String, Box<dyn std::error::Error>> { Ok(arg_one) }";
    let diff = format_tool_diff(
        "edit",
        &format!("Edited src/lib.rs\n```diff\n@@ -0,0 +1 @@\n+{long_rust}\n```"),
    )
    .expect("diff should be extracted");
    let msg = make_msg(MessageRole::System, &diff);
    let rendered_lines = render_message(&msg, None, false, false, false, "base16-ocean.dark");

    let added_lines = rendered_lines
        .iter()
        .filter(|line| {
            line.spans
                .iter()
                .any(|span| span.style.bg == Some(added_bg))
        })
        .collect::<Vec<_>>();
    assert!(
        added_lines.len() > 1,
        "expected wrapped added diff line to render on multiple styled rows"
    );

    let continuation = added_lines
        .iter()
        .find(|line| {
            !line
                .spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>()
                .contains('+')
        })
        .expect("wrapped continuation should not repeat the + sign");
    assert!(
        continuation
            .spans
            .iter()
            .any(|span| span.style.bg == Some(added_bg))
    );
    assert!(continuation.spans.iter().any(|span| {
        span.style.bg == Some(added_bg)
            && span.style.fg.is_some()
            && span.style.fg != Some(KCODER_UI_THEME.diff_added_fg)
    }));
}

#[test]
fn tool_diff_wrapped_syntax_backend_cells_keep_background_and_syntax() {
    let added_bg = current_diff_background(theme::DiffLineKind::Insert);
    let long_rust = "fn very_long_function_name(arg_one: String, arg_two: String, arg_three: String, arg_four: String) -> Result<String, Box<dyn std::error::Error>> { Ok(arg_one) }";
    let diff = format_tool_diff(
        "edit",
        &format!("Edited src/lib.rs\n```diff\n@@ -0,0 +1 @@\n+{long_rust}\n```"),
    )
    .expect("diff should be extracted");
    let msg = make_msg(MessageRole::System, &diff);
    let rendered_lines = render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "base16-ocean.dark",
        Some(90),
    );
    let cell_rows = backend_cell_rows(rendered_lines, 90, 10);
    let continuation_row = cell_rows
        .iter()
        .find(|row| {
            let text = backend_cell_row_text(row);
            text.starts_with("       ") && text.contains("String")
        })
        .expect("wrapped Rust continuation row should render in backend");
    let continuation_text = backend_cell_row_text(continuation_row);
    let visible_width = render::wrapping::display_width(&continuation_text);

    assert!(
        continuation_row
            .iter()
            .take(visible_width)
            .all(|cell| cell.bg == added_bg),
        "continuation row should keep added background: {continuation_text:?}"
    );
    assert!(
        continuation_row
            .iter()
            .take(visible_width)
            .filter(|cell| cell.symbol.trim().is_empty())
            .all(|cell| cell.bg == added_bg),
        "continuation prefix spaces should keep added background"
    );
    assert!(
        continuation_row.iter().take(visible_width).any(|cell| {
            !cell.symbol.trim().is_empty()
                && cell.bg == added_bg
                && cell.fg != KCODER_UI_THEME.diff_added_fg
                && cell.fg != Color::Reset
        }),
        "continuation content should keep syntax foreground over added background: {continuation_text:?}"
    );
}

#[test]
fn tool_diff_added_backend_row_extends_background_and_dims_gutter() {
    let added_bg = current_diff_background(theme::DiffLineKind::Insert);
    let diff = format_tool_diff(
        "edit",
        "Wrote 6 bytes to a.txt\n```diff\n@@ -0,0 +1 @@\n+short\n```",
    )
    .expect("diff should be extracted");
    let msg = make_msg(MessageRole::System, &diff);
    let rendered_lines = render_message_with_width(
        &msg,
        None,
        false,
        false,
        false,
        "base16-ocean.dark",
        Some(40),
    );
    let cell_rows = backend_cell_rows(rendered_lines, 40, 4);
    let added_row = cell_rows
        .iter()
        .find(|row| backend_cell_row_text(row).starts_with("    1 +short"))
        .expect("added backend row should render");

    assert!(
        added_row.iter().all(|cell| cell.bg == added_bg),
        "added line background should fill the full backend row"
    );
    assert_eq!(added_row[6].symbol, "+");
    assert_eq!(added_row[6].fg, KCODER_UI_THEME.diff_added_fg);
    assert_eq!(added_row[6].bg, added_bg);
    assert!(
        added_row[4].modifier.contains(Modifier::DIM)
            && added_row[5].modifier.contains(Modifier::DIM),
        "line-number gutter cells should keep the dim modifier"
    );
}

#[test]
fn todo_write_status_renders_collapsed_preview() {
    let status = format_tool_status(
        "TodoWrite",
        "Todos have been modified successfully.\n\nPrevious todo count: 0\nCurrent todo count: 2\n- [pending] Inspect renderer (Inspecting renderer)\n- [in_progress] Patch TUI (Patching TUI)",
        false,
    );
    let msg = make_msg(MessageRole::System, &status);
    let rendered = render_message(&msg, None, false, false, false, "")
        .into_iter()
        .flat_map(|line| line.spans.into_iter().map(|span| span.content.to_string()))
        .collect::<String>();

    assert!(rendered.contains("tool TodoWrite"));
    assert!(rendered.contains("Todos have been modified successfully"));
    assert!(!rendered.contains("Updated Plan"));
    assert!(!rendered.contains("□ Inspect renderer"));
}

#[test]
fn tool_diff_strips_terminal_control_sequences() {
    let diff = format_tool_diff(
        "edit",
        "Edited \x1b]0;title\x07src/lib.rs\n```diff\n-\x1b[31mold\x1b[0m\n+new\x08\n```",
    )
    .expect("diff should be extracted");

    assert!(diff.contains("-old"));
    assert!(diff.contains("+new"));
    assert!(!diff.contains('\x1b'));
    assert!(!diff.contains("[31m"));
    assert!(!diff.contains('\x08'));
    assert!(!diff.contains("title"));
}

#[test]
fn push_message_sanitizes_terminal_controls() {
    let mut app = ReplApp::default();

    app.push_message(MessageRole::System, "Error: \x1b[31mboom\x1b[0m\x07");

    assert_eq!(app.messages[0].text, "Error: boom ");
}

#[test]
fn literal_runtime_shaped_user_text_remains_visible() {
    for text in [
        "<system-reminder>literal request</system-reminder>",
        "[system] Trusted Orchestrate fleet delta literal",
    ] {
        assert!(!display_text_is_hidden_internal_context(text, true));
        assert!(!display_text_is_hidden_internal_context(text, false));
        assert!(!message_is_hidden_internal_context(&Message::assistant_text(text)));
        assert!(!message_is_hidden_internal_context(&Message::user_text(
            text
        )));
        assert!(message_is_hidden_internal_context(&Message::runtime_text(
            text
        )));
        let mut app = ReplApp::default();
        app.push_message(MessageRole::User, text);
        assert_eq!(app.messages.len(), 1);
        app.replace_transcript_from_history(&[
            Message::user_text(text),
            Message::runtime_text(text),
        ]);
        assert_eq!(app.messages.len(), 1);
        app.push_message(MessageRole::Assistant, text);
        assert_eq!(app.messages.len(), 2);
    }
}

#[test]
fn moa_reference_message_formats_label_and_body() {
    let text = format_moa_reference_message("minimax:MiniMax-M2.7", "  private advice\n", 2, 3);

    assert_eq!(
        text,
        "MoA reference 2/3 - minimax:MiniMax-M2.7\nprivate advice"
    );
}

#[test]
fn file_mentions_use_subsequence_fuzzy_matching_and_prefer_basename_hits() {
    let files = vec![
        "crates/kcoder_engine/src/lib.rs".to_string(),
        "docs/library-reference.md".to_string(),
        "src/long_background.rs".to_string(),
    ];

    let matches = fuzzy_file_candidates(&files, "lib", 10);
    assert_eq!(matches[0], "docs/library-reference.md");
    assert!(fuzzy_file_score("src/long_background.rs", "lbg").is_some());
    assert!(fuzzy_file_score("src/long_background.rs", "xyz").is_none());
}

#[test]
fn accepting_file_mention_replaces_only_active_fragment_and_escapes_spaces() {
    let mut app = ReplApp::default();
    app.input = "inspect @my f".to_string();
    app.cursor_grapheme_index = app.input.graphemes(true).count();
    app.mention_menu = Some(MentionMenu {
        replace_start: 8,
        replace_end: app.input.len(),
        candidates: vec!["my file.rs".to_string()],
        selected: 0,
    });

    app.accept_mention_selection();

    assert_eq!(app.input, "inspect @my\\ file.rs ");
    assert!(app.mention_menu.is_none());
}

fn subagent_test_lines_to_text(lines: &[Line<'_>]) -> String {
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
fn consecutive_blocking_subagents_share_one_group_panel() {
    let mut app = ReplApp::default();
    for index in 1..=3 {
        app.push_subagent_pending(
            format!("tool-{index}"),
            "spawn_agent".to_string(),
            serde_json::json!({
                "message": format!("inspect area {index}"),
                "run_in_background": false
            })
            .to_string(),
        );
    }

    assert_eq!(app.subagent_panels.len(), 1);
    let mut lines = app.render_transcript_range(0, app.messages.len(), 120);
    lines.extend(app.render_active_turn_lines(120));
    let rendered = subagent_test_lines_to_text(&lines);
    assert!(rendered.contains("Agent Swarm"));
    assert!(rendered.contains("001"));
    assert!(rendered.contains("002"));
    assert!(rendered.contains("003"));
    assert!(!rendered.contains("Running tool: spawn_agent"));
}

#[test]
fn association_progress_and_terminal_can_arrive_before_tool_use() {
    let mut app = ReplApp::default();
    assert!(!app.associate_subagent_panel("agent-early", "tool-early", false));
    assert!(!app.update_subagent_panel_progress(
        "agent-early",
        "Running read",
        Some("inspecting the renderer"),
        Some(2),
        Some(60),
    ));
    assert!(!app.finish_subagent_panel("agent-early", SubagentPhase::Completed, "Completed",));
    assert!(!app.finish_subagent_panel("agent-early", SubagentPhase::Failed, "late failure",));

    app.push_subagent_pending(
        "tool-early".to_string(),
        "spawn_agent".to_string(),
        serde_json::json!({"message": "inspect early events"}).to_string(),
    );

    let rendered = subagent_test_lines_to_text(&app.render_active_turn_lines(100));
    assert!(rendered.contains("Completed"));
    assert!(!rendered.contains("late failure"));
    assert!(rendered.contains("inspecting the renderer"));
    assert_eq!(app.subagent_panel_by_agent.get("agent-early"), Some(&1));
}

#[test]
fn promoted_subagent_updates_same_live_panel_and_terminal_state_wins() {
    let mut app = ReplApp::default();
    app.push_subagent_pending(
        "tool-1".to_string(),
        "spawn_agent".to_string(),
        serde_json::json!({"message": "inspect scrolling"}).to_string(),
    );
    assert!(app.associate_subagent_panel("agent-1", "tool-1", false));
    assert!(app.update_subagent_panel_progress(
        "agent-1",
        "Running bash",
        Some("capturing the latest frame"),
        Some(2),
        Some(60),
    ));
    app.flush_active_turn();
    let message_count = app.messages.len();

    assert!(app.promote_subagent_panel("agent-1"));
    assert_eq!(app.messages.len(), message_count);
    let mut promoted_lines = app.render_transcript_range(0, app.messages.len(), 100);
    promoted_lines.extend(app.render_active_turn_lines(100));
    let promoted = subagent_test_lines_to_text(&promoted_lines);
    assert!(promoted.contains("Background"));
    assert!(promoted.contains("capturing the latest frame"));

    assert!(app.finish_subagent_panel("agent-1", SubagentPhase::Completed, "Completed",));
    assert!(!app.update_subagent_panel_progress(
        "agent-1",
        "stale progress",
        None,
        Some(3),
        Some(60),
    ));
    let mut completed_lines = app.render_transcript_range(0, app.messages.len(), 100);
    completed_lines.extend(app.render_active_turn_lines(100));
    let completed = subagent_test_lines_to_text(&completed_lines);
    assert!(completed.contains("Completed"));
    assert!(!completed.contains("stale progress"));
}

#[test]
fn resumed_subagent_uses_a_new_panel_instead_of_reopening_history() {
    let mut app = ReplApp::default();
    app.push_subagent_pending(
        "tool-initial".to_string(),
        "spawn_agent".to_string(),
        serde_json::json!({"message": "first run"}).to_string(),
    );
    app.associate_subagent_panel("agent-1", "tool-initial", false);
    app.finish_subagent_panel("agent-1", SubagentPhase::Completed, "Completed");
    app.flush_active_turn();
    let old_message = app.messages.first().unwrap().text.clone();

    let resume_input =
        serde_json::json!({"agent_id": "agent-1", "message": "continue"}).to_string();
    app.push_tool_running(
        "tool-resume".to_string(),
        "SendMessage".to_string(),
        resume_input.clone(),
    );
    assert!(app.convert_running_tool_to_subagent_panel(
        "tool-resume".to_string(),
        "SendMessage".to_string(),
        resume_input,
    ));
    app.finish_subagent_tool_call(
        "tool-resume",
        &serde_json::json!({
            "agent_id": "agent-1",
            "status": "running",
            "queued": false
        })
        .to_string(),
        false,
    );

    assert_eq!(app.subagent_panels.len(), 2);
    assert_eq!(app.subagent_panel_by_agent.get("agent-1"), Some(&2));
    assert_eq!(app.messages.first().unwrap().text, old_message);
    let active = subagent_test_lines_to_text(&app.render_active_turn_lines(100));
    assert!(active.contains("Background"));
    assert!(active.contains("continue"));
}

#[test]
fn fast_continuation_buffers_terminal_until_send_message_panel_exists() {
    let mut app = ReplApp::default();
    app.push_subagent_pending(
        "tool-initial".to_string(),
        "spawn_agent".to_string(),
        serde_json::json!({"message": "first run"}).to_string(),
    );
    app.associate_subagent_panel("agent-1", "tool-initial", false);
    app.update_subagent_panel_progress(
        "agent-1",
        "Running",
        Some("old run still appears live because its terminal event was lost"),
        Some(2),
        Some(60),
    );

    assert!(!app.associate_subagent_panel("agent-1", "tool-resume", true));
    assert_eq!(
        app.subagent_panels.get(&1).unwrap().members[0].phase,
        SubagentPhase::Completed,
    );
    assert!(!app.update_subagent_panel_progress(
        "agent-1",
        "Writing response",
        Some("fast continuation result"),
        Some(1),
        Some(60),
    ));
    assert!(!app.finish_subagent_panel("agent-1", SubagentPhase::Completed, "Completed",));

    let input = serde_json::json!({"agent_id": "agent-1", "message": "continue"}).to_string();
    app.push_tool_running(
        "tool-resume".to_string(),
        "SendMessage".to_string(),
        input.clone(),
    );
    assert!(app.convert_running_tool_to_subagent_panel(
        "tool-resume".to_string(),
        "SendMessage".to_string(),
        input,
    ));

    let panel = app.subagent_panels.get(&2).unwrap();
    assert_eq!(panel.members[0].phase, SubagentPhase::Completed);
    assert_eq!(
        panel.members[0].latest_model_text,
        "fast continuation result"
    );
    assert_eq!(app.subagent_panel_by_agent.get("agent-1"), Some(&2));
}

#[test]
fn six_row_terminal_keeps_compact_swarm_status_visible() {
    let mut app = ReplApp::default();
    for index in 1..=3 {
        app.push_subagent_pending(
            format!("tool-{index}"),
            "spawn_agent".to_string(),
            serde_json::json!({"message": format!("task {index}")}).to_string(),
        );
    }
    for index in 1..=3 {
        app.associate_subagent_panel(&format!("agent-{index}"), &format!("tool-{index}"), false);
        app.finish_subagent_panel(
            &format!("agent-{index}"),
            SubagentPhase::Completed,
            "Completed",
        );
    }
    app.flush_active_turn();

    let rendered = app
        .tiny_terminal_subagent_status(40, 6)
        .expect("tiny terminal should expose compact swarm status");
    assert!(rendered.contains("Agent Swarm 3/3"), "{rendered}");
    assert!(rendered.contains("001✓"), "{rendered}");
    assert!(rendered.contains("002✓"), "{rendered}");
    assert!(rendered.contains("003✓"), "{rendered}");
}

#[test]
fn history_replay_rebuilds_consecutive_subagents_as_one_panel() {
    let calls = (1..=3)
        .map(|index| ContentBlock::ToolUse {
            id: format!("tool-{index}"),
            name: "spawn_agent".to_string(),
            input: serde_json::json!({"message": format!("inspect {index}")}),
        })
        .collect::<Vec<_>>();
    let results = (1..=3)
        .map(|index| ContentBlock::ToolResult {
            tool_use_id: format!("tool-{index}"),
            content: vec![ContentBlock::Text {
                text: serde_json::json!({
                    "agent_id": format!("agent-{index}"),
                    "status": "completed",
                    "result": format!("result-{index}")
                })
                .to_string(),
            }],
            is_error: Some(false),
        })
        .collect::<Vec<_>>();
    let messages = vec![
        Message::Assistant {
            content: calls,
            usage: None,
        },
        Message::User { content: results, origin: kcoder_types::MessageOrigin::Runtime },
    ];
    let mut app = ReplApp::default();

    app.replace_transcript_from_history(&messages);

    assert_eq!(app.subagent_panels.len(), 1);
    assert_eq!(app.messages.len(), 1);
    let rendered = subagent_test_lines_to_text(&app.render_transcript_range(0, 1, 120));
    assert!(rendered.contains("Agent Swarm"));
    assert!(rendered.contains("Completed. 3/3"));
    assert!(rendered.contains("result-3"));
    assert!(!rendered.contains("Tool succeeded: spawn_agent"));
}

#[test]
fn history_replay_keeps_queued_send_message_as_an_ordinary_tool() {
    let messages = vec![
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-message".to_string(),
                name: "SendMessage".to_string(),
                input: serde_json::json!({
                    "agent_id": "agent-running",
                    "message": "additional detail"
                }),
            }],
            usage: None,
        },
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-message".to_string(),
                content: vec![ContentBlock::Text {
                    text: serde_json::json!({
                        "agent_id": "agent-running",
                        "status": "queued",
                        "queued": true
                    })
                    .to_string(),
                }],
                is_error: Some(false),
            }],
        },
    ];
    let mut app = ReplApp::default();

    app.replace_transcript_from_history(&messages);

    assert!(app.subagent_panels.is_empty());
    let rendered =
        subagent_test_lines_to_text(&app.render_transcript_range(0, app.messages.len(), 100));
    assert!(!rendered.contains("Agent Swarm"));
    assert!(rendered.contains("SendMessage"));
}

#[test]
fn history_replay_keeps_promoted_agent_running_and_routable() {
    let messages = vec![
        Message::Assistant {
            content: vec![ContentBlock::ToolUse {
                id: "tool-bg".to_string(),
                name: "spawn_agent".to_string(),
                input: serde_json::json!({"message": "inspect in background"}),
            }],
            usage: None,
        },
        Message::User {
            origin: kcoder_types::MessageOrigin::Unknown,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "tool-bg".to_string(),
                content: vec![ContentBlock::Text {
                    text: serde_json::json!({
                        "agent_id": "agent-bg",
                        "status": "running",
                        "run_in_background": true
                    })
                    .to_string(),
                }],
                is_error: Some(false),
            }],
        },
    ];
    let mut app = ReplApp::default();

    app.replace_transcript_from_history(&messages);

    assert_eq!(app.subagent_panel_by_agent.get("agent-bg"), Some(&1));
    let running = subagent_test_lines_to_text(&app.render_transcript_range(0, 1, 100));
    assert!(running.contains("Background"));
    assert!(running.contains("Working... 0/1"));
    assert!(!running.contains("Completed"));

    assert!(app.finish_subagent_panel("agent-bg", SubagentPhase::Completed, "Completed",));
    let completed = subagent_test_lines_to_text(&app.render_transcript_range(0, 1, 100));
    assert!(completed.contains("Completed. 1/1"));
}

#[test]
fn turn_flush_keeps_live_background_panel_out_of_committed_messages() {
    let mut app = ReplApp::default();
    app.push_subagent_pending(
        "tool-bg".to_string(),
        "spawn_agent".to_string(),
        serde_json::json!({"message": "keep updating"}).to_string(),
    );
    app.associate_subagent_panel("agent-bg", "tool-bg", false);
    app.promote_subagent_panel("agent-bg");

    app.flush_active_turn();
    app.set_loading(false);

    assert!(app.messages.is_empty());
    assert!(app.active_turn.is_some());
    app.finish_subagent_panel("agent-bg", SubagentPhase::Completed, "Completed");
    app.flush_terminal_subagent_panel_if_idle();
    assert_eq!(app.messages.len(), 1);
    assert!(app.active_turn.is_none());
}

#[test]
fn native_scrollback_stops_before_replayed_running_panel() {
    let mut app = ReplApp::default();
    app.push_message(MessageRole::Assistant, "before");
    let mut panel = SubagentPanel::new(9);
    panel.add_pending(
        "tool-bg".to_string(),
        "still running".to_string(),
        SubagentDelivery::Background,
    );
    panel.associate("tool-bg", "agent-bg", SubagentDelivery::Background);
    panel.update_progress("agent-bg", "Running", None, Some(7), Some(60));
    app.push_message(MessageRole::System, panel.encode_message());
    app.push_message(MessageRole::Assistant, "after");

    assert_eq!(app.scrollback_commit_target(0), 1);

    panel.finish("agent-bg", SubagentPhase::Completed, "Completed");
    app.messages.replace_first(
        |message| panel_message_id(&message.text) == Some(9),
        DisplayMessage {
            role: MessageRole::System,
            text: panel.encode_message(),
        },
    );
    assert_eq!(app.scrollback_commit_target(0), 3);
}
