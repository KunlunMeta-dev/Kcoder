use anyhow::{Context, Result};
use kcoder_config::Settings;
use kcoder_engine::{
    BackgroundJobEvent, DiscoveredModelGroup, EngineEvent, QueryEngine, TurnSteerError,
    TurnSteerSession, WriteInputPreview,
};
mod active_turn;
mod attachments;
mod background_hints;
mod clipboard_copy;
mod clipboard_image;
mod composer_navigation;
mod copy_view;
mod custom_terminal;
mod dialog_presenter;
mod diff_render;
mod events;
mod external_editor;
mod frame_rate_limiter;
mod frame_requester;
mod history_cell;
mod input_history;
mod insert_history;
mod key_hint;
mod line_truncation;
mod markdown;
mod message_blocks;
mod message_render;
mod motion;
mod navigation_render;
mod overlay_presenter;
mod overlays;
mod path_preview;
mod render;
mod render_cache;
mod repl_layout;
mod scrolling;
mod settings_inspector;
mod slash;
mod spinner;
mod startup_welcome;
mod stream_controller;
mod stream_table_holdback;
mod streaming_turn;
mod subagent_panel;
mod table_detect;
mod terminal_events;
mod terminal_glyphs;
mod terminal_hyperlinks;
mod terminal_modes;
mod terminal_palette;
mod terminal_probe;
mod terminal_title;
#[cfg(test)]
mod test_support;
mod text_caps;
mod text_formatting;
mod theme;
mod todo_status;
mod tool_format;
mod tool_transcript;
mod transcript_identity;
mod transcript_navigation;
mod transcript_outline;
mod transcript_reflow;
mod transcript_selection;
mod transcript_store;
mod transcript_viewport;
mod transcript_window;
mod turn_completion;
mod widgets;
mod windows_compat;
mod write_preview;
use active_turn::{ActiveCell, ActiveEntry, ToolStatus};
use attachments::{
    LocalImageAttachment, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES, SubmittedMessage,
    image_media_type, pasted_image_path,
};
use background_hints::{
    BackgroundJobHint, BackgroundJobHintState, BackgroundJobLifetimeHint,
    BackgroundJobProgressHint, background_status_group_label,
};
use clipboard_image::ClipboardImage;
use composer_navigation::*;
use crossterm::cursor::MoveTo;
use crossterm::event::{
    self, Event as CEvent, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent,
    MouseEventKind,
};
use crossterm::style::Print;
use custom_terminal::{Frame, Terminal};
use dialog_presenter::*;
use events::{
    APP_EVENT_CHANNEL_CAPACITY, AppEvent, AppEventSender, TuiPermissionPrompt, TuiUserQuestioner,
};
#[cfg(test)]
use events::{AppEventBackpressure, app_event_backpressure};
use frame_rate_limiter::{FrameRateLimiter, INTERACTION_MIN_FRAME_INTERVAL};
use frame_requester::FrameRequester;
use futures::StreamExt;
use input_history::{INPUT_HISTORY_MAX_ENTRIES, load_input_history_file};
#[cfg(test)]
use kcoder_permissions::PermissionRisk;
use kcoder_permissions::{PermissionDialogResult, PermissionResponse};
use kcoder_state::{
    Goal, GoalMode, GoalStatus, GoalVerificationKind, GoalVerifierSelection,
    PreparedTranscriptHistory, SessionMode, TaskDelivery, TaskKind, TaskStatus, TodoItem,
    TodoStatus, prepare_goal_objective,
};
#[cfg(test)]
use kcoder_tools::UserQuestionRequest;
use kcoder_tools::UserQuestionResponse;
use kcoder_types::{ContentBlock, DisplayMessage, Message, MessageRole, ReasoningEffort};
use message_blocks::{collect_tool_use_lookup, content_blocks_text};
use message_render::*;
use overlay_presenter::*;
use overlays::{
    ContextInspector, GoalReplacementDialog, HistorySearch, HistorySearchStatus, KeysOverlay,
    PermissionDialog, PermissionEditor, PickerAction, PickerOverlay, QuestionDialog,
    QuestionDialogState, SettingsInspector, SlashMenu, TranscriptOverlay,
};
use ratatui::{
    buffer::Cell,
    layout::{Position, Rect, Size},
    prelude::Backend,
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Widget, Wrap},
};
#[cfg(test)]
use render_cache::ToolRailPos;
use render_cache::{KeyedTranscriptBlockRenderCache, RenderCache};
use repl_layout::{
    BOTTOM_PANE_TOP_SPACER, ReplLayoutHeights, max_inline_viewport_height, split_repl_layout,
};
use scrolling::{ScrollDirection, TranscriptScroll};
use slash::{ContextBreakdown, SlashResult, parse_slash_input};
use spinner::{ActivityPhase, ActivitySnapshot, SpinnerState};
use startup_welcome::{StartupWelcomeInfo, render_startup_welcome, startup_welcome_info};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
#[cfg(unix)]
use std::io::Read;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::RwLock;
use std::time::{Duration, Instant, SystemTime};
use stream_controller::StreamController;
use subagent_panel::{
    SubagentDelivery, SubagentPanel, SubagentPhase, compact_panel_status, decode_panel_message,
    panel_message_id, render_panel_message,
};
use terminal_events::{TerminalEventController, spawn_terminal_event_reader};
use terminal_hyperlinks::{HyperlinkLine, annotate_web_urls};
use terminal_modes::zellij_multiplexer_detected;
use terminal_modes::{
    TerminalGuard, configure_tui_alternate_screen, flush_terminal_input_buffer,
    init_kcoder_terminal,
};
#[cfg(test)]
use text_caps::TUI_TRUNCATION_MARKER;
use text_caps::{
    ACTIVE_TOOL_INPUT_MAX_CHARS, ACTIVE_TURN_TEXT_MAX_CHARS, append_capped_tui_text,
    capped_tui_text,
};
use theme::KCODER_UI_THEME;
#[cfg(test)]
use todo_status::render_todo_status_lines;
use todo_status::{draw_todo_status, todo_status_height};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
#[cfg(test)]
use tool_format::{TOOL_PREVIEW_CHARS, format_tool_diff, format_tool_status, preview_tool_text};
use tool_format::{
    format_completed_tool_display, format_running_tool_activity, format_running_tool_detail,
    format_tool_use, is_agent_tool_name, sanitize_tui_text,
};
use tool_transcript::*;
use tracing::{debug, warn};
use transcript_reflow::TranscriptReflowState;
use transcript_selection::{
    TranscriptSelection, TranscriptSelectionPoint, render_transcript_selection_highlight,
    selected_text_from_visible_rows, transcript_visible_rows_for_selection,
};
pub use transcript_store::TranscriptStore;
#[cfg(test)]
use transcript_viewport::scrollbar_geometry as transcript_scrollbar_geometry;
use transcript_viewport::{
    ScrollbarCellFill as TranscriptScrollbarCellFill,
    ScrollbarCommand as TranscriptScrollbarCommand, ScrollbarMetrics as TranscriptScrollbarMetrics,
    TranscriptViewport, scrollbar_area as transcript_scrollbar_area,
    scrollbar_vertical_symbol as transcript_scrollbar_vertical_symbol,
};
use transcript_window::{
    TRANSCRIPT_RENDER_MAX_MESSAGES, TRANSCRIPT_RENDER_OVERSCAN_ROWS, TranscriptRowIndex,
    transcript_render_row_budget, transcript_scrollback_commit_target,
    transcript_tail_window_start,
};
#[cfg(test)]
use transcript_window::{
    TRANSCRIPT_RENDER_MAX_ROWS, TRANSCRIPT_REVIEW_MAX_ROWS,
    TRANSCRIPT_SCROLLBACK_FLUSH_MAX_MESSAGES, estimate_message_display_rows_capped,
    estimate_wrapped_text_rows_capped,
};
use turn_completion::TurnCompletionGuard;
use unicode_segmentation::UnicodeSegmentation;
use widgets::{
    ComposerWidget, FooterData, FooterHint, FooterWidget, Renderable, STATUS_INDICATOR_MAX_HEIGHT,
    StatusDetailsCapitalization, StatusIndicatorControls, StatusIndicatorData,
    StatusIndicatorWidget, composer_content_areas, composer_text_width,
    shortcut_overlay_lines_with_mode_switch,
};

// Internal domain modules preserve a single ReplApp owner.
mod app_state;
use app_state::*;
mod app_layout;
use app_layout::*;
mod app_activity;
mod app_background;
mod app_composer;
mod app_draw;
mod app_history;
mod app_keyboard;
mod app_lifecycle;
mod app_modals;
mod app_overlays;
mod app_queue;
mod app_selection;
mod app_transcript_render;
mod app_transcript_window;
mod goal_presentation;
use goal_presentation::*;
mod composer_helpers;
use composer_helpers::*;
mod event_dispatch;
use event_dispatch::*;
mod startup_messages;
use startup_messages::*;
mod background_events;
use background_events::*;
mod runtime_diagnostics;
use runtime_diagnostics::*;
mod scrollback_runtime;
use scrollback_runtime::*;
mod runtime_startup;
mod terminal_surface;
use terminal_surface::*;
mod runtime_loop;
use runtime_loop::*;
mod turn_scheduling;
use turn_scheduling::*;
mod goal_continuation;
use goal_continuation::*;
mod turn_tasks;
use turn_tasks::*;
mod terminal_actions;
use terminal_actions::*;
mod user_actions;
use user_actions::*;
mod session_restore;
use session_restore::*;
mod action_dispatch;
use action_dispatch::*;
mod app_events;
use app_events::*;
mod mouse_dispatch;
use mouse_dispatch::*;
mod slash_dispatch;
use slash_dispatch::*;
mod engine_events;
#[cfg(test)]
mod path_preview_tests;
use engine_events::*;
mod turn_execution;
use turn_execution::*;

pub use app_state::ReplApp;
pub use runtime_startup::run_repl_with_engine;

#[cfg(test)]
#[path = "tests/permission_editor_tests.rs"]
mod permission_editor_tests;

#[cfg(test)]
#[path = "tests/background_watcher_tests.rs"]
mod background_watcher_tests;

#[cfg(test)]
#[path = "tests/app_event_backpressure_tests.rs"]
mod app_event_backpressure_tests;

#[cfg(test)]
#[path = "tests/mouse_click_tests.rs"]
mod mouse_click_tests;

#[cfg(test)]
#[path = "tests/tui_perf_benchmarks.rs"]
mod tui_perf_benchmarks;

#[cfg(test)]
#[path = "tool_transcript/tool_summary_tests.rs"]
mod tool_summary_tests;

#[cfg(test)]
#[path = "tool_transcript/tool_rail_tests.rs"]
mod tool_rail_tests;

#[cfg(test)]
#[path = "tests/active_turn_tests.rs"]
mod active_turn_tests;

#[cfg(test)]
#[path = "tests/transcript_scroll_key_tests.rs"]
mod transcript_scroll_key_tests;

#[cfg(test)]
#[path = "tests/render_message_tests.rs"]
mod render_message_tests;
