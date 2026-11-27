use super::*;

#[test]
fn incomplete_write_denial_closes_its_real_preview_without_masking_unknown_effects() {
    let preview = kcoder_engine::WriteInputPreview {
        path: Some("owned/result.txt".into()),
        lines: vec!["partial draft".into()],
        first_line_number: 1,
        total_lines: 1,
        complete: false,
    };
    let mut app = ReplApp::default();
    app.push_write_input_preview("owned-truncated-write".into(), preview.clone());
    assert!(app.active_turn.as_ref().unwrap().has_running_tool_entries());
    let terminal = engine_event_to_app_event(EngineEvent::ToolDenied {
        id: "owned-truncated-write".into(),
        name: "write".into(),
        reason: "Tool was not executed: arguments were rejected before dispatch.".into(),
    })
    .unwrap();
    let AppEvent::ToolResult {
        id,
        name,
        text,
        is_error,
        ..
    } = terminal
    else {
        panic!("the Engine terminal must use the normal tool-result ingestion path")
    };
    assert!(is_error);
    app.push_tool_done(id, name, text, is_error);
    assert!(!app.active_turn.as_mut().unwrap().settle_unobserved_tools());
    let visible = lines_to_text(&app.render_active_turn_lines(120));
    assert!(visible.contains("not executed"), "{visible}");
    assert!(!visible.contains("Tool result unknown"), "{visible}");
    assert!(!app.active_turn.as_ref().unwrap().has_running_tool_entries());

    // A different call that really has no terminal receipt keeps the existing
    // conservative outcome. The fix must not turn all missing results into denial.
    let mut unknown = ReplApp::default();
    unknown.push_write_input_preview("owned-receipt-missing".into(), preview);
    assert!(
        unknown
            .active_turn
            .as_mut()
            .unwrap()
            .settle_unobserved_tools()
    );
    let visible = lines_to_text(&unknown.render_active_turn_lines(120));
    assert!(visible.contains("Tool result unknown: write"), "{visible}");
    assert!(!visible.contains("not executed"), "{visible}");
}
