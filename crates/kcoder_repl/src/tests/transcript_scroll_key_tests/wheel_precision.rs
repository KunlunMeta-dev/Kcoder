fn assert_wheel_review_matches_full_transcript(messages: Vec<DisplayMessage>, width: u16, expanded: bool) {
    let height = 12usize;
    let mut app = ReplApp {
        fullscreen_surface: true,
        welcome_component_mounted: true,
        messages: messages.into(),
        ..ReplApp::default()
    };
    app.set_tool_transcript_expanded(expanded);
    app.transcript_viewport
        .begin_frame(Rect::new(0, 0, width, height as u16));
    let mut full = app.render_transcript_range_limited(0, app.messages.len(), width, None);
    let mut welcome = app.fullscreen_welcome_lines(width, !full.is_empty());
    welcome.append(&mut full);
    let full = welcome;
    let total = paragraph_line_count(&full, width);
    let mut expected_top = total.saturating_sub(height);
    let tail = app.render_fullscreen_transcript_window(width, height);
    app.transcript_viewport.commit_render(tail.total_rows, tail.top);
    assert_eq!(
        transcript_visible_rows_for_selection(&tail.lines, width, height as u16, tail.local_top),
        transcript_visible_rows_for_selection(&full, width, height as u16, expected_top),
        "initial tail"
    );
    for direction in [ScrollDirection::Up, ScrollDirection::Down] {
        for event in 0..total {
            app.transcript_viewport.queue_wheel(direction);
            app.transcript_viewport.apply_pending_scroll();
            expected_top = match direction {
                ScrollDirection::Up => expected_top.saturating_sub(3),
                ScrollDirection::Down => (expected_top + 3).min(total.saturating_sub(height)),
            };
            let render = app.render_fullscreen_transcript_window(width, height);
            app.transcript_viewport.commit_render(render.total_rows, render.top);
            let actual = transcript_visible_rows_for_selection(
                &render.lines, width, height as u16, render.local_top,
            );
            let expected = transcript_visible_rows_for_selection(
                &full, width, height as u16, expected_top,
            );
            assert_eq!(actual, expected, "{direction:?} event {event}, expected row {expected_top}, virtual top {}, local top {}", render.top, render.local_top);
        }
    }
}

#[test]
fn wheel_precision_across_many_assistant_message_windows() {
    assert_wheel_review_matches_full_transcript(
        (0..180).map(|i| make_msg(MessageRole::Assistant, &format!("ROW-{i:03}"))).collect(),
        80,
        false,
    );
}

#[test]
fn wheel_precision_across_markdown_and_wrapped_message_windows() {
    let messages = (0..90).flat_map(|i| [
        make_msg(MessageRole::User, &format!("Task-{i:03}")),
        make_msg(MessageRole::Assistant, &format!("### Answer-{i:03}\n\n| Field | Value |\n| --- | --- |\n| Item | Value-{i:03} |\n\n```text\nCODE-{i:03}-A\nCODE-{i:03}-B\n```\n\n长段落-{i:03} 含有中文以及 word-aware wrapping to cross several visual rows.")),
    ]).collect();
    assert_wheel_review_matches_full_transcript(messages, 42, false);
}

#[test]
fn wheel_precision_across_collapsed_and_expanded_tool_runs() {
    for expanded in [false, true] {
        let messages = (0..40).flat_map(|i| [
            make_msg(MessageRole::User, &format!("Task-{i:03}")),
            make_msg(MessageRole::System, "[Tool use: read] file.txt"),
            make_msg(MessageRole::System, &format!("✓ Tool succeeded: read - OUTPUT-{i:03}\nline two\nline three")),
            make_msg(MessageRole::System, "[Tool use: bash] task"),
            make_msg(MessageRole::System, &format!("✗ Tool failed: bash - FAILURE-{i:03}\nreason")),
            make_msg(MessageRole::Assistant, &format!("Answer-{i:03}")),
        ]).collect();
        assert_wheel_review_matches_full_transcript(messages, 60, expanded);
    }
}
