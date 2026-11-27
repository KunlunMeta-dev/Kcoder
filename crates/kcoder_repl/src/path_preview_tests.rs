//! Path-preview transcript isolation regression tests.

use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_path_preview_converts_to_transient_tui_event() {
        for path in [Some("src/main.rs".into()), None] {
            assert!(matches!(
                engine_event_to_app_event_for_generation(
                    EngineEvent::ToolPathPreview {
                        attempt_id: "attempt-1".into(),
                        id: "tool-1".into(),
                        path,
                    },
                    7
                ),
                Some(AppEvent::ToolPathPreview { generation: 7, .. })
            ));
        }
    }

    #[test]
    fn tool_path_preview_footer_and_reset_leave_transcript_untouched() {
        let mut app = ReplApp::default();
        let generation = app.path_previews.begin();
        app.path_previews.update(
            generation,
            "a".into(),
            "t".into(),
            Some("src/main.rs".into()),
        );
        let count = app.messages.len();
        assert_eq!(app.activity_presentation().label, "Preparing src/main.rs");
        assert_eq!(app.messages.len(), count);
        app.finish_turn_state();
        assert!(app.path_previews.label().is_none());
        let generation = app.path_previews.begin();
        app.path_previews.update(
            generation,
            "a".into(),
            "t".into(),
            Some("src/main.rs".into()),
        );
        app.replace_transcript_from_history(&[]);
        assert!(app.path_previews.label().is_none());
        app.reset_transcript_state_after_clear();
        app.path_previews
            .update(generation, "a".into(), "t".into(), Some("late".into()));
        assert!(app.path_previews.label().is_none());
    }
}
