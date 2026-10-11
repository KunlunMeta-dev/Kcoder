#[test]
fn wrapped_display_line_count_counts_wrapped_rows_without_cloning_text() {
    let lines = vec![Line::from("abcdef"), Line::from("xy")];

    assert_eq!(wrapped_display_line_count(&lines, 3), 3);
}

#[test]
fn wrapped_display_line_count_treats_empty_lines_as_visible_rows() {
    let lines = vec![Line::from(""), Line::from("abcd")];

    assert_eq!(wrapped_display_line_count(&lines, 2), 3);
}

#[test]
fn scroll_render_window_keeps_only_visible_rows_with_overscan() {
    let lines = (0..200)
        .map(|index| Line::from(format!("line-{index:03}")))
        .collect::<Vec<_>>();

    let (window, adjusted_top) = scroll_render_window_lines(lines, 80, 100, 20, 10);
    let rendered = window
        .iter()
        .flat_map(|line| line.spans.iter())
        .map(|span| span.content.as_ref())
        .collect::<Vec<_>>()
        .join("\n");

    assert!(rendered.contains("line-090"));
    assert!(rendered.contains("line-129"));
    assert!(!rendered.contains("line-050"));
    assert!(!rendered.contains("line-170"));
    assert_eq!(adjusted_top, 10);
}

#[test]
fn scroll_render_window_preserves_offset_inside_wrapped_first_line() {
    let lines = vec![
        Line::from("abcdefghij"),
        Line::from("klmnopqrst"),
        Line::from("uvwxyz"),
    ];

    let (window, adjusted_top) = scroll_render_window_lines(lines, 5, 1, 2, 0);

    let first = window[0]
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect::<String>();
    assert_eq!(first, "abcdefghij");
    assert_eq!(adjusted_top, 1);
}

#[test]
fn clamp_render_top_prevents_blank_tail_when_estimate_is_too_large() {
    assert_eq!(clamp_render_top_to_content(50, 18, 10), 8);
    assert_eq!(clamp_render_top_to_content(50, 8, 10), 0);
}

#[test]
fn paragraph_line_count_matches_ratatui_render() {
    use ratatui::{Terminal as RatatuiTerminal, backend::TestBackend};

    let lines = vec![
        Line::from("hello world this is a long line with many words"),
        Line::from("https://example.com/a/very/long/url/path"),
        Line::from("这是一个比较长的中文句子用于测试换行"),
    ];
    let width = 16u16;
    let expected = paragraph_line_count(&lines, width);

    let backend = TestBackend::new(width, expected as u16 + 5);
    let mut terminal = RatatuiTerminal::new(backend).unwrap();
    terminal
        .draw(|f| {
            let area = f.area();
            let paragraph = Paragraph::new(Text::from(lines.clone())).wrap(Wrap { trim: false });
            f.render_widget(paragraph, area);
        })
        .unwrap();

    let buffer = terminal.backend().buffer().clone();
    let mut rendered_rows = 0;
    for y in 0..buffer.area.height {
        let row_nonempty = (0..buffer.area.width).any(|x| buffer[(x, y)].symbol() != " ");
        if row_nonempty {
            rendered_rows += 1;
        }
    }

    assert_eq!(
        expected, rendered_rows as usize,
        "paragraph_line_count must match actual TestBackend rendered rows"
    );
}

#[test]
fn transcript_visible_rows_match_paragraph_scroll() {
    let lines = vec![Line::from("alpha beta gamma"), Line::from("tail")];

    let rows = transcript_visible_rows_for_selection(&lines, 8, 3, 1);

    assert_eq!(rows, vec!["beta", "gamma", "tail"]);
}

#[test]
fn selected_text_from_visible_rows_copies_across_lines() {
    let rows = vec![
        "alpha beta".to_string(),
        String::new(),
        "gamma delta".to_string(),
    ];
    let selection = TranscriptSelection {
        anchor: TranscriptSelectionPoint { row: 0, column: 6 },
        head: TranscriptSelectionPoint { row: 2, column: 5 },
    };

    assert_eq!(
        selected_text_from_visible_rows(&rows, selection).as_deref(),
        Some("beta\n\ngamma")
    );
}

#[test]
fn selected_text_from_visible_rows_handles_reverse_drag_and_wide_text() {
    let rows = vec!["ab界cd".to_string()];
    let selection = TranscriptSelection {
        anchor: TranscriptSelectionPoint { row: 0, column: 5 },
        head: TranscriptSelectionPoint { row: 0, column: 2 },
    };

    assert_eq!(
        selected_text_from_visible_rows(&rows, selection).as_deref(),
        Some("界c")
    );
}

#[test]
fn wrapped_text_row_estimate_respects_cap() {
    let text = "a".repeat(10_000);

    assert_eq!(estimate_wrapped_text_rows_capped(&text, 1, 7), 7);
}

#[test]
fn event_batch_budget_prevents_redraw_starvation() {
    let started = Instant::now();

    assert!(event_batch_budget_exhausted(
        EVENT_BATCH_MAX_EVENTS,
        started,
        started
    ));
    assert!(event_batch_budget_exhausted(
        1,
        started,
        started + EVENT_BATCH_MAX_DURATION
    ));
    assert!(!event_batch_budget_exhausted(
        1,
        started,
        started + Duration::from_millis(1)
    ));
}

#[test]
fn review_row_budget_remains_bounded_for_long_transcripts() {
    let budget = transcript_render_row_budget(TranscriptScroll::at_line(0), 50_000, 24, 32);

    assert_eq!(budget, TRANSCRIPT_REVIEW_MAX_ROWS);
    assert!(budget < 20_000);
}

#[test]
fn fullscreen_scrolled_render_budget_caps_hot_scroll_work() {
    let app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            50_000,
            32,
            None,
        ),
        ..ReplApp::default()
    };

    let budget = app.fullscreen_transcript_render_row_budget(32);

    assert_eq!(
        budget,
        32 + TRANSCRIPT_RENDER_OVERSCAN_ROWS * FULLSCREEN_SCROLL_RENDER_OVERSCAN_MULTIPLIER
    );
    assert!(
        budget < TRANSCRIPT_REVIEW_MAX_ROWS,
        "scrolling should not rebuild the full review window on every frame"
    );
}

#[test]
fn fullscreen_scrollbar_drag_uses_tight_render_budget() {
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            50_000,
            32,
            None,
        ),
        ..ReplApp::default()
    };
    app.transcript_viewport.set_offset(0);

    let budget = app.fullscreen_transcript_render_row_budget(32);

    assert_eq!(budget, 64);
    assert!(budget < TRANSCRIPT_RENDER_OVERSCAN_ROWS);
}

#[test]
fn fullscreen_scrollbar_drag_active_keeps_tight_budget_after_deadline() {
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            50_000,
            32,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(0).is_none());

    let budget = app.fullscreen_transcript_render_row_budget(32);

    assert_eq!(budget, 64);
    assert_eq!(
        app.fullscreen_transcript_render_line_limit(budget, 32),
        Some(64)
    );
}

#[test]
fn scrollbar_fast_path_uses_live_content_rows_after_drag_release() {
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            1_200,
            20,
            None,
        ),
        ..ReplApp::default()
    };
    app.transcript_viewport.set_offset(0);

    assert_eq!(app.transcript_viewport.content_rows(), 1_200);
}

#[test]
fn ending_scrollbar_drag_clears_frozen_content_rows() {
    let mut app = ReplApp {
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            600,
            20,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(0).is_none());

    app.transcript_viewport.end_drag();

    assert!(!app.transcript_viewport.drag_active());
    assert_eq!(app.transcript_viewport.content_rows(), 600);
    assert!(!app.transcript_viewport.fast_path_active());
}

#[test]
fn fullscreen_scrollbar_drag_middle_renders_bounded_history_window() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(600),
            1_200,
            20,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        messages: (0..600)
            .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx:03}")))
            .collect(),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(10).is_none());

    let render = app.render_fullscreen_transcript_window(80, 20);
    let text = lines_to_plain_text(&render.lines);

    assert!(render.lines.len() <= 40);
    assert!(
        !text.contains("message 599"),
        "dragging in the middle should not render/scan the transcript tail:\n{text}"
    );
}

#[test]
fn fullscreen_scrollbar_drag_inside_long_message_renders_current_local_rows() {
    let long_message = (0..=180)
        .map(|idx| format!("long-message-line-{idx:03}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(90),
            220,
            12,
            Some(Rect::new(99, 0, 1, 20)),
        ),
        messages: vec![make_msg(MessageRole::Assistant, &long_message)].into(),
        ..ReplApp::default()
    };
    assert!(app.transcript_viewport.begin_drag(7).is_none());

    let render = app.render_fullscreen_transcript_window(80, 12);
    let (visible_lines, render_top) =
        scroll_render_window_lines(render.lines, 80, render.local_top, 12, 12);
    let text = lines_to_plain_text(&visible_lines);

    assert!(
        text.contains("long-message-line-090") || text.contains("long-message-line-091"),
        "dragging inside a long message should render near the current top instead of clamping to the message head:\n{text}"
    );
    assert!(
        !text.contains("long-message-line-000"),
        "dragging inside a long message should not stay visually stuck at the head:\n{text}"
    );
    assert!(render_top <= 12);
}

#[test]
fn fullscreen_wheel_scroll_inside_long_message_renders_current_local_rows() {
    let long_message = (0..=240)
        .map(|idx| format!("long-message-line-{idx:03}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(150),
            280,
            12,
            None,
        ),
        messages: vec![make_msg(MessageRole::Assistant, &long_message)].into(),
        ..ReplApp::default()
    };

    let render = app.render_fullscreen_transcript_window(80, 12);
    let (visible_lines, _) = scroll_render_window_lines(render.lines, 80, render.local_top, 12, 12);
    let text = lines_to_plain_text(&visible_lines);

    assert!(
        text.contains("long-message-line-150")
            || text.contains("long-message-line-151")
            || text.contains("long-message-line-152"),
        "wheel scrolling inside a long message should render near the requested row:\n{text}"
    );
    assert!(
        !text.contains("long-message-line-000"),
        "wheel scrolling should not clamp to the rendered message head:\n{text}"
    );
}

#[test]
fn fullscreen_scrolled_near_tail_uses_exact_rows_for_fully_rendered_collapsed_history() {
    let mut messages = (0..30)
        .map(|idx| {
            make_msg(
                MessageRole::System,
                &format!("[Tool use: read]\n{{\"path\":\"file-{idx}\"}}"),
            )
        })
        .collect::<Vec<_>>();
    messages.push(make_msg(MessageRole::Assistant, "tail answer"));
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(45),
            200,
            20,
            None,
        ),
        messages: messages.into(),
        ..ReplApp::default()
    };

    let render = app.render_fullscreen_transcript_window(80, 20);
    let text = lines_to_plain_text(&render.lines);

    assert!(
        text.contains("tools read x30"),
        "collapsed tool history should be rendered as a summary:\n{text}"
    );
    assert!(text.contains("tail answer"));
    assert!(
        render.total_rows <= 20,
        "when the fully rendered collapsed transcript fits, total rows should be exact, got {}",
        render.total_rows
    );
    assert_eq!(render.top, 0);
    assert_eq!(render.local_top, 0);
}

#[test]
fn fullscreen_near_tail_keeps_scrollbar_total_rows_stable_after_small_scroll_up() {
    let user = make_msg(MessageRole::User, "resume this session");
    let assistant = make_msg(
        MessageRole::Assistant,
        &(1..=92)
            .map(|idx| format!("resume-help-line-{idx:03}: 工具说明和用法"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            200,
            29,
            None,
        ),
        messages: vec![user, assistant].into(),
        ..ReplApp::default()
    };

    let tail = app.render_fullscreen_transcript_window(120, 29);
    assert!(tail.total_rows > 29);

    app.transcript_viewport
        .set_position(TranscriptScroll::at_line(
            tail.total_rows.saturating_sub(29).saturating_sub(3),
        ));
    app.transcript_viewport
        .set_live_content_rows(tail.total_rows);
    let near_tail = app.render_fullscreen_transcript_window(120, 29);

    assert_eq!(
        near_tail.total_rows, tail.total_rows,
        "small scroll-up from tail should keep the same exact total rows so the scrollbar thumb height stays stable"
    );
    assert!(near_tail.top < tail.top);
}

#[test]
fn fullscreen_long_tail_message_keeps_scrollbar_near_bottom_after_small_scroll_up() {
    let mut messages = (0..40)
        .map(|idx| make_msg(MessageRole::User, &format!("history message {idx:02}")))
        .collect::<Vec<_>>();
    messages.push(make_msg(
        MessageRole::Assistant,
        &(0..600)
            .map(|idx| format!("long-tail-line-{idx:03}"))
            .collect::<Vec<_>>()
            .join("\n"),
    ));
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            20,
            None,
        ),
        messages: messages.into(),
        ..ReplApp::default()
    };

    let tail = app.render_fullscreen_transcript_window(80, 20);
    app.transcript_viewport
        .set_live_content_rows(tail.total_rows);
    app.scroll_transcript_lines(-3);
    let near_tail = app.render_fullscreen_transcript_window(80, 20);
    let metrics = TranscriptScrollbarMetrics::new(near_tail.total_rows, 20, near_tail.top, 29);

    assert_eq!(
        near_tail.total_rows, tail.total_rows,
        "轻滚离开长消息尾部时，总行数不能因局部窗口偏移而膨胀"
    );
    assert_eq!(
        near_tail.top,
        tail.total_rows.saturating_sub(20).saturating_sub(3),
        "轻滚三行后应保持精确的尾部相对距离"
    );
    assert!(
        metrics.thumb_start.saturating_add(1) >= metrics.thumb_travel(),
        "轻滚三行后滑块仍应靠近轨道底部：{metrics:?}"
    );
}

#[test]
fn fullscreen_first_wheel_ticks_move_immediately_when_tail_row_estimate_is_high() {
    // Consecutive assistant chunks are rendered as continuations, while
    // the lightweight row index deliberately estimates each message in
    // isolation. This creates the estimate/actual mismatch that used to
    // swallow several wheel ticks at the bottom before jumping upward.
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            20,
            None,
        ),
        messages: (0..160)
            .map(|idx| make_msg(MessageRole::Assistant, &format!("chunk-{idx:03}")))
            .collect(),
        ..ReplApp::default()
    };

    let tail = app.render_fullscreen_transcript_window(80, 20);
    app.transcript_viewport
        .set_live_content_rows(tail.total_rows);

    app.scroll_transcript_lines(-3);
    let first = app.render_fullscreen_transcript_window(80, 20);
    app.scroll_transcript_lines(-3);
    let second = app.render_fullscreen_transcript_window(80, 20);

    let visible = |render: &FullscreenTranscriptRender| {
        let end = render.local_top.saturating_add(20).min(render.lines.len());
        lines_to_plain_text(&render.lines[render.local_top.min(end)..end])
    };
    assert_ne!(
        visible(&tail),
        visible(&first),
        "the first upward wheel tick should leave the visible tail"
    );
    assert_ne!(
        visible(&first),
        visible(&second),
        "each upward wheel tick should change the visible tail immediately"
    );
}

#[test]
fn fullscreen_scrolled_to_top_renders_earliest_history() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            5_000,
            20,
            None,
        ),
        messages: (0..1_500)
            .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx:03}")))
            .collect(),
        ..ReplApp::default()
    };

    let render = app.render_fullscreen_transcript_window(80, 20);
    let text = lines_to_plain_text(&render.lines);

    assert_eq!(render.top, 0);
    assert_eq!(render.local_top, 0);
    assert!(
        text.contains("message 000"),
        "top of fullscreen transcript must start from earliest history, rendered:\n{text}"
    );
    assert!(
        !text.contains("message 1499"),
        "top review window should not be the tail-only window, rendered:\n{text}"
    );
}

#[test]
fn fullscreen_tail_line_limit_keeps_latest_system_message() {
    let long_history = (0..260)
        .map(|idx| format!("very long old rendered line {idx:03}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        fullscreen_surface: true,
        welcome_component_mounted: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            15,
            None,
        ),
        messages: vec![
            make_msg(MessageRole::Assistant, &long_history),
            make_msg(MessageRole::User, "compact recent tail anchor"),
            make_msg(
                MessageRole::System,
                "Context compaction completed (1450 -> 1322 tokens).",
            ),
        ]
        .into(),
        ..ReplApp::default()
    };

    let lines = app.render_fullscreen_transcript_lines(78, 15);
    let text = lines_to_plain_text(&lines);

    assert!(
        text.contains("Context compaction completed (1450 -> 1322 tokens)."),
        "tail-following line limit must preserve the newest system message; rendered:\n{text}"
    );
}

#[test]
fn fullscreen_tail_backfills_collapsed_tools_to_fill_visible_rows() {
    for child in [false, true] {
        let mut app = ReplApp { fullscreen_surface: true, ..ReplApp::default() };
        if child {
            app.enter_agent_view("child".into(), "child".into());
        }
        app.messages = (0..100).map(|index| make_msg(
            MessageRole::Assistant, &format!("history-{index:03}"),
        )).collect::<Vec<_>>().into();
        for index in 0..350 {
            app.messages.push(make_msg(MessageRole::System, &format!("[Tool use: read] file-{index:03}")));
        }
        app.messages.push(make_msg(MessageRole::Assistant, "latest partial response"));
        let width = 80;
        let height = 60;
        let full = app.render_transcript_range_limited(0, app.messages.len(), width, None);
        assert!(paragraph_line_count(&full, width) > height);
        let tail = app.render_fullscreen_transcript_window(width, height);
        let rows = paragraph_line_count(&tail.lines, width);
        assert!(rows >= height, "还有较早正文时，尾部不能只绘制 {rows}/{height} 行 (child={child})");
        let rendered = transcript_visible_rows_for_selection(&tail.lines, width, height as u16, tail.local_top);
        let expected = transcript_visible_rows_for_selection(&full, width, height as u16, paragraph_line_count(&full, width) - height);
        assert_eq!(rendered, expected, "自动跟随必须与完整正文的真实尾部一致");
    }
}

#[test]
fn fullscreen_draw_after_resize_keeps_latest_system_message_visible() {
    use ratatui::{Terminal as RatatuiTerminal, backend::TestBackend};

    let long_history = (0..260)
        .map(|idx| format!("very long old rendered line {idx:03}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut app = ReplApp {
        fullscreen_surface: true,
        welcome_component_mounted: true,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            180,
            28,
            None,
        ),
        messages: vec![
            make_msg(MessageRole::Assistant, &long_history),
            make_msg(MessageRole::User, "compact recent tail anchor"),
            make_msg(
                MessageRole::System,
                "Context compaction completed (1450 -> 1322 tokens).",
            ),
        ]
        .into(),
        ..ReplApp::default()
    };
    app.observe_terminal_size(Size::new(100, 32));
    app.observe_terminal_resize(Size::new(80, 20));

    let width = 78u16;
    let height = 15u16;
    let lines = app.render_fullscreen_transcript_lines(width, usize::from(height));
    let line_count = paragraph_line_count(&lines, width);
    let top = app
        .transcript_viewport
        .resolve_top(line_count, usize::from(height));
    let (window, render_top) =
        scroll_render_window_lines(lines, width, top, usize::from(height), usize::from(height));

    let backend = TestBackend::new(width, height);
    let mut terminal = RatatuiTerminal::new(backend).unwrap();
    terminal
        .draw(|frame| {
            let paragraph = Paragraph::new(Text::from(window.clone()))
                .wrap(Wrap { trim: false })
                .scroll((render_top as u16, 0));
            frame.render_widget(paragraph, frame.area());
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let rendered = (0..buffer.area.height)
        .map(|y| {
            (0..buffer.area.width)
                .map(|x| buffer[(x, y)].symbol())
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("\n");

    assert!(
        rendered.contains("Context compaction completed"),
        "resize draw should keep the latest system message visible; rendered:\n{rendered}"
    );
}

#[test]
fn message_row_estimate_respects_cap_even_for_long_messages() {
    let message = make_msg(MessageRole::Assistant, &"x".repeat(10_000));

    assert_eq!(
        estimate_message_display_rows_capped(
            &message,
            1,
            9,
            is_collapsible_tool_message,
            TURN_DIVIDER_PREFIX,
        ),
        9
    );
}

#[test]
fn transcript_tail_window_limits_long_sessions_to_live_tail() {
    let messages = (0..400)
        .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx}")))
        .collect::<Vec<_>>();

    let start = transcript_tail_window_start(
        &messages,
        80,
        40,
        TRANSCRIPT_RENDER_MAX_MESSAGES,
        is_tool_run_message,
        is_collapsible_tool_message,
        TURN_DIVIDER_PREFIX,
    );

    assert!(start > 0);
    assert!(messages.len() - start <= TRANSCRIPT_RENDER_MAX_MESSAGES);
}

#[test]
fn live_transcript_start_always_uses_bounded_terminal_scrollback_tail() {
    let app = ReplApp {
        messages: (0..400)
            .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx}")))
            .collect(),
        scrollback_committed_until: 0,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    let start = app.live_transcript_start_index_for_end(80, 40, app.messages.len());

    assert!(start > 0);
    assert!(app.messages.len() - start <= TRANSCRIPT_RENDER_MAX_MESSAGES);
}

#[test]
fn render_line_limit_is_always_bounded_to_live_viewport() {
    let app = ReplApp::default();

    assert_eq!(
        app.transcript_render_line_limit(TRANSCRIPT_RENDER_MAX_ROWS),
        Some(TRANSCRIPT_RENDER_MAX_ROWS + TRANSCRIPT_RENDER_OVERSCAN_ROWS)
    );
}

#[test]
fn transcript_tail_window_backtracks_within_tool_run_for_summary_counts() {
    let mut messages = (0..50)
        .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx}")))
        .collect::<Vec<_>>();
    messages.extend(
        (0..220).map(|idx| make_msg(MessageRole::System, &format!("[Tool use: read] {idx}"))),
    );

    let start = transcript_tail_window_start(
        &messages,
        80,
        10,
        TRANSCRIPT_RENDER_MAX_MESSAGES,
        is_tool_run_message,
        is_collapsible_tool_message,
        TURN_DIVIDER_PREFIX,
    );

    assert!(
        start >= 50,
        "backtrack should remain bounded to the tool run"
    );
    assert!(is_collapsible_tool_message(&messages[start]));
}

#[test]
fn scrollback_commit_target_catches_up_to_stable_transcript() {
    assert_eq!(transcript_scrollback_commit_target(8, 0), 8);

    let total = TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES + 80;
    let first = transcript_scrollback_commit_target(total, 0);
    assert_eq!(first, total);

    let second = transcript_scrollback_commit_target(total, first);
    assert_eq!(second, total);
    assert_eq!(transcript_scrollback_commit_target(total, second), total);
}

#[test]
fn tail_live_transcript_start_respects_committed_scrollback() {
    let app = ReplApp {
        messages: (0..80)
            .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx}")))
            .collect(),
        scrollback_committed_until: 50,
        ..ReplApp::default()
    };

    let start = app.live_transcript_start_index(80, 1000);

    assert!(start >= app.scrollback_committed_until);
}

#[test]
fn scrolled_transcript_can_replay_committed_history_from_memory() {
    let app = ReplApp {
        messages: (0..80)
            .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx}")))
            .collect(),
        scrollback_committed_until: 50,
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            0,
            0,
            None,
        ),
        ..ReplApp::default()
    };

    let start = app.live_transcript_start_index(80, 1000);

    assert_eq!(start, 0);
}

#[test]
fn live_transcript_start_index_uses_full_budget_after_reset() {
    let mut app = ReplApp::default();
    app.messages.clear();

    let big_message = "x".repeat(500);
    app.push_message(MessageRole::Assistant, big_message);
    app.transcript_viewport
        .set_position(TranscriptScroll::to_bottom());

    // Simulate a stale small last_line_count that would constrain the budget.
    app.transcript_viewport.set_live_content_rows(5);
    let start_with_stale_budget = app.live_transcript_start_index(40, 20);

    // Simulate TurnFinished resetting the baseline for tail users.
    app.transcript_viewport.invalidate_content_layout();
    let start_after_reset = app.live_transcript_start_index(40, TRANSCRIPT_RENDER_MAX_ROWS);

    assert!(
        start_after_reset <= start_with_stale_budget,
        "reset baseline must select an earlier (or equal) start index"
    );
    assert_eq!(
        start_after_reset, 0,
        "full budget should include all messages"
    );
}

#[test]
fn desired_height_stays_compact_for_empty_idle_surface() {
    let mut app = ReplApp::default();

    let height = app.desired_height(100, 40);

    assert!(height < 32, "idle viewport should not reserve 32 rows");
    assert!(
        height >= 5,
        "composer, footer, and top gap need room"
    );
}

#[test]
fn desired_height_uses_rendered_rows_not_stale_last_line_count() {
    let mut app = ReplApp::default();
    let clean_height = app.desired_height(100, 40);

    app.transcript_viewport =
        TranscriptViewport::with_layout(TranscriptScroll::to_bottom(), 10_000, 30, None);
    let stale_height = app.desired_height(100, 40);

    assert_eq!(
        stale_height, clean_height,
        "stale rendered row count must not keep the live viewport artificially tall"
    );
}

#[test]
fn desired_height_grows_only_by_actual_status_rows_while_loading() {
    let mut app = ReplApp::default();

    let idle_height = app.desired_height(100, 40);
    app.is_loading = true;
    let loading_height = app.desired_height(100, 40);
    let (status_height, pending_height) = app.bottom_pane_stack_heights(100);

    assert_eq!(pending_height, 0);
    assert_eq!(status_height, 2);
    assert_eq!(
        loading_height,
        idle_height + status_height,
        "loading should add only the visible status row plus the standard spacer"
    );
    assert!(
        loading_height < 28,
        "loading viewport should stay compact until transcript/status content grows: {loading_height}"
    );
}

#[test]
fn desired_height_reserves_only_one_row_for_long_active_assistant_partial() {
    let mut app = ReplApp::default();
    let idle_height = app.desired_height(100, 40);

    app.append_streaming_text(
        (0..200)
            .map(|idx| format!("streaming partial line {idx}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    let streaming_height = app.desired_height(100, 40);
    let (status_height, pending_height) = app.bottom_pane_stack_heights(100);

    assert_eq!(pending_height, 0);
    assert_eq!(
        streaming_height,
        idle_height + status_height + 1,
        "active assistant text should reserve one live row without expanding to its full height"
    );
}

#[test]
fn desired_transcript_rows_cap_consolidated_live_turn_tail() {
    let mut app = ReplApp {
        messages: vec![make_msg(
            MessageRole::Assistant,
            &(0..200)
                .map(|idx| format!("consolidated live line {idx}"))
                .collect::<Vec<_>>()
                .join("\n"),
        )]
        .into(),
        is_loading: true,
        recent_turn_transcript_start: Some(0),
        ..ReplApp::default()
    };

    assert_eq!(app.transcript_desired_rows(100, 40), 6);
}

#[test]
fn desired_height_grows_for_unflushed_transcript_but_respects_terminal_height() {
    let mut app = ReplApp {
        messages: (0..60)
            .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx}")))
            .collect(),
        ..ReplApp::default()
    };

    let height = app.desired_height(100, 12);

    assert_eq!(height, 12);
}

#[test]
fn desired_height_can_grow_to_terminal_bottom_for_long_transcript() {
    let mut app = ReplApp {
        messages: (0..120)
            .map(|idx| make_msg(MessageRole::Assistant, &format!("message {idx}")))
            .collect(),
        ..ReplApp::default()
    };

    let height = app.desired_height(100, 50);

    assert_eq!(height, 50);
}

#[test]
fn inline_viewport_height_is_not_capped_below_available_terminal() {
    assert_eq!(max_inline_viewport_height(80), 80);
}

#[test]
fn terminal_resize_is_observed_without_committed_scrollback() {
    let mut app = ReplApp::default();
    app.observe_terminal_size(Size::new(80, 24));

    app.observe_terminal_resize(Size::new(100, 24));

    assert_eq!(app.scrollback_committed_until, 0);
}

#[test]
fn terminal_resize_is_observed_with_committed_scrollback() {
    let mut app = ReplApp {
        scrollback_committed_until: 12,
        ..ReplApp::default()
    };
    app.observe_terminal_size(Size::new(80, 24));

    app.observe_terminal_resize(Size::new(100, 24));

    assert_eq!(app.scrollback_committed_until, 12);
}

#[test]
fn terminal_resize_during_active_stream_does_not_force_finish_reflow() {
    let mut app = ReplApp {
        scrollback_committed_until: 12,
        ..ReplApp::default()
    };
    app.observe_terminal_size(Size::new(80, 24));
    app.append_streaming_text("streaming answer");

    app.observe_terminal_resize(Size::new(100, 24));
    app.flush_active_turn();

    assert!(app.active_turn.is_none());
}
#[test]
fn review_of_active_stream_keeps_visible_content_when_more_text_arrives() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    app.push_message(MessageRole::User, "stream a long reply");
    app.append_streaming_text(
        (1..=100)
            .map(|i| format!("live-line-{i:03}\n"))
            .collect::<String>(),
    );
    app.transcript_viewport.begin_frame(Rect::new(0, 0, 80, 20));
    let tail = app.render_fullscreen_transcript_window(80, 20);
    app.transcript_viewport
        .commit_render(tail.total_rows, tail.top);
    app.scroll_transcript_lines(-3);
    let before = app.render_fullscreen_transcript_window(80, 20);
    app.transcript_viewport
        .commit_render(before.total_rows, before.top);
    let visible_before =
        transcript_visible_rows_for_selection(&before.lines, 80, 20, before.local_top);
    assert!(
        visible_before
            .iter()
            .any(|line| line.contains("live-line-090")),
        "回看不能漏绘 active 正文：{visible_before:?}"
    );
    app.append_streaming_text("live-line-101\nlive-line-102\n");
    let after = app.render_fullscreen_transcript_window(80, 20);
    let visible_after =
        transcript_visible_rows_for_selection(&after.lines, 80, 20, after.local_top);
    assert_eq!(visible_before, visible_after);
    assert!(!app.transcript_viewport.is_at_tail());
}
#[test]
fn queued_stream_delta_cannot_erase_unpainted_up_scroll() {
    let mut app = ReplApp::default();
    app.append_streaming_text("existing active text");
    app.transcript_viewport.begin_frame(Rect::new(0, 0, 80, 20));
    app.transcript_viewport.commit_render(100, 80);
    app.transcript_viewport.queue_wheel(ScrollDirection::Up);
    assert!(!app.transcript_viewport.is_at_tail());
    app.enqueue_streaming_text_delta("next token");
    assert!(!app.transcript_viewport.is_at_tail());
    assert_eq!(app.transcript_viewport.resolve_top(120, 20), 77);
}
#[test]
fn stream_flush_preserves_rendered_prefix_before_answer() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        ..ReplApp::default()
    };
    app.push_message(MessageRole::User, "test request");
    app.start_loading();
    app.append_streaming_thinking("thinking");
    app.push_tool_running(
        "tool".into(),
        "bash".into(),
        "{\"command\":\"echo output\"}".into(),
    );
    app.push_tool_done("tool".into(), "bash".into(), "output\n".repeat(420), false);
    app.append_streaming_text(format!(
        "reply introduction\n\n{}",
        (1..=100)
            .map(|i| format!("live-line-{i:03}\n"))
            .collect::<String>()
    ));
    for _ in 0..4 {
        app.commit_streaming_text_tick();
    }
    let before = app
        .render_full_transcript_overlay_lines(80)
        .iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    app.flush_active_turn();
    app.consolidate_finished_assistant_stream();
    app.stop_loading();
    let after = app
        .render_full_transcript_overlay_lines(80)
        .iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    let before_index = before
        .iter()
        .position(|line| line.contains("live-line-001"))
        .unwrap();
    let after_index = after
        .iter()
        .position(|line| line.contains("live-line-001"))
        .unwrap();
    assert_eq!(
        before_index,
        after_index,
        "before={:?}\nafter={:?}",
        &before[..before_index],
        &after[..after_index]
    );
}

#[test]
fn fenced_stream_review_survives_completion() {
    for historical_messages in [0, 80] {
        let mut app = ReplApp {
            fullscreen_surface: true,
            ..ReplApp::default()
        };
        for i in 0..historical_messages {
            app.push_message(MessageRole::User, format!("old request {i}"));
            app.push_message(MessageRole::Assistant, "old reply\n\nsecond paragraph");
        }
        app.push_message(MessageRole::User, "test request");
        app.start_loading();
        app.append_streaming_thinking("thinking");
        app.push_tool_running(
            "tool".into(),
            "bash".into(),
            "{\"command\":\"echo output\"}".into(),
        );
        app.push_tool_done("tool".into(), "bash".into(), "output\n".repeat(420), false);
        for part in ["reply introduction\n", "\n", "second paragraph\n", "\n"] {
            app.append_streaming_text(part);
            app.commit_streaming_text_tick();
        }
        app.append_streaming_text(format!(
            "```text\n{}",
            (1..=100)
                .map(|i| format!("live-line-{i:03}\n"))
                .collect::<String>()
        ));
        app.transcript_viewport.begin_frame(Rect::new(0, 0, 80, 20));
        let tail = app.render_fullscreen_transcript_window(80, 20);
        app.transcript_viewport
            .commit_render(tail.total_rows, tail.top);
        app.scroll_transcript_lines(-3);
        let before = app.render_fullscreen_transcript_window(80, 20);
        app.transcript_viewport
            .commit_render(before.total_rows, before.top);
        let visible_before =
            transcript_visible_rows_for_selection(&before.lines, 80, 20, before.local_top);
        app.append_streaming_text("```\n\nfinished\n");
        for _ in 0..10 {
            app.commit_streaming_text_tick();
        }
        app.flush_active_turn();
        app.consolidate_finished_assistant_stream();
        app.stop_loading();
        let after = app.render_fullscreen_transcript_window(80, 20);
        let visible_after =
            transcript_visible_rows_for_selection(&after.lines, 80, 20, after.local_top);
        assert_eq!(
            visible_before, visible_after,
            "historical_messages={historical_messages}"
        );
    }
}
