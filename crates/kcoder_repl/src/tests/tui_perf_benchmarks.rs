use super::*;

#[test]
#[ignore = "manual performance benchmark"]
fn render_long_transcript_benchmark() {
    let mut app = ReplApp {
        messages: (0..10_000)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}: {}", "x".repeat(80)),
            })
            .collect(),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            50_000,
            32,
            None,
        ),
        ..ReplApp::default()
    };
    let started = Instant::now();
    let row_budget =
        app.fullscreen_transcript_render_row_budget(app.transcript_viewport.viewport_rows());
    let start_idx = app.live_transcript_start_index(100, row_budget);
    let render_line_limit = row_budget.saturating_add(TRANSCRIPT_RENDER_OVERSCAN_ROWS);
    let lines = app.render_transcript_range_limited(
        start_idx,
        app.messages.len(),
        100,
        Some(render_line_limit),
    );
    let elapsed = started.elapsed();

    eprintln!(
        "render_long_transcript_benchmark: {} messages, {} lines, start_idx={}, elapsed={:?}",
        app.messages.len(),
        lines.len(),
        start_idx,
        elapsed
    );
    assert!(lines.len() <= render_line_limit);
}

#[test]
#[ignore = "manual performance benchmark"]
fn render_fullscreen_scrollbar_drag_benchmark() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        welcome_component_mounted: true,
        messages: (0..10_000)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}: {}", "x ".repeat(40)),
            })
            .collect(),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::at_line(0),
            50_000,
            32,
            None,
        ),
        ..ReplApp::default()
    };

    let width = 100;
    let height = 32;
    app.transcript_viewport
        .set_position(TranscriptScroll::to_bottom());
    let warm_started = Instant::now();
    let warm = app.render_fullscreen_transcript_window(width, height);
    let warm_elapsed = warm_started.elapsed();

    app.transcript_viewport
        .set_position(TranscriptScroll::at_line(0));
    let top_started = Instant::now();
    let top = app.render_fullscreen_transcript_window(width, height);
    let top_elapsed = top_started.elapsed();

    app.transcript_viewport
        .set_position(TranscriptScroll::at_line(top.total_rows / 2));
    let middle_started = Instant::now();
    let middle = app.render_fullscreen_transcript_window(width, height);
    let middle_elapsed = middle_started.elapsed();

    app.transcript_viewport
        .set_position(TranscriptScroll::to_bottom());
    let bottom_started = Instant::now();
    let bottom = app.render_fullscreen_transcript_window(width, height);
    let bottom_elapsed = bottom_started.elapsed();

    eprintln!(
        "render_fullscreen_scrollbar_drag_benchmark: messages={}, total_rows={}, warm={:?}/{} lines, top={:?}/{} lines, middle={:?}/{} lines, bottom={:?}/{} lines",
        app.messages.len(),
        top.total_rows,
        warm_elapsed,
        warm.lines.len(),
        top_elapsed,
        top.lines.len(),
        middle_elapsed,
        middle.lines.len(),
        bottom_elapsed,
        bottom.lines.len()
    );
    assert!(top.total_rows >= 10_000);
    assert!(top.lines.len() <= 512);
    assert!(middle.lines.len() <= 512);
    assert!(bottom.lines.len() <= 512);
}

#[test]
#[ignore = "manual performance benchmark"]
fn render_fullscreen_append_benchmark() {
    let mut app = ReplApp {
        fullscreen_surface: true,
        messages: (0..10_000)
            .map(|idx| DisplayMessage {
                role: MessageRole::Assistant,
                text: format!("message {idx}: {}", "x ".repeat(40)),
            })
            .collect(),
        transcript_viewport: TranscriptViewport::with_layout(
            TranscriptScroll::to_bottom(),
            50_000,
            32,
            None,
        ),
        ..ReplApp::default()
    };

    let width = 100;
    let height = 32;
    let _ = app.render_fullscreen_transcript_window(width, height);
    let started = Instant::now();
    let mut rendered_lines = 0usize;
    for idx in 0..100 {
        app.push_message(
            MessageRole::Assistant,
            format!("appended message {idx}: {}", "y ".repeat(40)),
        );
        rendered_lines = app
            .render_fullscreen_transcript_window(width, height)
            .lines
            .len();
    }
    let elapsed = started.elapsed();

    eprintln!(
        "render_fullscreen_append_benchmark: initial_messages=10000, appends=100, total={elapsed:?}, average={:?}, rendered_lines={rendered_lines}",
        elapsed / 100
    );
    assert!(rendered_lines <= 512);
}

/// Same-mode baseline for the Step reference plan; not a timing-sensitive CI test.
#[test]
#[ignore = "manual performance benchmark"]
fn step_reference_layout_sample_matrix() {
    for (width, height) in [(80, 24), (160, 48)] {
        for (name, body) in [
            ("short", "short reply".to_owned()),
            (
                "markdown",
                "## Heading\n\n**bold** 中文🙂 text\n\n- item\n".repeat(80),
            ),
            (
                "code",
                format!("```rust\n{}\n```", "let 值 = \"🙂\"; // code\n".repeat(160)),
            ),
        ] {
            let mut app = ReplApp {
                fullscreen_surface: true,
                ..ReplApp::default()
            };
            for idx in 0..10_000 {
                app.push_message(MessageRole::Assistant, format!("history {idx} 中文🙂"));
            }
            app.push_message(MessageRole::Assistant, body.clone());
            let first = Instant::now();
            let warm = app.render_fullscreen_transcript_window(width, height);
            let warm_us = first.elapsed().as_micros();
            let mut samples = Vec::new();
            let mut max_lines = warm.lines.len();
            for idx in 0..30 {
                app.append_streaming_text(&format!("delta {idx} 中文🙂\n"));
                let started = Instant::now();
                let rendered = app.render_fullscreen_transcript_window(width, height);
                samples.push(started.elapsed().as_micros());
                max_lines = max_lines.max(rendered.lines.len());
            }
            samples.sort_unstable();
            eprintln!(
                "P1_LAYOUT name={name} width={width} height={height} history=10000 body_bytes={} samples=30 warm_us={warm_us} p50_us={} p95_us={} max_lines={max_lines}",
                body.len(),
                samples[15],
                samples[28]
            );
            assert!(
                max_lines <= 512,
                "viewport budget must bound returned lines"
            );
        }
    }
}
