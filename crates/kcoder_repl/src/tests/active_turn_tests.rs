use super::*;
use crate::test_support::{
    CompactSummaryProvider, ENV_LOCK, EnvVarGuard, PendingCompactSummaryProvider, buffer_dump,
    buffer_find_row_containing, hyperlink_line_text, hyperlink_lines_to_text, lines_to_text,
    run_foreground_action_to_completion, test_engine, test_engine_with_default_tools,
    test_engine_with_provider, test_engine_with_settings, text_column_range,
};
use ratatui::backend::ClearType;
use ratatui::backend::WindowSize;
use ratatui::buffer::Cell;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

include!("active_turn_tests/support.rs");
include!("active_turn_tests/commands_session_compact.rs");
include!("active_turn_tests/goal_overlay.rs");
include!("active_turn_tests/terminal_surface.rs");
include!("active_turn_tests/queue_resume_composer.rs");
include!("active_turn_tests/status_layout_scrollback.rs");
include!("active_turn_tests/streaming_active_turn.rs");
include!("active_turn_tests/commands_cancel.rs");
include!("active_turn_tests/outline_navigation.rs");
