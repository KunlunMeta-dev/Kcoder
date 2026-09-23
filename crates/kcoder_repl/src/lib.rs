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
use input_history::{INPUT_HISTORY_MAX_ENTRIES, load_input_history_file, save_input_history_file};
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
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};
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

/// Snapshot global `goal_pro` configuration into a new goal so mid-run configuration changes cannot affect existing goals.
pub(crate) fn goal_pro_verifier_selection(engine: &QueryEngine) -> GoalVerifierSelection {
    let goal_pro = engine.settings.read().unwrap().goal_pro.clone();
    GoalVerifierSelection {
        profile: non_empty_setting(goal_pro.verifier_profile),
        provider: non_empty_setting(goal_pro.verifier_provider),
        model: non_empty_setting(goal_pro.verifier_model),
        verifier_panel: kcoder_config::normalize_goal_pro_verifier_panel(goal_pro.verifier_models),
        verifier_max_turns: goal_pro.verifier_max_turns.max(1),
        completion_rejection_limit: Some(goal_pro.completion_rejection_limit.max(1)),
        verification: goal_pro.verification,
    }
}

fn non_empty_setting(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

const SPINNER_INTERVAL_MS: u64 = 80;
const COMMIT_TICK_INTERVAL_MS: u64 = 320;
const STREAM_TEXT_PRESENTATION_INTERVAL_MS: u64 = 67;
const STREAM_TEXT_SMOOTH_GRAPHEMES_PER_TICK: usize = 32;
const STREAM_TEXT_CATCH_UP_PENDING_GRAPHEMES: usize = 384;
const STREAM_TEXT_CATCH_UP_GRAPHEMES_PER_TICK: usize = 192;
const STREAM_SMOOTH_COMMIT_SOURCE_LINES: usize = 1;
const STREAM_CATCH_UP_QUEUE_DEPTH_LINES: usize = 8;
const STREAM_CATCH_UP_COMMIT_SOURCE_LINES: usize = 8;
/// Maximum transcript height retained for the current streaming turn in inline mode.
const INLINE_ACTIVE_TRANSCRIPT_MAX_ROWS: usize = 6;
const DEBUG_STARTUP_A_LINES_ENV: &str = "KCODER_TUI_DEBUG_STARTUP_A_LINES";
const DEBUG_STARTUP_A_LINES_MAX: usize = 5_000;
/// Maximum number of queued events to coalesce before giving the renderer a
/// chance to flush a frame. Without this, a fast streaming provider can keep
/// the channel non-empty indefinitely and starve redraw until a resize event.
const EVENT_BATCH_MAX_EVENTS: usize = 128;
/// Time budget for one event coalescing pass. This is deliberately below the
/// frame-rate cap so streaming can stay smooth without making the UI wait for
/// the event queue to become completely empty.
const EVENT_BATCH_MAX_DURATION: Duration = Duration::from_millis(8);
/// Prevent fast-returning `/goal` turns from hot-looping and flooding the
/// transcript when the model has not marked the objective complete or blocked.
const GOAL_CONTINUATION_COOLDOWN: Duration = Duration::from_millis(1_500);
/// Scrolling should keep several screens of context around the viewport, but
/// dragging a scrollbar must not rebuild the large review window on every
/// mouse move.
const FULLSCREEN_SCROLL_RENDER_OVERSCAN_MULTIPLIER: usize = 6;
const FULLSCREEN_SCROLL_RENDER_MAX_ROWS: usize = 1_000;
/// Near the live tail, a small skipped prefix is cheap to render exactly and
/// keeps the scrollbar thumb from jumping between exact tail rows and the
/// coarser row index estimate.
const FULLSCREEN_EXACT_TAIL_PREFIX_MAX_MESSAGES: usize = 32;
/// Enable a time-bounded press-again interaction for idle Ctrl+C exits.
const DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED: bool = true;
const QUIT_SHORTCUT_WINDOW: Duration = Duration::from_secs(1);
const TRANSIENT_STATUS_TTL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReasoningShortcutDirection {
    Lower,
    Raise,
}

impl ReasoningShortcutDirection {
    fn bound_message(self, effort: &ReasoningEffort) -> String {
        let label = reasoning_effort_sentence_label(effort);
        match self {
            Self::Lower => format!("Reasoning is already at the lowest level ({label})."),
            Self::Raise => format!("Reasoning is already at the highest level ({label})."),
        }
    }
}

fn reasoning_shortcut_choices() -> [ReasoningEffort; 5] {
    [
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::XHigh,
    ]
}

fn reasoning_effort_sentence_label(effort: &ReasoningEffort) -> String {
    match effort {
        ReasoningEffort::XHigh => "extra high".to_string(),
        ReasoningEffort::Custom(value) => value.clone(),
        _ => effort.as_str().to_string(),
    }
}

fn reasoning_shortcut_anchor(current: Option<&ReasoningEffort>) -> ReasoningEffort {
    let configured = current.cloned().unwrap_or(ReasoningEffort::Medium);
    if reasoning_shortcut_choices().contains(&configured) {
        configured
    } else {
        ReasoningEffort::Medium
    }
}

fn next_reasoning_effort(
    current: &ReasoningEffort,
    direction: ReasoningShortcutDirection,
) -> Option<ReasoningEffort> {
    let choices = reasoning_shortcut_choices();
    let current_index = choices.iter().position(|choice| choice == current)?;
    match direction {
        ReasoningShortcutDirection::Lower => current_index
            .checked_sub(1)
            .and_then(|index| choices.get(index))
            .cloned(),
        ReasoningShortcutDirection::Raise => choices.get(current_index + 1).cloned(),
    }
}

fn model_footer_label(model: &str, effort: Option<&ReasoningEffort>) -> String {
    match effort {
        Some(ReasoningEffort::None) | None => model.to_string(),
        Some(effort) => format!("{model} {}", effort.as_str()),
    }
}

fn shell_command_from_prompt(text: &str) -> Option<String> {
    text.trim_start()
        .strip_prefix('!')
        .map(|command| command.trim().to_string())
}

fn is_ctrl_c_key(key: &KeyEvent) -> bool {
    let altgr = key_hint::is_altgr(key.modifiers);
    (key_hint::ctrl(KeyCode::Char('c')).is_press(*key)
        || matches!(key.code, KeyCode::Char(c) if c.eq_ignore_ascii_case(&'c'))
            && key.modifiers.contains(KeyModifiers::CONTROL))
        && !altgr
}

fn is_suspend_key(key: &KeyEvent) -> bool {
    let altgr = key_hint::is_altgr(key.modifiers);
    key_hint::ctrl(KeyCode::Char('z')).is_press(*key) && !altgr
}

fn is_transcript_overlay_shortcut(key: &KeyEvent) -> bool {
    let altgr = key_hint::is_altgr(key.modifiers);
    !altgr && key_hint::ctrl(KeyCode::Char('t')).is_press(*key)
}

fn is_tool_transcript_toggle_shortcut(key: &KeyEvent) -> bool {
    let altgr = key_hint::is_altgr(key.modifiers);
    !altgr && key_hint::alt(KeyCode::Char('t')).is_press(*key)
}

/// Pastes longer than this collapse into a `[Pasted Content N chars]`
/// placeholder in the composer (the full text is stored and expanded on
/// submit), so big pastes never blow up the input area.
const LARGE_PASTE_CHAR_THRESHOLD: usize = 300;
const PERMISSION_OPTION_RESPONSES: [PermissionResponse; 7] = [
    PermissionResponse::AllowOnce,
    PermissionResponse::AllowAlways,
    PermissionResponse::AllowForSession,
    PermissionResponse::DenyOnce,
    PermissionResponse::DenyAlways,
    PermissionResponse::DenyForSession,
    PermissionResponse::Edit,
];
const QUESTION_DIALOG_DEFAULT_VISIBLE_OPTIONS: usize = 5;
/// Small transcript scroll step used for terminal alternate-scroll key events.
const TRANSCRIPT_SCROLL_LINES: i32 = 3;
/// Maximum number of follow-up user messages held while a turn is running.
const USER_MESSAGE_QUEUE_MAX: usize = 64;
const USER_SHELL_COMMAND_HELP_TITLE: &str = "Prefix a command with ! to run it locally";
const USER_SHELL_COMMAND_HELP_HINT: &str = "Example: !ls";

#[derive(Debug, Clone)]
struct PendingBackgroundFollowup {
    /// One id per event, same order. Cron-originated entries use an empty id
    /// and always survive validation.
    ids: Vec<String>,
    events: Vec<String>,
    summary: String,
}

impl PendingBackgroundFollowup {
    /// Drop queued events whose sub-agent no longer exists or no longer
    /// triggers a follow-up (for example after `close_agent`). Cron entries
    /// carry an empty id and always stay.
    fn retain_followup_tasks(&mut self, engine: &QueryEngine) {
        let mut ids = Vec::with_capacity(self.ids.len());
        let mut events = Vec::with_capacity(self.events.len());
        for (id, event) in self.ids.drain(..).zip(self.events.drain(..)) {
            if id.is_empty() || background_followup_key_is_live(engine, &id) {
                ids.push(id);
                events.push(event);
            }
        }
        self.ids = ids;
        self.events = events;
        self.summary = self.events.join(" ");
    }
}

#[derive(Debug, Clone)]
struct QueuedUserMessage {
    model_message: Message,
    display_message: Message,
    restore_text: String,
    local_image_attachments: Vec<LocalImageAttachment>,
    remote_image_urls: Vec<String>,
    pending_pastes: Vec<(String, String)>,
    action: QueuedInputAction,
}

#[derive(Debug, Clone)]
struct PendingTurnSteer {
    id: u64,
    message: QueuedUserMessage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueuedInputAction {
    Plain,
    Slash,
    RunShell,
}

#[derive(Debug, Clone)]
enum QueuedTurnInput {
    User {
        model_message: Message,
        display_message: Message,
    },
    Slash {
        command: String,
    },
    Shell {
        command: String,
    },
}

impl QueuedUserMessage {
    fn from_model_message(model_message: Message) -> Self {
        let restore_text = editable_user_message_text(&model_message);
        Self {
            display_message: model_message.clone(),
            model_message,
            restore_text,
            local_image_attachments: Vec::new(),
            remote_image_urls: Vec::new(),
            pending_pastes: Vec::new(),
            action: QueuedInputAction::Plain,
        }
    }

    fn from_submitted(model_message: Message, submitted: &SubmittedMessage) -> Self {
        Self {
            display_message: Message::user_text(submitted.visible_text.clone()),
            model_message,
            restore_text: submitted.visible_text.clone(),
            local_image_attachments: submitted.images.clone(),
            remote_image_urls: submitted.remote_image_urls.clone(),
            pending_pastes: submitted.pending_pastes.clone(),
            action: QueuedInputAction::Plain,
        }
    }

    fn from_shell_prompt(history_text: String) -> Self {
        Self {
            display_message: Message::user_text(history_text.clone()),
            model_message: Message::user_text(history_text.clone()),
            restore_text: history_text,
            local_image_attachments: Vec::new(),
            remote_image_urls: Vec::new(),
            pending_pastes: Vec::new(),
            action: QueuedInputAction::RunShell,
        }
    }

    fn from_slash_command(command: String) -> Self {
        Self {
            display_message: Message::user_text(command.clone()),
            model_message: Message::user_text(command.clone()),
            restore_text: command,
            local_image_attachments: Vec::new(),
            remote_image_urls: Vec::new(),
            pending_pastes: Vec::new(),
            action: QueuedInputAction::Slash,
        }
    }

    fn into_turn_input(self) -> QueuedTurnInput {
        match self.action {
            QueuedInputAction::Plain => QueuedTurnInput::User {
                model_message: self.model_message,
                display_message: self.display_message,
            },
            QueuedInputAction::Slash => QueuedTurnInput::Slash {
                command: self.restore_text,
            },
            QueuedInputAction::RunShell => QueuedTurnInput::Shell {
                command: shell_command_from_prompt(&self.restore_text).unwrap_or_default(),
            },
        }
    }
}

impl From<Message> for QueuedUserMessage {
    fn from(model_message: Message) -> Self {
        Self::from_model_message(model_message)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveTurnRenderCacheKey {
    active_render_revision: u64,
    active_tools_expanded: bool,
    tool_transcript_expanded: bool,
    render_markdown: bool,
    code_theme: String,
    width: u16,
    tool_summary_indicator: &'static str,
}

#[derive(Debug, Clone)]
struct ActiveTurnRenderCache {
    key: ActiveTurnRenderCacheKey,
    lines: Vec<Line<'static>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FullscreenTranscriptRenderCacheKey {
    width: u16,
    row_budget: usize,
    render_budget: usize,
    messages_len: usize,
    messages_epoch: u64,
    transcript_scroll: TranscriptScroll,
    active_render_revision: u64,
    active_display_rows: usize,
    active_tools_expanded: bool,
    tool_transcript_expanded: bool,
    render_markdown: bool,
    code_theme: String,
    welcome_info: Option<StartupWelcomeInfo>,
    startup_idle_surface_active: bool,
    scrollbar_fast_path_active: bool,
    scrollbar_drag_active: bool,
    tool_summary_indicator: &'static str,
    subagent_animation_frame: u8,
}

#[derive(Debug, Clone)]
struct FullscreenTranscriptRenderCache {
    key: FullscreenTranscriptRenderCacheKey,
    render: FullscreenTranscriptRender,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OverlayKind {
    Permission,
    PermissionEditor,
    Question,
    GoalReplacement,
    HistorySearch,
    ResumeSession,
    ContextInspector,
    SettingsInspector,
    Keys,
    Transcript,
    Outline,
    Copy,
    Picker,
    SideQuestion,
}

#[derive(Debug)]
enum SideQuestionStatus {
    Loading,
    Answered(String),
    Failed(String),
}

#[derive(Debug)]
struct SideQuestionOverlay {
    id: u64,
    question: String,
    status: SideQuestionStatus,
    scroll: u16,
    cancel: CancellationToken,
    started_at: Instant,
}

#[derive(Debug, Clone)]
struct MentionMenu {
    replace_start: usize,
    replace_end: usize,
    candidates: Vec<String>,
    selected: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct ResumeSessionEntry {
    pub(crate) session_id: String,
    pub(crate) path: PathBuf,
    pub(crate) message_count: usize,
    pub(crate) preview: Option<String>,
}

const RESUME_TRANSCRIPT_INITIAL_MESSAGES: usize = TRANSCRIPT_RENDER_MAX_MESSAGES * 2;

#[derive(Debug)]
struct DeferredResumedTranscript {
    history: PreparedTranscriptHistory,
    /// Number of DisplayMessages occupied by the transformed resumed tail; later entries were appended after resume.
    loaded_display_len: usize,
}

#[derive(Debug, Clone)]
struct ResumeSessionPicker {
    entries: Vec<ResumeSessionEntry>,
    selected: usize,
    filter: String,
}

#[derive(Default)]
enum TurnState {
    #[default]
    Idle,
    Starting {
        handle: JoinHandle<()>,
        cancel: CancellationToken,
    },
    Running {
        handle: JoinHandle<()>,
        cancel: CancellationToken,
    },
    Finishing {
        handle: JoinHandle<()>,
    },
}

impl TurnState {
    fn is_active(&self) -> bool {
        !matches!(self, Self::Idle)
    }

    fn cancel_flag(&self) -> Option<&CancellationToken> {
        match self {
            Self::Starting { cancel, .. } | Self::Running { cancel, .. } => Some(cancel),
            Self::Idle | Self::Finishing { .. } => None,
        }
    }
}

fn recover_read_lock<'a, T>(lock: &'a RwLock<T>, name: &str) -> std::sync::RwLockReadGuard<'a, T> {
    match lock.read() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!(lock = name, "recovering poisoned read lock");
            poisoned.into_inner()
        }
    }
}

#[cfg(test)]
fn composer_height_for_width(app: &ReplApp, width: u16) -> u16 {
    composer_height_for_width_with_limit(app, width, None)
}

fn composer_height_for_width_with_limit(
    app: &ReplApp,
    width: u16,
    max_composer_height: Option<u16>,
) -> u16 {
    let input_content_width = composer_text_width(width);
    let wrapped_rows = app.wrap_composer_display_rows(input_content_width);
    let desired_visible_rows = wrapped_rows
        .len()
        .max(MIN_COMPOSER_ROWS as usize)
        .min(usize::from(u16::MAX)) as u16;
    let mut remote_rows = app
        .remote_image_urls
        .len()
        .min(usize::from(u16::MAX))
        .try_into()
        .unwrap_or(u16::MAX);
    if let Some(height) = max_composer_height
        && remote_rows > 0
    {
        remote_rows = remote_rows.min(height.saturating_sub(4));
    }
    let fixed_rows = remote_rows
        .saturating_add(u16::from(remote_rows > 0))
        .saturating_add(2);
    let max_visible_rows = max_composer_height
        .map(|height| height.saturating_sub(fixed_rows).max(MIN_COMPOSER_ROWS))
        .unwrap_or(u16::MAX);
    desired_visible_rows
        .min(max_visible_rows)
        .saturating_add(fixed_rows)
}

fn composer_height_limit_for_terminal(
    terminal_height: u16,
    status_height: u16,
    pending_input_height: u16,
    footer_height: u16,
    todo_height: u16,
) -> u16 {
    let available = terminal_height
        .saturating_sub(status_height)
        .saturating_sub(pending_input_height)
        .saturating_sub(footer_height)
        .saturating_sub(todo_height)
        .saturating_sub(BOTTOM_PANE_TOP_SPACER);
    let half_screen_cap = terminal_height.saturating_div(2).max(3);
    available.max(3).min(half_screen_cap)
}

struct ActivityPresentation {
    snapshot: ActivitySnapshot,
    indicator: &'static str,
    label: String,
    detail: Option<String>,
}

fn status_indicator_height(app: &ReplApp, width: u16) -> u16 {
    if !app.status_indicator_visible() {
        return 0;
    }

    let activity = app.activity_presentation();
    let mut data = StatusIndicatorData::new(
        &activity.label,
        activity.detail.as_deref(),
        "",
        app.status_elapsed(),
        StatusIndicatorControls {
            show_interrupt_hint: app.has_interruptible_turn(),
            interrupt_hint: "esc",
            is_running: app.spinner.is_running(),
        },
        &KCODER_UI_THEME,
    )
    .with_activity_indicator(activity.indicator, activity.snapshot.needs_attention);
    data.started_at = app.turn_started_at;
    data.details_capitalization = StatusDetailsCapitalization::Preserve;
    StatusIndicatorWidget::new(data)
        .desired_height(width.max(1))
        .min(STATUS_INDICATOR_MAX_HEIGHT)
}

fn fullscreen_footer_status(detail: Option<&str>, ambient_status: &str) -> String {
    let detail = detail.map(str::trim).filter(|text| !text.is_empty());
    let ambient_status = ambient_status.trim();
    match (detail, ambient_status.is_empty()) {
        (Some(detail), false) => format!("{detail} · {ambient_status}"),
        (Some(detail), true) => detail.to_string(),
        (None, false) => ambient_status.to_string(),
        (None, true) => String::new(),
    }
}

fn pending_input_preview_layout_height(preview_height: u16, status_height: u16) -> u16 {
    if preview_height == 0 {
        0
    } else {
        preview_height.saturating_add(u16::from(status_height > 0))
    }
}

fn status_indicator_layout_height(status_height: u16, preview_height: u16) -> u16 {
    if status_height == 0 {
        0
    } else {
        status_height.saturating_add(u16::from(preview_height == 0))
    }
}

fn pending_input_preview_content_area(pending_input_area: Rect, has_status_area: bool) -> Rect {
    let gap = u16::from(has_status_area && pending_input_area.height > 1);
    Rect::new(
        pending_input_area.x,
        pending_input_area.y.saturating_add(gap),
        pending_input_area.width,
        pending_input_area.height.saturating_sub(gap),
    )
}

#[allow(dead_code)]
fn wrapped_display_line_count(lines: &[Line<'_>], width: u16) -> usize {
    let width = usize::from(width.max(1));
    lines
        .iter()
        .map(|line| line.width().max(1).div_ceil(width))
        .sum()
}

/// Return the number of wrapped display rows ratatui will actually render for
/// the given lines at the given width. This must use the same Paragraph
/// configuration (Wrap, trim, style) as the live viewport so the count matches
/// what the user sees.
fn paragraph_line_count(lines: &[Line<'_>], width: u16) -> usize {
    if lines.is_empty() {
        return 0;
    }
    let width = width.max(1);
    let paragraph = Paragraph::new(Text::from(lines.to_vec())).wrap(Wrap { trim: false });
    paragraph.line_count(width)
}

fn bottom_aligned_paragraph(
    mut lines: Vec<Line<'static>>,
    width: u16,
    height: u16,
) -> (Vec<Line<'static>>, usize) {
    let rows = paragraph_line_count(&lines, width);
    if height == 0 {
        return (Vec::new(), rows);
    }
    let height = usize::from(height);
    if rows < height {
        let mut padded = Vec::with_capacity(lines.len() + height - rows);
        padded.extend((0..height - rows).map(|_| Line::from("")));
        padded.append(&mut lines);
        (padded, 0)
    } else {
        (lines, rows.saturating_sub(height))
    }
}

fn wrapped_line_rows(line: &Line<'_>, width: u16) -> usize {
    paragraph_line_count(std::slice::from_ref(line), width).max(1)
}

fn scroll_render_window_lines(
    lines: Vec<Line<'static>>,
    width: u16,
    top: usize,
    viewport_rows: usize,
    overscan_rows: usize,
) -> (Vec<Line<'static>>, usize) {
    if lines.is_empty() || viewport_rows == 0 {
        return (lines, 0);
    }

    let start_row = top.saturating_sub(overscan_rows);
    let end_row = top
        .saturating_add(viewport_rows)
        .saturating_add(overscan_rows);
    let mut row = 0usize;
    let mut start_idx = 0usize;
    let mut start_row_for_idx = 0usize;
    let mut found_start = false;

    for (idx, line) in lines.iter().enumerate() {
        let rows = wrapped_line_rows(line, width);
        if row.saturating_add(rows) > start_row {
            start_idx = idx;
            start_row_for_idx = row;
            found_start = true;
            break;
        }
        row = row.saturating_add(rows);
    }

    if !found_start {
        return (Vec::new(), 0);
    }

    let mut end_idx = start_idx;
    let mut end_row_cursor = start_row_for_idx;
    while end_idx < lines.len() && end_row_cursor < end_row {
        end_row_cursor = end_row_cursor.saturating_add(wrapped_line_rows(&lines[end_idx], width));
        end_idx += 1;
    }

    let adjusted_top = top.saturating_sub(start_row_for_idx);
    let window = lines
        .into_iter()
        .skip(start_idx)
        .take(end_idx.saturating_sub(start_idx))
        .collect();
    (window, adjusted_top)
}

fn clamp_render_top_to_content(
    render_top: usize,
    rendered_rows: usize,
    viewport_rows: usize,
) -> usize {
    render_top.min(rendered_rows.saturating_sub(viewport_rows.max(1)))
}

fn remap_scroll_top_proportionally(
    top: usize,
    source_rows: usize,
    target_rows: usize,
    viewport_rows: usize,
) -> usize {
    let source_max = source_rows.saturating_sub(viewport_rows);
    let target_max = target_rows.saturating_sub(viewport_rows);
    if source_max == 0 {
        return 0;
    }
    target_max
        .saturating_mul(top.min(source_max))
        .saturating_add(source_max / 2)
        / source_max
}

fn render_transcript_scrollbar(
    frame: &mut Frame,
    area: Rect,
    content_rows: usize,
    viewport_rows: usize,
    top: usize,
) {
    let Some(scrollbar_area) = transcript_scrollbar_area(area, content_rows, viewport_rows) else {
        return;
    };
    let metrics =
        TranscriptScrollbarMetrics::new(content_rows, viewport_rows, top, scrollbar_area.height);

    let theme = &KCODER_UI_THEME;
    let track_style = Style::default().fg(theme.text_dim).bg(theme.surface_bg);
    let thumb_style = Style::default().fg(theme.text_muted).bg(theme.surface_bg);
    let x = scrollbar_area.x;
    for offset in 0..scrollbar_area.height {
        let y = scrollbar_area.y.saturating_add(offset);
        let fill = metrics.cell_fill(usize::from(offset));
        let in_thumb = !matches!(fill, TranscriptScrollbarCellFill::Empty);
        set_transcript_scrollbar_cell(
            &mut frame.buffer_mut()[(x, y)],
            fill,
            if in_thumb { thumb_style } else { track_style },
        );
    }
}

fn set_transcript_scrollbar_cell(cell: &mut Cell, fill: TranscriptScrollbarCellFill, style: Style) {
    // The rail owns this reserved cell. Reset first because Cell::set_style
    // merges modifiers; stale wide-cell and reverse-video state can otherwise
    // leave a neighboring-column remnant while the thumb moves.
    cell.reset();
    cell.set_symbol(transcript_scrollbar_vertical_symbol(fill))
        .set_style(style);
}

fn transcript_area_for_message_area(area: Rect, reserve_scrollbar_gutter: bool) -> Rect {
    // Leave one scrollbar cell plus the normal trailing margin. Windows uses
    // ASCII rail symbols, so a broad defensive gutter is no longer necessary.
    let right_padding = if reserve_scrollbar_gutter { 3 } else { 2 };
    Rect::new(
        area.x.saturating_add(1),
        area.y,
        area.width.saturating_sub(right_padding),
        area.height,
    )
}

fn transcript_gutter_area(message_area: Rect, transcript_area: Rect) -> Option<Rect> {
    let x = transcript_area.right();
    let width = message_area.right().saturating_sub(x);
    if width == 0 || message_area.height == 0 {
        return None;
    }
    Some(Rect::new(x, message_area.y, width, message_area.height))
}

fn keyed_transcript_block_fingerprint(
    message: &DisplayMessage,
    width: u16,
    tool_output_expanded: bool,
    render_markdown: bool,
    code_theme: &str,
    assistant_continuation: bool,
    assistant_continues_next: bool,
) -> u64 {
    let mut hasher = DefaultHasher::new();
    match message.role {
        MessageRole::User => 0u8,
        MessageRole::Assistant => 1,
        MessageRole::System => 2,
    }
    .hash(&mut hasher);
    message.text.hash(&mut hasher);
    width.hash(&mut hasher);
    tool_output_expanded.hash(&mut hasher);
    render_markdown.hash(&mut hasher);
    code_theme.hash(&mut hasher);
    assistant_continuation.hash(&mut hasher);
    assistant_continues_next.hash(&mut hasher);
    hasher.finish()
}

fn assistant_message_is_continuation(messages: &[DisplayMessage], index: usize) -> bool {
    messages
        .get(index)
        .is_some_and(|message| message.role == MessageRole::Assistant)
        && index > 0
        && messages
            .get(index - 1)
            .is_some_and(|message| message.role == MessageRole::Assistant)
}

fn assistant_message_continues_next(messages: &[DisplayMessage], index: usize) -> bool {
    messages
        .get(index)
        .is_some_and(|message| message.role == MessageRole::Assistant)
        && messages
            .get(index + 1)
            .is_some_and(|message| message.role == MessageRole::Assistant)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineLimitMode {
    Head,
    Tail,
}

#[derive(Debug, Clone)]
struct FullscreenTranscriptRender {
    lines: Vec<Line<'static>>,
    total_rows: usize,
    top: usize,
    local_top: usize,
}

#[derive(Debug, Clone)]
struct TransientStatus {
    text: String,
    expires_at: Instant,
}

impl TransientStatus {
    fn new(text: impl Into<String>, now: Instant) -> Self {
        Self {
            text: text.into(),
            expires_at: now + TRANSIENT_STATUS_TTL,
        }
    }

    fn is_active_at(&self, now: Instant) -> bool {
        now < self.expires_at
    }

    fn remaining_at(&self, now: Instant) -> Duration {
        self.expires_at.saturating_duration_since(now)
    }
}

fn normalize_pasted_search_query(pasted: &str) -> Option<String> {
    let sanitized = sanitize_tui_text(pasted);
    let normalized = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

fn reasoning_summary_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| format!("{THINKING_MESSAGE_PREFIX}{trimmed}"))
}

fn reasoning_status_detail(text: &str) -> Option<String> {
    (!text.trim().is_empty()).then(|| "Thinking".to_string())
}

#[derive(Clone, Default)]
struct ComposerKillBuffer {
    text: String,
    pending_pastes: Vec<(String, String)>,
    local_image_attachments: Vec<LocalImageAttachment>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ComposerDraftSnapshot {
    input: String,
    cursor_grapheme_index: usize,
    pending_pastes: Vec<(String, String)>,
    local_image_attachments: Vec<LocalImageAttachment>,
    remote_image_urls: Vec<String>,
    selected_remote_image_index: Option<usize>,
}

#[derive(Clone, Debug)]
struct PendingSubagentProgress {
    message: String,
    detail: Option<String>,
    current: Option<usize>,
    total: Option<usize>,
    promoted: bool,
}

#[derive(Clone, Debug)]
struct PendingSubagentSteerApplied {
    message_id: String,
    queue_depth: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AgentTranscriptFingerprint {
    len: u64,
    modified: Option<SystemTime>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingAgentViewSteer {
    message_id: String,
    body: String,
}

#[derive(Debug)]
struct AgentViewState {
    live_revision: Option<u64>,
    agent_id: String,
    display_name: String,
    steer_status: Option<String>,
    transcript_path: PathBuf,
    transcript: TranscriptStore,
    fingerprint: Option<AgentTranscriptFingerprint>,
    pending_steers: Vec<PendingAgentViewSteer>,
    parent_viewport: TranscriptViewport,
    parent_navigation: transcript_navigation::NavigationState,
    parent_outline: transcript_outline::OutlineModel,
    refresh_after: Instant,
    load_error: Option<String>,
}

impl ComposerKillBuffer {
    fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

#[derive(Debug, Clone)]
struct ModelDiscoveryCache {
    fetched_at: Instant,
    groups: Vec<DiscoveredModelGroup>,
}

/// Minimal REPL application state.
pub struct ReplApp {
    pub messages: TranscriptStore,
    /// Full-screen resume loads only the tail synchronously; full history is read from the offset index on the user's first explicit review.
    deferred_resumed_transcript: Option<DeferredResumedTranscript>,
    welcome_component_mounted: bool,
    welcome_scrollback_committed: bool,
    startup_live_viewport_top_limit: Option<u16>,
    input: String,
    cursor_grapheme_index: usize,
    /// Display column retained across repeated vertical cursor movements.
    composer_preferred_col: Option<usize>,
    input_scroll_row: usize,
    last_input_width: u16,
    /// Single-entry readline kill buffer used by Ctrl+Y.
    composer_kill_buffer: ComposerKillBuffer,
    /// Retains native Linux clipboard ownership so copied text remains pasteable.
    clipboard_lease: Option<clipboard_copy::ClipboardLease>,
    /// Wall-clock instant of the most recent successful Enter-submit. Used
    /// to rate-limit repeated Enter presses so a user mashing the key
    /// cannot flood the model with empty/duplicated submissions while a
    /// turn is in flight.
    last_submit_at: Option<std::time::Instant>,
    is_loading: bool,
    /// Authoritative transcript viewport, wheel, layout, and scrollbar state.
    transcript_viewport: TranscriptViewport,
    navigation: transcript_navigation::NavigationState,
    outline: transcript_outline::OutlineModel,
    outline_open: bool,
    outline_geometry: Option<widgets::outline::OutlineGeometry>,
    outline_press: Option<widgets::outline::OutlineHit>,
    navigation_footer: Vec<(Rect, &'static str)>,
    navigation_footer_press: Option<(Rect, &'static str)>,
    /// Number of stable transcript messages already written into the
    /// terminal's native scrollback when running the legacy inline surface.
    /// These messages stay in `messages` for session state, but are skipped by
    /// the hot live viewport renderer only in that legacy mode.
    scrollback_committed_until: usize,
    /// Resize-reflow scheduler for legacy KCoder-owned native terminal scrollback.
    transcript_reflow: TranscriptReflowState,
    /// Current draw target. Fullscreen mode owns the whole terminal buffer and
    /// keeps transcript history inside the TUI instead of native scrollback.
    fullscreen_surface: bool,
    /// Full terminal area from the last draw, used for mouse hit testing.
    last_frame_area: Option<ratatui::layout::Rect>,
    /// Plain text rows visible in the last rendered transcript area.
    last_transcript_visible_rows: Vec<String>,
    /// Active transcript mouse selection in visible row/column coordinates.
    transcript_selection: Option<TranscriptSelection>,
    transcript_selection_rows: Option<Vec<String>>,
    /// Whether the left mouse button is currently selecting transcript text.
    transcript_selection_drag_active: bool,
    /// Last rendered transient bottom overlay area (`/` menu, shortcut help).
    last_bottom_overlay_area: Option<ratatui::layout::Rect>,
    /// Last rendered composer outer area.
    last_composer_area: Option<ratatui::layout::Rect>,
    /// Last rendered composer inner content area.
    last_composer_content: Option<ratatui::layout::Rect>,
    /// Force the next terminal draw to ignore the previous buffer. This is
    /// used after clearing submitted input so stale wide-character cells in
    /// the real terminal cannot survive next to the placeholder.
    force_viewport_redraw: bool,
    /// Terminal emulators may preserve/reflow old cells when the visible size
    /// changes. The next draw after a resize must reset the physical live
    /// surface, not only the ratatui diff buffer.
    resize_viewport_reset_pending: bool,
    /// Last known mouse position for hover/tooltip handling.
    last_mouse_pos: Option<(u16, u16)>,
    /// Whether the most recent tool result is expanded in the TUI.
    /// Whether tool result messages are expanded in the TUI.
    last_tool_output_expanded: bool,
    /// Whether collapsed tool runs are expanded back into transcript order.
    tool_transcript_expanded: bool,
    /// Whether the in-flight active tools summary is expanded.
    active_tools_expanded: bool,
    /// Active permission prompt waiting for user input.
    pending_permission: Option<PermissionDialog>,
    /// Active permission input editor overlay.
    permission_editor: Option<PermissionEditor>,
    /// Permission prompts queued while another modal is active.
    permission_queue: VecDeque<PermissionDialog>,
    /// Active user question dialog overlay.
    pending_question: Option<QuestionDialog>,
    /// Local confirmation dialog for replacing an unfinished `/goal`.
    pending_goal_replacement: Option<GoalReplacementDialog>,
    /// User questions queued while another modal is active.
    question_queue: VecDeque<QuestionDialog>,
    /// Background sub-agent status hints. Rendered in compact status surfaces
    /// rather than in the transcript so the user does not confuse them for
    /// assistant output. Capped at a small ring so a long session does not
    /// leak memory.
    background_job_hints: Vec<BackgroundJobHint>,
    background_job_lifetimes: HashMap<String, BackgroundJobLifetimeHint>,
    /// Latest lifecycle heartbeat for each running managed job. Kept separate
    /// from lifecycle hints so old persisted/test hint literals remain small.
    background_job_progress: HashMap<String, BackgroundJobProgressHint>,
    /// Structured sub-agent groups. The same snapshot backs both
    /// active-turn entries and already committed transcript cells.
    subagent_panels: HashMap<u64, SubagentPanel>,
    subagent_panel_by_agent: HashMap<String, u64>,
    pending_subagent_terminal: HashMap<String, (SubagentPhase, String)>,
    pending_subagent_progress: HashMap<String, PendingSubagentProgress>,
    pending_subagent_steer_applied: HashMap<String, PendingSubagentSteerApplied>,
    pending_subagent_associations: HashMap<String, (String, bool)>,
    pending_send_message_inputs: HashMap<String, String>,
    agent_view: Option<AgentViewState>,
    open_subagent_panel: Option<u64>,
    next_subagent_panel_id: u64,
    subagent_animation_started_at: Instant,
    /// User input waiting for a later turn. During a steerable regular turn, normal
    /// input goes to `pending_turn_steers`; slash commands, shell commands, and
    /// non-steerable foreground operations continue to use this queue.
    user_message_queue: VecDeque<QueuedUserMessage>,
    queued_model_error: Option<String>,
    /// Input accepted by the engine and waiting to enter the current regular turn.
    /// It remains here for rendering and recovery until the engine confirms that
    /// each item crossed a safe model boundary.
    pending_turn_steers: VecDeque<PendingTurnSteer>,
    /// Steering input still unapplied when a turn ends; prioritized when scheduling the next regular turn.
    rejected_turn_steers: VecDeque<QueuedUserMessage>,
    next_turn_steer_id: u64,
    /// Background follow-up requests waiting for the next non-user turn.
    pending_background_followups: VecDeque<PendingBackgroundFollowup>,
    active_background_followup: Option<(Vec<kcoder_types::BackgroundRunKey>, String)>,
    /// Per-goal automatic continuation counts for this process. The persisted
    /// `continuation_count` is audit-only and must not let one restart disable continuations permanently.
    goal_auto_continuations_started: HashMap<String, usize>,
    /// Goals for which the continuation-limit notice has been shown, preventing repeated notices on idle wakeups.
    goal_auto_continuation_limit_notices: HashSet<String>,
    /// Current-process marker passed by the harness through a one-time inherited pipe.
    /// Read and close the descriptor at startup so agent shells and providers cannot receive the token.
    goal_auto_continuation_notice_marker: String,
    /// Local image files attached to the current composer draft.
    local_image_attachments: Vec<LocalImageAttachment>,
    /// Remote image URLs rehydrated from history/backtrack and rendered above the composer.
    remote_image_urls: Vec<String>,
    /// Highlighted remote image row, if keyboard navigation has selected one.
    selected_remote_image_index: Option<usize>,
    /// Large paste payloads hidden behind visible placeholders in the composer.
    pending_pastes: Vec<(String, String)>,
    /// Prevent duplicate clipboard reads while native clipboard APIs are blocked.
    clipboard_image_paste_in_flight: bool,
    /// Active history search overlay.
    history_search: Option<HistorySearch>,
    /// Active previous-session picker rendered in the committed transcript area.
    resume_session_picker: Option<ResumeSessionPicker>,
    /// Active slash-command picker overlay.
    slash_menu: Option<SlashMenu>,
    /// File candidates for the `@path` fragment at the composer cursor.
    mention_menu: Option<MentionMenu>,
    mention_file_index: Vec<String>,
    /// Active context inspector overlay.
    context_inspector: Option<ContextInspector>,
    /// Active settings inspector overlay.
    settings_inspector: Option<SettingsInspector>,
    /// Active generic picker overlay.
    picker_overlay: Option<PickerOverlay>,
    model_discovery_cache: Option<ModelDiscoveryCache>,
    warned_discovered_models: HashSet<String>,
    /// Active keyboard-shortcuts help overlay.
    keys_overlay: Option<KeysOverlay>,
    /// Multi-line shortcut help rendered in the footer.
    footer_shortcuts_overlay: bool,
    /// Final frame state shown before a user-requested shutdown clears the
    /// terminal viewport.
    shutdown_in_progress: bool,
    /// Active full transcript pager overlay.
    transcript_overlay: Option<TranscriptOverlay>,
    copy_view: Option<copy_view::CopyView>,
    /// Isolated one-shot answer shown outside the main transcript.
    side_question_overlay: Option<SideQuestionOverlay>,
    side_question_sequence: u64,
    /// Single active overlay kind, kept in sync with the overlay payload
    /// fields above so routing can rely on one state machine.
    active_overlay: Option<OverlayKind>,
    /// Registered slash commands.
    slash_registry: Arc<slash::SlashRegistry>,
    /// Whether to render assistant output as Markdown.
    render_markdown: bool,
    /// Whether transcript output should favor raw text for terminal selection.
    raw_output_mode: bool,
    /// Code theme for syntax highlighting.
    code_theme: String,
    /// In-flight content for the current assistant turn. Holds streaming text,
    /// thinking, and tool statuses so they render as one stable cell instead of
    /// bouncing the transcript as tool messages are added.
    active_turn: Option<ActiveCell>,
    /// O(1) presentation identity for the active turn. Streaming deltas bump
    /// this revision instead of hashing the entire growing response per frame.
    active_turn_render_revision: u64,
    /// Cached rendered lines for the active turn tail. This avoids re-running
    /// markdown parsing and tool formatting on spinner/status redraws while
    /// the stream content itself has not changed.
    active_turn_render_cache: Option<ActiveTurnRenderCache>,
    /// Content-addressed blocks for the fullscreen live tail. Stable committed
    /// and completed active blocks survive updates to the final streaming part.
    keyed_transcript_block_render_cache: KeyedTranscriptBlockRenderCache,
    /// Cached fullscreen transcript render. In fullscreen mode, footer/status
    /// animation should not rebuild the committed transcript surface when the
    /// message data, scroll position, and active turn content are unchanged.
    fullscreen_transcript_render_cache: Option<FullscreenTranscriptRenderCache>,
    /// True after a turn has used its one-shot streaming redraw seed. Streaming
    /// deltas are normally coalesced by frame ticks; this only protects unusual
    /// event ordering where a delta arrives before any tick-producing event.
    streaming_delta_redraw_seeded: bool,
    /// Raw assistant text deltas that have arrived from the provider but have
    /// not yet been presented in the live active turn. Model output is collected
    /// immediately, then frame ticks reveal it at a bounded pace so large
    /// provider chunks do not pop in as a single wall of text.
    streaming_text_pending: String,
    /// The API has ended the current assistant message, but pending text still
    /// needs to be presented before final commit/consolidation.
    streaming_message_done_pending: bool,
    /// TurnFinished arrived while the presentation queue was still draining.
    /// Keep the TUI turn visually alive until the queued text is visible, then
    /// run the normal finish path exactly once.
    deferred_turn_finish_pending: bool,
    deferred_turn_finish_handle: Option<JoinHandle<()>>,
    /// Whether assistant text is actively streaming. Delta redraws are still
    /// coalesced by frame ticks; fullscreen keeps stable chunks inside the TUI
    /// transcript, while the legacy inline surface may move them into terminal
    /// scrollback.
    streaming_output_active: bool,
    /// Keep the status row hidden after ordinary final-answer streaming until
    /// the turn actually finishes, unless a queued follow-up needs a visible
    /// running affordance.
    streaming_status_suppressed_after_output: bool,
    /// Index where the current assistant stream first committed source lines
    /// into the transcript. Used only to consolidate adjacent stream chunks in
    /// source history after finalization; legacy inline terminals may already
    /// have seen those chunks in scrollback.
    streaming_transcript_start: Option<usize>,
    /// Transcript index where the most recent model turn started. Tool messages
    /// at or after this point stay expanded while the user is watching the live
    /// turn; older transcript history can still collapse into summaries.
    recent_turn_transcript_start: Option<usize>,
    /// Live reasoning/thinking status text. Reasoning deltas stay out of
    /// streaming history and drive status instead.
    streaming_thinking_status: String,
    /// Full live reasoning/thinking buffer used to build a compact summary
    /// when the reasoning block ends.
    streaming_thinking_buffer: String,
    /// Frame-rate limiter to avoid redrawing faster than 15 FPS during
    /// streaming.
    frame_rate_limiter: FrameRateLimiter,
    /// Time window for the double-press quit shortcut.
    quit_shortcut_expires_at: Option<Instant>,
    /// The specific key that must be pressed again to quit.
    quit_shortcut_key: Option<key_hint::KeyBinding>,
    /// Footer-only hint shown after Esc dismisses another transient footer mode.
    edit_previous_hint_visible: bool,
    /// True after the first idle Esc press arms edit-previous mode.
    edit_previous_primed: bool,
    /// Short-lived footer/status text for local UI actions such as copy.
    transient_status: Option<TransientStatus>,
    /// Spinner animation state.
    spinner: SpinnerState,
    /// Single owner for the scheduled/running model turn task and cancellation
    /// flag. Only the TUI event loop mutates this state.
    turn_state: TurnState,
    /// Label for foreground work that uses the turn lifecycle without
    /// producing assistant stream events, such as manual compaction.
    foreground_operation_label: Option<String>,
    path_previews: path_preview::PathPreviews,
    /// Wall-clock start of the current turn, used for the transcript divider
    /// appended when the turn finishes.
    turn_started_at: Option<Instant>,
    /// Whether the current turn performed concrete tool work. Final message
    /// separators render only for turns that did work, not for ordinary
    /// conversational replies.
    turn_had_work_activity: bool,
    /// Session working directory displayed in the header.
    display_cwd: String,
    /// Model name displayed in the header.
    model_name: String,
    /// Runtime reasoning effort displayed in status surfaces and sent to compatible providers.
    reasoning_effort: Option<ReasoningEffort>,
    /// Provider name for status surfaces.
    provider_name: String,
    /// Session identifier.
    session_id: String,
    /// Local user-facing session title set by `/rename`.
    session_title: Option<String>,
    /// Last sanitized terminal title emitted by KCoder.
    last_terminal_title: Option<String>,
    /// Current plan-mode instructions, if active.
    plan_mode: Option<String>,
    /// Session-level read-only orchestration mode used to display a persistent, non-dismissible status badge.
    session_mode: SessionMode,
    /// Cached progress for active orchestration work, avoiding a PlanStore read on every frame.
    orchestrate_progress_label: Option<String>,
    /// Current `/goal` status shown in the compact status area.
    goal: Option<Goal>,
    /// Current TodoWrite checklist shown in the TUI status area.
    todos: Vec<TodoItem>,
    /// Estimated token count of the current conversation.
    token_count: usize,
    /// Total effective context window for the active model.
    token_total: usize,
    /// Auto-compaction threshold in tokens.
    token_threshold: usize,
    /// Cached rendered lines for committed messages.
    render_cache: RenderCache,
    /// Cached estimated row offsets for fullscreen transcript scrollbar drag.
    transcript_row_index: TranscriptRowIndex,
    /// Persistent user input history (previous prompts submitted in this or
    /// prior sessions).
    input_history: Vec<String>,
    /// Current position when cycling through input history.
    input_history_index: Option<usize>,
    /// Path where input history is persisted.
    input_history_path: Option<std::path::PathBuf>,
    /// Serializes history snapshots and lets stale queued writes skip themselves.
    input_history_save_lock: Arc<Mutex<()>>,
    input_history_save_revision: Arc<AtomicU64>,
    /// Unsubmitted input preserved while cycling through history.
    input_history_draft: Option<ComposerDraftSnapshot>,
}

impl Default for ReplApp {
    fn default() -> Self {
        Self {
            messages: TranscriptStore::new(),
            deferred_resumed_transcript: None,
            welcome_component_mounted: false,
            welcome_scrollback_committed: false,
            startup_live_viewport_top_limit: None,
            input: String::new(),
            cursor_grapheme_index: 0,
            composer_preferred_col: None,
            input_scroll_row: 0,
            last_input_width: 0,
            composer_kill_buffer: ComposerKillBuffer::default(),
            clipboard_lease: None,
            last_submit_at: None,
            is_loading: false,
            transcript_viewport: TranscriptViewport::default(),
            navigation: Default::default(),
            outline: Default::default(),
            outline_open: false,
            outline_geometry: None,
            outline_press: None,
            navigation_footer: Vec::new(),
            navigation_footer_press: None,
            scrollback_committed_until: 0,
            transcript_reflow: TranscriptReflowState::default(),
            fullscreen_surface: false,
            last_frame_area: None,
            last_transcript_visible_rows: Vec::new(),
            transcript_selection: None,
            transcript_selection_rows: None,
            transcript_selection_drag_active: false,
            last_bottom_overlay_area: None,
            last_composer_area: None,
            last_composer_content: None,
            force_viewport_redraw: false,
            resize_viewport_reset_pending: false,
            last_mouse_pos: None,
            last_tool_output_expanded: false,
            tool_transcript_expanded: false,
            active_tools_expanded: false,
            pending_permission: None,
            permission_editor: None,
            permission_queue: VecDeque::new(),
            pending_question: None,
            pending_goal_replacement: None,
            question_queue: VecDeque::new(),
            background_job_hints: Vec::new(),
            background_job_lifetimes: HashMap::new(),
            background_job_progress: HashMap::new(),
            subagent_panels: HashMap::new(),
            subagent_panel_by_agent: HashMap::new(),
            pending_subagent_terminal: HashMap::new(),
            pending_subagent_progress: HashMap::new(),
            pending_subagent_steer_applied: HashMap::new(),
            pending_subagent_associations: HashMap::new(),
            pending_send_message_inputs: HashMap::new(),
            agent_view: None,
            open_subagent_panel: None,
            next_subagent_panel_id: 1,
            subagent_animation_started_at: Instant::now(),
            user_message_queue: VecDeque::new(),
            queued_model_error: None,
            pending_turn_steers: VecDeque::new(),
            rejected_turn_steers: VecDeque::new(),
            next_turn_steer_id: 0,
            pending_background_followups: VecDeque::new(),
            active_background_followup: None,
            goal_auto_continuations_started: HashMap::new(),
            goal_auto_continuation_limit_notices: HashSet::new(),
            goal_auto_continuation_notice_marker: goal_auto_continuation_notice_marker(),
            local_image_attachments: Vec::new(),
            remote_image_urls: Vec::new(),
            selected_remote_image_index: None,
            pending_pastes: Vec::new(),
            clipboard_image_paste_in_flight: false,
            history_search: None,
            resume_session_picker: None,
            slash_menu: None,
            mention_menu: None,
            mention_file_index: Vec::new(),
            context_inspector: None,
            settings_inspector: None,
            picker_overlay: None,
            model_discovery_cache: None,
            warned_discovered_models: HashSet::new(),
            keys_overlay: None,
            footer_shortcuts_overlay: false,
            shutdown_in_progress: false,
            transcript_overlay: None,
            copy_view: None,
            side_question_overlay: None,
            side_question_sequence: 0,
            active_overlay: None,
            slash_registry: Arc::new(slash::SlashRegistry::new()),
            render_markdown: true,
            raw_output_mode: false,
            code_theme: "auto".to_string(),
            active_turn: None,
            active_turn_render_revision: 0,
            active_turn_render_cache: None,
            keyed_transcript_block_render_cache: KeyedTranscriptBlockRenderCache::default(),
            fullscreen_transcript_render_cache: None,
            streaming_delta_redraw_seeded: false,
            streaming_text_pending: String::new(),
            streaming_message_done_pending: false,
            deferred_turn_finish_pending: false,
            deferred_turn_finish_handle: None,
            streaming_output_active: false,
            streaming_status_suppressed_after_output: false,
            streaming_transcript_start: None,
            recent_turn_transcript_start: None,
            streaming_thinking_status: String::new(),
            streaming_thinking_buffer: String::new(),
            frame_rate_limiter: FrameRateLimiter::default(),
            quit_shortcut_expires_at: None,
            quit_shortcut_key: None,
            edit_previous_hint_visible: false,
            edit_previous_primed: false,
            transient_status: None,
            spinner: SpinnerState::new(),
            turn_state: TurnState::default(),
            foreground_operation_label: None,
            path_previews: path_preview::PathPreviews::default(),
            turn_started_at: None,
            turn_had_work_activity: false,
            display_cwd: std::env::current_dir()
                .ok()
                .and_then(|p| p.into_os_string().into_string().ok())
                .unwrap_or_default(),
            model_name: "unknown".to_string(),
            reasoning_effort: None,
            provider_name: "unknown".to_string(),
            session_id: "-".to_string(),
            session_title: None,
            last_terminal_title: None,
            plan_mode: None,
            session_mode: SessionMode::Default,
            orchestrate_progress_label: None,
            goal: None,
            todos: Vec::new(),
            token_count: 0,
            token_total: 0,
            token_threshold: 0,
            render_cache: RenderCache::new(),
            transcript_row_index: TranscriptRowIndex::default(),
            input_history: Vec::new(),
            input_history_index: None,
            input_history_path: None,
            input_history_save_lock: Arc::new(Mutex::new(())),
            input_history_save_revision: Arc::new(AtomicU64::new(0)),
            input_history_draft: None,
        }
    }
}

fn sanitize_write_input_preview(mut preview: WriteInputPreview) -> WriteInputPreview {
    preview.path = preview.path.map(|path| sanitize_tui_text(&path));
    preview.lines = preview
        .lines
        .into_iter()
        .map(|line| sanitize_tui_text(&line))
        .collect();
    preview
}

impl ReplApp {
    /// Jump the transcript view to the very bottom and resume tail-following.
    pub(crate) fn snap_to_bottom(&mut self) {
        self.transcript_viewport.snap_to_bottom();
    }

    /// Apply any accumulated mouse-wheel delta to the transcript scroll state.
    fn apply_pending_scroll(&mut self) {
        self.transcript_viewport.apply_pending_scroll();
        self.finish_manual_scroll_at_tail();
    }

    fn finish_manual_scroll_at_tail(&mut self) {
        if self.transcript_viewport.is_at_tail() && self.navigation.anchor.is_some() {
            self.jump_transcript("latest");
        }
    }

    fn preserve_review_before_content_change(&mut self) {
        // Consume scroll intent from the old frame before new output in the same event batch can resume tail following.
        self.apply_pending_scroll();
        self.transcript_viewport
            .preserve_review_before_content_change();
    }

    fn time_until_next_viewport_draw(&self, now: Instant) -> Option<Duration> {
        if self.transcript_viewport.fast_path_active() {
            self.frame_rate_limiter
                .time_until_next_draw_with_interval(now, INTERACTION_MIN_FRAME_INTERVAL)
        } else {
            self.frame_rate_limiter.time_until_next_draw(now)
        }
    }

    fn force_next_viewport_redraw(&mut self) {
        self.force_viewport_redraw = true;
    }

    fn take_force_viewport_redraw(&mut self) -> bool {
        std::mem::take(&mut self.force_viewport_redraw)
    }

    fn request_resize_viewport_reset(&mut self) {
        self.resize_viewport_reset_pending = true;
        self.force_next_viewport_redraw();
        self.transcript_viewport.invalidate_layout();
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    fn take_resize_viewport_reset_pending(&mut self) -> bool {
        std::mem::take(&mut self.resize_viewport_reset_pending)
    }

    fn quit_shortcut_active_for(&self, key: key_hint::KeyBinding) -> bool {
        self.quit_shortcut_key == Some(key)
            && self
                .quit_shortcut_expires_at
                .is_some_and(|expires_at| Instant::now() <= expires_at)
    }

    fn active_quit_shortcut_key(&mut self) -> Option<key_hint::KeyBinding> {
        let key = self.quit_shortcut_key?;
        if self.quit_shortcut_active_for(key) {
            Some(key)
        } else {
            self.clear_quit_shortcut();
            None
        }
    }

    fn arm_quit_shortcut(&mut self, key: key_hint::KeyBinding) {
        self.quit_shortcut_key = Some(key);
        self.quit_shortcut_expires_at = Some(Instant::now() + QUIT_SHORTCUT_WINDOW);
    }

    fn handle_quit_shortcut(&mut self, key: key_hint::KeyBinding) -> Option<UserAction> {
        if self.quit_shortcut_active_for(key) {
            self.clear_quit_shortcut();
            Some(UserAction::Quit)
        } else {
            self.arm_quit_shortcut(key);
            None
        }
    }

    fn clear_quit_shortcut(&mut self) {
        self.quit_shortcut_key = None;
        self.quit_shortcut_expires_at = None;
    }

    fn clear_edit_previous_prompt(&mut self) {
        self.edit_previous_hint_visible = false;
        self.edit_previous_primed = false;
    }

    fn show_edit_previous_hint(&mut self) {
        if self.input.is_empty() && !self.has_interruptible_turn() {
            self.edit_previous_hint_visible = true;
            self.edit_previous_primed = false;
            self.force_next_viewport_redraw();
        }
    }

    fn composer_has_draft(&self) -> bool {
        !self.input.trim().is_empty()
            || !self.local_image_attachments.is_empty()
            || !self.remote_image_urls.is_empty()
            || !self.pending_pastes.is_empty()
    }

    fn composer_is_empty_for_shortcuts(&self) -> bool {
        self.input.is_empty()
            && self.local_image_attachments.is_empty()
            && self.remote_image_urls.is_empty()
            && self.pending_pastes.is_empty()
    }

    fn footer_height(&self) -> u16 {
        if DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED
            && self
                .quit_shortcut_key
                .is_some_and(|key| self.quit_shortcut_active_for(key))
        {
            return FooterHint::QuitReminder(self.quit_shortcut_key.expect("checked above"))
                .desired_height();
        }
        FooterHint::Shortcuts.desired_height()
    }

    fn dialog_host_area(&self) -> Option<Rect> {
        self.last_frame_area
            .map(|area| dialog_host_area_for_todo(area, todo_status_height(&self.todos)))
    }

    fn clear_composer_for_ctrl_c(&mut self) {
        if !self.composer_has_draft() {
            return;
        }
        let history_text = self.composer_text_for_external_editor();
        self.reset_input_history_navigation();
        self.input.clear();
        self.pending_pastes.clear();
        self.local_image_attachments.clear();
        self.remote_image_urls.clear();
        self.selected_remote_image_index = None;
        self.cursor_grapheme_index = 0;
        self.input_scroll_row = 0;
        self.close_slash_menu();
        self.push_input_history(history_text);
        self.force_next_viewport_redraw();
    }

    fn show_shutdown_in_progress(&mut self) {
        self.shutdown_in_progress = true;
        self.footer_shortcuts_overlay = false;
        self.clear_quit_shortcut();
        self.clear_edit_previous_prompt();
        self.close_slash_menu();
        self.force_next_viewport_redraw();
    }

    fn handle_edit_previous_escape(&mut self) -> Option<UserAction> {
        if !self.input.is_empty() || self.has_interruptible_turn() {
            self.clear_edit_previous_prompt();
            return None;
        }
        self.edit_previous_hint_visible = false;
        if self.edit_previous_primed {
            self.clear_edit_previous_prompt();
            Some(UserAction::EditPreviousMessage)
        } else {
            self.edit_previous_primed = true;
            self.force_next_viewport_redraw();
            None
        }
    }

    fn needs_scheduled_frame_tick(&self) -> bool {
        self.copy_needs_tick()
            || self.navigation_needs_tick()
            || self.spinner.is_running()
            || self.is_loading
            || self.active_turn.is_some()
            || !self.streaming_text_pending.is_empty()
            || self.streaming_message_done_pending
            || self.deferred_turn_finish_pending
            || self.quit_shortcut_expires_at.is_some()
            || self.transient_status.is_some()
            || self.has_running_background_job()
            || self.agent_view.is_some()
            || self
                .side_question_overlay
                .as_ref()
                .is_some_and(|overlay| matches!(overlay.status, SideQuestionStatus::Loading))
    }

    fn next_frame_tick_delay(&self) -> Duration {
        if self.copy_needs_tick() {
            return Duration::from_millis(60);
        }
        if self.navigation_needs_tick() && !self.is_loading && !self.spinner.is_running() {
            return Duration::from_millis(50);
        }
        let now = Instant::now();
        let needs_spinner = self.spinner.is_running();
        let needs_commit = self.is_loading || self.active_turn.is_some();
        let needs_presentation = !self.streaming_text_pending.is_empty()
            || self.streaming_message_done_pending
            || self.deferred_turn_finish_pending;
        let mut delay = match (needs_spinner, needs_commit) {
            (true, true) => Duration::from_millis(SPINNER_INTERVAL_MS.min(COMMIT_TICK_INTERVAL_MS)),
            (true, false) => Duration::from_millis(SPINNER_INTERVAL_MS),
            (false, true) => Duration::from_millis(COMMIT_TICK_INTERVAL_MS),
            (false, false) => Duration::ZERO,
        };
        if needs_presentation {
            let presentation_delay = Duration::from_millis(STREAM_TEXT_PRESENTATION_INTERVAL_MS);
            delay = if delay.is_zero() {
                presentation_delay
            } else {
                delay.min(presentation_delay)
            };
        }
        if let Some(status) = self.transient_status.as_ref() {
            let status_delay = status.remaining_at(now);
            delay = if delay.is_zero() {
                status_delay
            } else {
                delay.min(status_delay)
            };
        }
        if let Some(expires_at) = self.quit_shortcut_expires_at {
            let quit_delay = expires_at.saturating_duration_since(now);
            delay = if delay.is_zero() {
                quit_delay
            } else {
                delay.min(quit_delay)
            };
        }
        if self.has_running_background_job() {
            let background_delay = Duration::from_secs(1);
            delay = if delay.is_zero() {
                background_delay
            } else {
                delay.min(background_delay)
            };
        }
        if self.agent_view.is_some() {
            let agent_view_delay = Duration::from_millis(250);
            delay = if delay.is_zero() {
                agent_view_delay
            } else {
                delay.min(agent_view_delay)
            };
        }
        delay
    }

    fn mark_streaming_delta_redraw_seeded(&mut self) -> bool {
        if self.streaming_delta_redraw_seeded {
            false
        } else {
            self.streaming_delta_redraw_seeded = true;
            true
        }
    }

    fn clear_streaming_presentation_state(&mut self) {
        self.streaming_text_pending.clear();
        self.streaming_message_done_pending = false;
        self.deferred_turn_finish_pending = false;
        self.deferred_turn_finish_handle = None;
    }

    fn begin_turn(&mut self, handle: JoinHandle<()>, cancel: CancellationToken) {
        self.begin_turn_with_transcript_start(handle, cancel, None);
    }

    fn begin_turn_with_transcript_start(
        &mut self,
        handle: JoinHandle<()>,
        cancel: CancellationToken,
        transcript_start: Option<usize>,
    ) {
        debug_assert!(!self.turn_state.is_active());
        let transcript_start =
            self.expand_deferred_resumed_transcript_before_turn(transcript_start);
        self.path_previews.begin();
        self.turn_state = TurnState::Starting { handle, cancel };
        self.turn_had_work_activity = false;
        self.streaming_delta_redraw_seeded = false;
        self.streaming_status_suppressed_after_output = false;
        self.recent_turn_transcript_start = Some(
            transcript_start
                .unwrap_or(self.messages.len())
                .min(self.messages.len()),
        );
        self.set_loading(true);
    }

    fn mark_turn_started(&mut self) {
        let state = std::mem::take(&mut self.turn_state);
        let mut started = false;
        self.turn_state = match state {
            TurnState::Starting { handle, cancel } => {
                started = true;
                TurnState::Running { handle, cancel }
            }
            TurnState::Running { handle, cancel } => {
                started = true;
                TurnState::Running { handle, cancel }
            }
            other => other,
        };
        if started {
            self.turn_started_at = Some(Instant::now());
            self.recent_turn_transcript_start
                .get_or_insert_with(|| self.messages.len());
            self.set_loading(true);
        }
    }

    fn finish_turn_state(&mut self) -> Option<JoinHandle<()>> {
        self.path_previews.clear();
        self.foreground_operation_label = None;
        let state = std::mem::take(&mut self.turn_state);
        let handle = match state {
            TurnState::Starting { handle, .. } | TurnState::Running { handle, .. } => handle,
            TurnState::Finishing { handle } => handle,
            TurnState::Idle => return None,
        };
        self.turn_state = TurnState::Finishing { handle };
        match std::mem::take(&mut self.turn_state) {
            TurnState::Finishing { handle } => Some(handle),
            _ => unreachable!("turn state must be finishing"),
        }
    }

    fn abort_turn_for_shutdown(&mut self) -> Option<JoinHandle<()>> {
        if let Some(cancel) = self.turn_state.cancel_flag() {
            cancel.cancel();
        }
        let handle = self.finish_turn_state()?;
        handle.abort();
        self.turn_started_at = None;
        self.turn_had_work_activity = false;
        self.set_loading(false);
        Some(handle)
    }

    /// Reset every transcript-derived structure after `/clear`.
    ///
    /// Engine-side conversation state is cleared by the caller.
    pub(crate) fn reset_transcript_state_after_clear(&mut self) {
        self.path_previews.clear();
        self.messages.clear();
        self.welcome_component_mounted = false;
        self.welcome_scrollback_committed = false;
        self.startup_live_viewport_top_limit = None;
        self.render_cache.clear();
        self.keyed_transcript_block_render_cache.clear();
        self.scrollback_committed_until = 0;
        self.transcript_viewport.replace_content();
        if self.active_turn.take().is_some() {
            self.bump_active_turn_render_revision();
        }
        self.active_turn_render_cache = None;
        self.streaming_delta_redraw_seeded = false;
        self.clear_streaming_presentation_state();
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.streaming_transcript_start = None;
        self.recent_turn_transcript_start = None;
        self.clear_subagent_panel_state();
        self.streaming_thinking_status.clear();
        self.streaming_thinking_buffer.clear();
        self.input_scroll_row = 0;
        self.last_transcript_visible_rows.clear();
        self.clear_transcript_selection();
        self.transcript_reflow.clear();
        self.render_welcome_component();
        self.force_next_viewport_redraw();
    }

    fn clear_subagent_panel_state(&mut self) {
        self.subagent_panels.clear();
        self.subagent_panel_by_agent.clear();
        self.pending_subagent_terminal.clear();
        self.pending_subagent_progress.clear();
        self.pending_subagent_steer_applied.clear();
        self.pending_subagent_associations.clear();
        self.agent_view = None;
        self.open_subagent_panel = None;
    }

    fn reset_transcript_derived_after_rewrite(&mut self) {
        self.path_previews.clear();
        self.render_cache.clear();
        self.scrollback_committed_until = self.scrollback_committed_until.min(self.messages.len());
        self.transcript_viewport.replace_content();
        self.active_turn_render_cache = None;
        self.clear_streaming_presentation_state();
        self.streaming_thinking_status.clear();
        self.streaming_thinking_buffer.clear();
        self.streaming_transcript_start = None;
        self.recent_turn_transcript_start = None;
        self.last_transcript_visible_rows.clear();
        self.clear_transcript_selection();
        self.transcript_reflow.clear();
        self.force_next_viewport_redraw();
    }

    pub(crate) fn raw_output_mode(&self) -> bool {
        self.raw_output_mode
    }

    fn effective_render_markdown(&self) -> bool {
        self.render_markdown && !self.raw_output_mode
    }

    fn effective_tool_transcript_expanded(&self) -> bool {
        self.tool_transcript_expanded || self.raw_output_mode
    }

    fn effective_tool_output_expanded(&self) -> bool {
        self.last_tool_output_expanded || self.raw_output_mode
    }

    fn effective_active_tools_expanded(&self) -> bool {
        self.active_tools_expanded || self.raw_output_mode
    }

    fn invalidate_transcript_rendering(&mut self) {
        self.render_cache.clear();
        self.active_turn_render_cache = None;
        self.fullscreen_transcript_render_cache = None;
        self.transcript_row_index = TranscriptRowIndex::default();
        self.transcript_viewport.invalidate_content_layout();
        self.clear_transcript_selection();
        self.force_next_viewport_redraw();
    }

    fn bump_active_turn_render_revision(&mut self) {
        self.preserve_review_before_content_change();
        self.active_turn_render_revision = self.active_turn_render_revision.wrapping_add(1);
    }

    fn set_tool_transcript_expanded(&mut self, expanded: bool) {
        if self.tool_transcript_expanded == expanded
            && self.last_tool_output_expanded == expanded
            && self.active_tools_expanded == expanded
        {
            return;
        }
        self.tool_transcript_expanded = expanded;
        self.last_tool_output_expanded = expanded;
        self.active_tools_expanded = expanded;
        self.invalidate_transcript_rendering();
    }

    fn toggle_tool_transcript_expanded(&mut self) {
        let expanded = !self.tool_transcript_expanded;
        self.set_tool_transcript_expanded(expanded);
    }

    pub(crate) fn set_raw_output_mode(&mut self, enabled: bool) {
        if self.raw_output_mode == enabled {
            return;
        }
        self.raw_output_mode = enabled;
        self.invalidate_transcript_rendering();
    }

    pub(crate) fn set_code_theme(&mut self, code_theme: impl Into<String>) {
        let code_theme = code_theme.into();
        if self.code_theme == code_theme {
            return;
        }
        self.code_theme = code_theme;
        self.render_cache.clear();
        self.active_turn_render_cache = None;
        self.force_next_viewport_redraw();
    }

    pub(crate) fn session_title(&self) -> Option<&str> {
        self.session_title.as_deref()
    }

    pub(crate) fn set_session_title(&mut self, title: impl Into<String>) {
        let title = title.into();
        if self.session_title.as_deref() == Some(title.as_str()) {
            return;
        }
        self.session_title = Some(title);
        self.force_next_viewport_redraw();
    }

    fn terminal_title_project_name(&self) -> String {
        if let Some(title) = self
            .session_title
            .as_deref()
            .filter(|title| !title.trim().is_empty())
        {
            return terminal_title::truncate_terminal_title_part(title.trim(), 48);
        }

        let cwd = self.display_cwd.trim();
        if let Some(name) = Path::new(cwd)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.trim().is_empty())
        {
            return terminal_title::truncate_terminal_title_part(name, 24);
        }

        if cwd.is_empty() {
            "kcoder".to_string()
        } else {
            terminal_title::truncate_terminal_title_part(cwd, 24)
        }
    }

    fn terminal_title_text(&self) -> String {
        let activity = if self.pending_permission.is_some()
            || self.pending_question.is_some()
            || self.pending_goal_replacement.is_some()
        {
            "[WAIT]"
        } else if self.has_interruptible_turn() {
            "[RUN]"
        } else {
            "[READY]"
        };
        format!("{activity} · {}", self.terminal_title_project_name())
    }

    fn sync_terminal_title(&mut self, writer: &mut impl Write) -> Result<()> {
        let title = terminal_title::sanitize_terminal_title(&self.terminal_title_text());
        if title.is_empty() || self.last_terminal_title.as_deref() == Some(title.as_str()) {
            return Ok(());
        }
        if let terminal_title::TerminalTitleWrite::Applied(title) =
            terminal_title::write_terminal_title(writer, &title)
                .context("failed to write terminal title")?
        {
            self.last_terminal_title = Some(title);
        }
        Ok(())
    }

    fn clear_managed_terminal_title(&mut self, writer: &mut impl Write) -> Result<()> {
        if self.last_terminal_title.is_some() {
            terminal_title::clear_terminal_title(writer)
                .context("failed to clear managed terminal title")?;
            self.last_terminal_title = None;
        }
        Ok(())
    }

    pub(crate) fn raw_output_mode_notice(enabled: bool) -> &'static str {
        if enabled {
            "Raw output mode on: transcript text is shown for clean terminal selection."
        } else {
            "Raw output mode off: rich transcript rendering restored."
        }
    }

    pub(crate) fn set_raw_output_mode_and_notify(&mut self, enabled: bool) {
        self.set_raw_output_mode(enabled);
        self.push_message(MessageRole::System, Self::raw_output_mode_notice(enabled));
    }

    pub(crate) fn toggle_raw_output_mode_and_notify(&mut self) -> bool {
        let enabled = !self.raw_output_mode;
        self.set_raw_output_mode_and_notify(enabled);
        enabled
    }

    fn raw_output_status_label(&self) -> &'static str {
        if self.raw_output_mode {
            "raw output"
        } else {
            ""
        }
    }

    pub(crate) fn queued_user_message_count(&self) -> usize {
        self.user_message_queue.len() + self.rejected_turn_steers.len()
    }

    #[cfg(test)]
    fn queue_status_label(&self) -> String {
        let count = self.queued_user_message_count();
        if count == 0 {
            String::new()
        } else {
            format!("queue {count} pending")
        }
    }

    fn compact_status_label(&self) -> String {
        self.compact_status_label_with_transient(true)
    }

    fn compact_status_label_without_transient(&self) -> String {
        self.compact_status_label_with_transient(false)
    }

    fn compact_status_label_with_transient(&self, include_transient: bool) -> String {
        let transient = if include_transient {
            self.transient_status_label()
        } else {
            String::new()
        };
        [
            transient,
            self.background_status_label(),
            self.goal_status_label(),
            self.raw_output_status_label().to_string(),
            self.input_history_status_label(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
    }

    fn transient_status_label(&self) -> String {
        let now = Instant::now();
        self.transient_status
            .as_ref()
            .filter(|status| status.is_active_at(now))
            .map(|status| status.text.clone())
            .unwrap_or_default()
    }

    fn set_transient_status(&mut self, text: impl Into<String>) {
        self.transient_status = Some(TransientStatus::new(text, Instant::now()));
        self.force_next_viewport_redraw();
    }

    fn clear_expired_transient_status_at(&mut self, now: Instant) -> bool {
        let expired = self
            .transient_status
            .as_ref()
            .is_some_and(|status| !status.is_active_at(now));
        if expired {
            self.transient_status = None;
            self.force_next_viewport_redraw();
        }
        expired
    }

    pub(crate) fn clear_user_message_queue(&mut self) -> usize {
        let cleared = self.queued_user_message_count();
        self.user_message_queue.clear();
        self.rejected_turn_steers.clear();
        cleared
    }

    fn enqueue_user_message_for_turn(&mut self, message: impl Into<QueuedUserMessage>) -> bool {
        if self.pending_input_count() >= USER_MESSAGE_QUEUE_MAX {
            return false;
        }
        self.user_message_queue.push_back(message.into());
        true
    }

    fn pop_user_message_for_turn(&mut self) -> Option<QueuedTurnInput> {
        self.rejected_turn_steers
            .pop_front()
            .or_else(|| self.user_message_queue.pop_front())
            .map(QueuedUserMessage::into_turn_input)
    }

    fn restore_latest_queued_message_for_edit(&mut self) -> bool {
        let Some(queued) = self
            .user_message_queue
            .pop_back()
            .or_else(|| self.rejected_turn_steers.pop_back())
        else {
            return false;
        };
        self.prefill_input(queued.restore_text);
        self.local_image_attachments = queued.local_image_attachments;
        self.remote_image_urls = queued.remote_image_urls;
        self.selected_remote_image_index = None;
        self.pending_pastes = queued.pending_pastes;
        self.sync_composer_sidecars();
        self.force_next_viewport_redraw();
        true
    }

    fn pending_input_count(&self) -> usize {
        self.user_message_queue.len()
            + self.pending_turn_steers.len()
            + self.rejected_turn_steers.len()
    }

    fn next_turn_steer_id(&mut self) -> u64 {
        self.next_turn_steer_id = self.next_turn_steer_id.wrapping_add(1).max(1);
        self.next_turn_steer_id
    }

    fn track_pending_turn_steer(&mut self, id: u64, message: QueuedUserMessage) {
        debug_assert!(self.pending_input_count() < USER_MESSAGE_QUEUE_MAX);
        self.pending_turn_steers
            .push_back(PendingTurnSteer { id, message });
        self.force_next_viewport_redraw();
    }

    fn apply_pending_turn_steer(&mut self, id: u64) -> bool {
        let Some(index) = self
            .pending_turn_steers
            .iter()
            .position(|pending| pending.id == id)
        else {
            return false;
        };
        let Some(pending) = self.pending_turn_steers.remove(index) else {
            return false;
        };

        self.push_scheduled_user_message(&pending.message.display_message);
        self.force_next_viewport_redraw();
        true
    }

    fn defer_unapplied_turn_steers(&mut self) -> usize {
        let count = self.pending_turn_steers.len();
        self.rejected_turn_steers.extend(
            self.pending_turn_steers
                .drain(..)
                .map(|pending| pending.message),
        );
        count
    }

    fn push_scheduled_user_message(&mut self, message: &Message) -> usize {
        self.flush_active_turn();
        // A live panel holds the old active tail back. Move it into editable
        // transcript storage before the user boundary, not behind the new input.
        // sync_subagent_panel keeps it current; scrollback_commit_target still
        // prevents exporting a live panel into immutable native scrollback.
        let remaining = StreamController::flush(&mut self.active_turn, true);
        if !remaining.is_empty() {
            self.bump_active_turn_render_revision();
            for entry in remaining {
                self.push_message(entry.role, entry.text);
            }
        }
        self.consolidate_finished_assistant_stream();
        self.open_subagent_panel = None;
        let transcript_start = self.messages.len();
        let tool_uses = HashMap::new();
        let tool_results = HashMap::new();
        self.push_history_message(message, &tool_uses, &tool_results);
        transcript_start
    }

    fn push_user_shell_help(&mut self) {
        self.push_message(
            MessageRole::System,
            format!("{USER_SHELL_COMMAND_HELP_TITLE}\n{USER_SHELL_COMMAND_HELP_HINT}"),
        );
    }

    fn pending_input_preview(&self) -> widgets::PendingInputPreview<'_> {
        widgets::PendingInputPreview::new(
            self.user_message_queue
                .iter()
                .map(|message| queued_user_message_preview(&message.model_message))
                .collect(),
            &KCODER_UI_THEME,
        )
        .with_steers(
            self.pending_turn_steers
                .iter()
                .map(|pending| queued_user_message_preview(&pending.message.display_message))
                .collect(),
            self.rejected_turn_steers
                .iter()
                .map(|message| queued_user_message_preview(&message.display_message))
                .collect(),
        )
    }

    fn pending_input_preview_height(&self, width: u16, status_height: u16) -> u16 {
        let preview_height = self.pending_input_preview().desired_height(width.max(1));
        pending_input_preview_layout_height(preview_height, status_height)
    }

    fn bottom_pane_stack_heights(&self, width: u16) -> (u16, u16) {
        let status_height = status_indicator_height(self, width);
        let preview_height = self.pending_input_preview().desired_height(width.max(1));
        (
            status_indicator_layout_height(status_height, preview_height),
            self.pending_input_preview_height(width, status_height),
        )
    }

    fn history_search_footer_cursor(&self, footer_area: Rect) -> Option<(u16, u16)> {
        let search = self.history_search.as_ref()?;
        if footer_area.is_empty() {
            return None;
        }

        const FOOTER_INDENT_COLS: u16 = 2;
        let prompt_width = unicode_width::UnicodeWidthStr::width("reverse-i-search: ") as u16;
        let query_width = unicode_width::UnicodeWidthStr::width(search.query.as_str()) as u16;
        let desired_x = footer_area
            .x
            .saturating_add(FOOTER_INDENT_COLS.min(footer_area.width))
            .saturating_add(prompt_width)
            .saturating_add(query_width);
        let max_x = footer_area
            .x
            .saturating_add(footer_area.width.saturating_sub(1));
        Some((desired_x.min(max_x), footer_area.y))
    }

    #[cfg(test)]
    fn render_queued_user_message_lines(&self, width: u16) -> Vec<Line<'static>> {
        self.pending_input_preview().lines(width)
    }

    fn observe_terminal_size(&mut self, size: Size) {
        let size = Size::new(size.width.max(1), size.height.max(1));
        self.note_terminal_size_for_resize_reset(size);
    }

    fn observe_terminal_resize(&mut self, size: Size) {
        let size = Size::new(size.width.max(1), size.height.max(1));
        self.note_terminal_size_for_resize_reset(size);
    }

    fn note_terminal_size_for_resize_reset(&mut self, size: Size) {
        let change = self.transcript_reflow.note_size(size);
        if !change.initialized() && (change.width_changed() || change.height_changed()) {
            self.request_resize_viewport_reset();
        }
    }

    fn render_welcome_component(&mut self) {
        if self.welcome_component_mounted {
            return;
        }
        self.welcome_component_mounted = true;
        self.force_next_viewport_redraw();
    }

    fn startup_idle_surface_active(&self) -> bool {
        self.startup_live_viewport_top_limit.is_some()
            && self.messages.is_empty()
            && !self.is_loading
            && self.active_turn.is_none()
            && self.slash_menu.is_none()
            && !self.footer_shortcuts_overlay
            && !self.centered_overlay_active()
    }

    fn should_render_startup_welcome(&self, start_idx: usize) -> bool {
        self.welcome_component_mounted && !self.welcome_scrollback_committed && start_idx == 0
    }

    fn prepend_startup_welcome_hyperlink_lines(
        &self,
        lines: &mut Vec<HyperlinkLine>,
        width: u16,
        start_idx: usize,
        has_following_content: bool,
    ) {
        if !self.should_render_startup_welcome(start_idx) {
            return;
        }
        let mut welcome_lines = render_startup_welcome(startup_welcome_info(self), Some(width))
            .into_iter()
            .map(HyperlinkLine::new)
            .collect::<Vec<_>>();
        if has_following_content && !welcome_lines.is_empty() {
            welcome_lines.push(HyperlinkLine::new(Line::from("")));
        }
        welcome_lines.append(lines);
        *lines = welcome_lines;
    }

    fn transcript_tail_start_index_for_end(
        &self,
        width: u16,
        row_budget: usize,
        end_idx: usize,
    ) -> usize {
        let end_idx = end_idx.min(self.messages.len());
        let max_messages = if self.transcript_viewport.is_at_tail() {
            TRANSCRIPT_RENDER_MAX_MESSAGES
        } else {
            end_idx.max(1)
        };
        transcript_tail_window_start(
            &self.messages[..end_idx],
            width,
            row_budget,
            max_messages,
            is_tool_run_message,
            is_collapsible_tool_message,
            TURN_DIVIDER_PREFIX,
        )
    }

    #[cfg(test)]
    fn live_transcript_start_index_for_end(
        &self,
        width: u16,
        row_budget: usize,
        end_idx: usize,
    ) -> usize {
        let end_idx = end_idx.min(self.messages.len());
        let start = self.transcript_tail_start_index_for_end(width, row_budget, end_idx);
        if self.transcript_viewport.is_at_tail() {
            start.max(self.scrollback_committed_until.min(end_idx))
        } else {
            start
        }
    }

    #[cfg(test)]
    fn live_transcript_start_index(&self, width: u16, row_budget: usize) -> usize {
        self.live_transcript_start_index_for_end(width, row_budget, self.messages.len())
    }

    fn transcript_render_line_limit(&self, row_budget: usize) -> Option<usize> {
        Some(row_budget.saturating_add(TRANSCRIPT_RENDER_OVERSCAN_ROWS))
    }

    fn fullscreen_transcript_render_line_limit(
        &self,
        render_budget: usize,
        viewport_rows: usize,
    ) -> Option<usize> {
        if self.transcript_viewport.fast_path_active() {
            return Some(viewport_rows.max(1).saturating_mul(2));
        }
        self.transcript_render_line_limit(render_budget)
    }

    fn fullscreen_scrolled_render_line_limit(
        &self,
        render_budget: usize,
        viewport_rows: usize,
        local_top: usize,
    ) -> Option<usize> {
        let base_limit = self
            .fullscreen_transcript_render_line_limit(render_budget, viewport_rows)
            .unwrap_or(usize::MAX);
        Some(
            base_limit.max(
                local_top
                    .saturating_add(viewport_rows.max(1))
                    .saturating_add(TRANSCRIPT_RENDER_OVERSCAN_ROWS),
            ),
        )
    }

    fn fullscreen_transcript_render_row_budget(&self, row_budget: usize) -> usize {
        let row_budget = row_budget.max(1);
        let budget = transcript_render_row_budget(
            self.transcript_viewport.position(),
            self.transcript_viewport.live_content_rows(),
            self.transcript_viewport.viewport_rows(),
            row_budget,
        );
        if self.transcript_viewport.is_at_tail() {
            return budget;
        }

        if self.transcript_viewport.fast_path_active() {
            return row_budget
                .saturating_mul(2)
                .min(FULLSCREEN_SCROLL_RENDER_MAX_ROWS.max(row_budget));
        }

        let smooth_scroll_budget = row_budget
            .saturating_add(
                TRANSCRIPT_RENDER_OVERSCAN_ROWS
                    .saturating_mul(FULLSCREEN_SCROLL_RENDER_OVERSCAN_MULTIPLIER),
            )
            .min(FULLSCREEN_SCROLL_RENDER_MAX_ROWS.max(row_budget));
        budget.min(smooth_scroll_budget)
    }

    fn render_inline_live_transcript_lines(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> Vec<Line<'static>> {
        let start_idx = self.scrollback_committed_until.min(self.messages.len());
        let render_line_limit = self.transcript_render_line_limit(row_budget);
        let active_messages = self.active_turn_display_messages_for_render();
        let mut lines = if active_messages.is_empty() {
            self.render_transcript_range_limited_with_mode(
                start_idx,
                self.messages.len(),
                width,
                render_line_limit,
                LineLimitMode::Tail,
            )
        } else {
            let mut combined_messages = self.messages[start_idx..].to_vec();
            let active_from = combined_messages.len();
            combined_messages.extend(active_messages);
            self.render_display_messages_limited_with_mode(
                &combined_messages,
                width,
                render_line_limit,
                LineLimitMode::Tail,
                Some(active_from),
            )
        };
        if lines.is_empty() && self.startup_idle_surface_active() {
            lines.push(Line::from(Span::styled(
                "Ready",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            )));
        }
        lines
    }

    fn inline_turn_uses_live_tail(&self) -> bool {
        self.recent_turn_transcript_start.is_some()
            && (self.is_loading
                || self.active_turn.is_some()
                || self.streaming_output_active
                || self.streaming_message_done_pending
                || self.deferred_turn_finish_pending)
    }

    #[cfg(test)]
    fn render_fullscreen_transcript_lines(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> Vec<Line<'static>> {
        self.render_fullscreen_transcript_window(width, row_budget)
            .lines
    }

    fn fullscreen_welcome_lines(
        &self,
        width: u16,
        has_following_content: bool,
    ) -> Vec<Line<'static>> {
        if let Some(view) = self.agent_view.as_ref() {
            let status = view
                .steer_status
                .as_deref()
                .map(|status| format!(" · {status}"))
                .unwrap_or_default();
            let mut lines = vec![Line::from(vec![
                Span::styled(
                    "Agent transcript ",
                    Style::default()
                        .fg(KCODER_UI_THEME.mode_agent)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    truncate_display_text(
                        &format!("{} ({}){status}", view.display_name, view.agent_id),
                        usize::from(width).saturating_sub(17).max(1),
                    ),
                    Style::default().fg(KCODER_UI_THEME.text_muted),
                ),
            ])];
            if let Some(error) = view.load_error.as_deref() {
                lines.push(Line::from(Span::styled(
                    truncate_display_text(
                        &format!("Transcript refresh failed: {error}"),
                        usize::from(width).max(1),
                    ),
                    Style::default().fg(KCODER_UI_THEME.warning),
                )));
            }
            if has_following_content {
                lines.push(Line::from(""));
            }
            return lines;
        }
        if !self.welcome_component_mounted {
            return Vec::new();
        }
        let mut lines = render_startup_welcome(startup_welcome_info(self), Some(width));
        if has_following_content && !lines.is_empty() {
            lines.push(Line::from(""));
        }
        lines
    }

    fn render_fullscreen_transcript_window(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> FullscreenTranscriptRender {
        if let Some(render) = self.render_navigation_window(width, row_budget) {
            return render;
        }
        let key = self.fullscreen_transcript_render_cache_key(width, row_budget);
        if let Some(cache) = self
            .fullscreen_transcript_render_cache
            .as_ref()
            .filter(|cache| cache.key == key)
        {
            return cache.render.clone();
        }

        let render = self.render_fullscreen_transcript_window_uncached(width, row_budget);
        self.fullscreen_transcript_render_cache = Some(FullscreenTranscriptRenderCache {
            key,
            render: render.clone(),
        });
        render
    }

    fn fullscreen_transcript_render_cache_key(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> FullscreenTranscriptRenderCacheKey {
        let active_tools_expanded = self.effective_active_tools_expanded();
        let welcome_info = self
            .welcome_component_mounted
            .then(|| startup_welcome_info(self));
        let render_budget = self.fullscreen_transcript_render_row_budget(row_budget);
        let at_tail = self.transcript_viewport.is_at_tail();
        let active_display_rows = if at_tail {
            0
        } else {
            let active_lines = self.render_active_turn_lines(width);
            paragraph_line_count(&active_lines, width)
        };
        FullscreenTranscriptRenderCacheKey {
            width,
            row_budget,
            render_budget,
            messages_len: self.messages.len(),
            messages_epoch: self.messages.render_epoch(),
            transcript_scroll: self.transcript_viewport.position(),
            active_render_revision: if at_tail {
                self.active_turn_render_revision
            } else {
                0
            },
            active_display_rows,
            active_tools_expanded,
            tool_transcript_expanded: self.effective_tool_transcript_expanded(),
            render_markdown: self.effective_render_markdown(),
            code_theme: self.code_theme.clone(),
            welcome_info,
            startup_idle_surface_active: self.startup_idle_surface_active(),
            scrollbar_fast_path_active: self.transcript_viewport.fast_path_active(),
            scrollbar_drag_active: self.transcript_viewport.drag_active(),
            // Keep the active tool-title diamond moving even while the user
            // has scrolled away from the tail. The active summary can remain
            // visible in that layout, and a frozen title looks like a stalled
            // tool despite the footer heartbeat continuing.
            tool_summary_indicator: self.active_tool_summary_indicator(),
            subagent_animation_frame: if self
                .subagent_panels
                .values()
                .any(|panel| !panel.all_terminal())
            {
                ((self.subagent_animation_started_at.elapsed().as_millis() / 80) % 10) as u8
            } else {
                0
            },
        }
    }

    fn active_tool_summary_indicator(&self) -> &'static str {
        self.active_tool_summary_indicator_at(self.spinner.snapshot().phase_elapsed)
    }

    fn active_tool_summary_indicator_at(&self, elapsed: Duration) -> &'static str {
        let has_collapsed_running_tools = !self.effective_tool_transcript_expanded()
            && self
                .active_turn
                .as_ref()
                .is_some_and(ActiveCell::has_running_tool_entries);
        if self.spinner.is_running() && has_collapsed_running_tools {
            motion::tool_summary_frame(elapsed)
        } else {
            "◇"
        }
    }

    /// Batched commits within one streaming answer are storage boundaries, not Markdown paragraph boundaries.
    fn fullscreen_stream_render_start(&self) -> Option<usize> {
        self.streaming_transcript_start.filter(|start| {
            *start < self.messages.len()
                && self.messages[*start..]
                    .iter()
                    .all(|message| message.role == MessageRole::Assistant)
        })
    }

    fn fullscreen_combined_messages(
        &self,
        start: usize,
        end: usize,
        active: Vec<DisplayMessage>,
    ) -> (Vec<DisplayMessage>, usize) {
        let mut combined = self.messages[start..end].to_vec();
        let mut active_from = combined.len();
        combined.extend(active);
        if let Some(stream_start) = self.fullscreen_stream_render_start()
            && start <= stream_start
            && end == self.messages.len()
        {
            let first = stream_start - start;
            let mut next = first + 1;
            while next < combined.len() && combined[next].role == MessageRole::Assistant {
                next += 1;
            }
            let text = combined[first..next]
                .iter()
                .map(|message| message.text.as_str())
                .collect::<String>();
            combined.splice(
                first..next,
                [DisplayMessage {
                    role: MessageRole::Assistant,
                    text,
                }],
            );
            active_from = first;
        }
        (combined, active_from)
    }

    fn fullscreen_exact_prefix_rows(
        &mut self,
        start: usize,
        width: u16,
        welcome_rows: usize,
    ) -> Option<usize> {
        if start == 0 {
            return Some(0);
        }
        if start > FULLSCREEN_EXACT_TAIL_PREFIX_MAX_MESSAGES
            || self.messages[..start]
                .iter()
                .map(|message| message.text.len())
                .sum::<usize>()
                > 512 * 1024
        {
            return None;
        }
        let prefix = self.render_transcript_range_limited_with_mode(
            0,
            start,
            width,
            None,
            LineLimitMode::Head,
        );
        Some(welcome_rows.saturating_add(paragraph_line_count(&prefix, width)))
    }

    fn render_fullscreen_transcript_window_uncached(
        &mut self,
        width: u16,
        row_budget: usize,
    ) -> FullscreenTranscriptRender {
        let row_budget = row_budget.max(1);
        let render_budget = self.fullscreen_transcript_render_row_budget(row_budget);
        let welcome_lines = self.fullscreen_welcome_lines(width, !self.messages.is_empty());
        let welcome_rows = paragraph_line_count(&welcome_lines, width);
        let active_rows = paragraph_line_count(&self.render_active_turn_lines(width), width);
        self.transcript_row_index.rebuild_if_stale(
            &self.messages,
            width,
            self.messages.render_epoch(),
            is_tool_run_message,
            is_collapsible_tool_message,
            TURN_DIVIDER_PREFIX,
        );
        let mut estimated_total_rows = welcome_rows
            .saturating_add(self.transcript_row_index.total_rows())
            .saturating_add(active_rows);
        let (scroll, mut top) = if self.transcript_viewport.drag_active() {
            let frozen_rows = self.transcript_viewport.content_rows();
            let frozen_top = self
                .transcript_viewport
                .resolve_top(frozen_rows, row_budget);
            (
                self.transcript_viewport.position(),
                remap_scroll_top_proportionally(
                    frozen_top,
                    frozen_rows,
                    estimated_total_rows,
                    row_budget,
                ),
            )
        } else {
            self.transcript_viewport
                .position()
                .resolve_top(estimated_total_rows, row_budget)
        };
        if scroll.is_at_tail() {
            let mut start_idx =
                self.transcript_tail_start_index_for_end(width, render_budget, self.messages.len());
            if let Some(stream_start) = self.fullscreen_stream_render_start() {
                start_idx = start_idx.min(stream_start);
            }
            let render_line_limit =
                self.fullscreen_transcript_render_line_limit(render_budget, row_budget);
            let active_messages = self.active_turn_display_messages_for_render();
            let active_messages_empty = active_messages.is_empty();
            let mut lines = loop {
                let mut lines =
                    if active_messages_empty && self.fullscreen_stream_render_start().is_none() {
                        self.render_transcript_range_limited_with_mode(
                            start_idx,
                            self.messages.len(),
                            width,
                            None,
                            LineLimitMode::Tail,
                        )
                    } else {
                        let (combined_messages, active_from) = self.fullscreen_combined_messages(
                            start_idx,
                            self.messages.len(),
                            active_messages.clone(),
                        );
                        self.render_display_messages_limited_with_mode(
                            &combined_messages,
                            width,
                            None,
                            LineLimitMode::Tail,
                            Some(active_from),
                        )
                    };
                if start_idx == 0 {
                    let mut welcome_lines = self.fullscreen_welcome_lines(width, !lines.is_empty());
                    if !welcome_lines.is_empty() {
                        welcome_lines.append(&mut lines);
                        lines = welcome_lines;
                    }
                }
                if active_messages_empty {
                    lines.extend(self.render_active_turn_lines(width));
                }
                if start_idx == 0 || paragraph_line_count(&lines, width) >= row_budget {
                    break lines;
                }
                // Collapsed content can be much shorter than estimated. Extend an underfilled tail until it fills the viewport or reaches history's start.
                let backfill = self.messages.len().saturating_sub(start_idx).max(1);
                start_idx = start_idx.saturating_sub(backfill);
            };
            if lines.is_empty() && self.startup_idle_surface_active() {
                lines.push(Line::from(Span::styled(
                    "Ready",
                    Style::default().fg(KCODER_UI_THEME.text_muted),
                )));
            }
            // Measure the selected tail before clipping the draw window. The renderer
            // already constructs each Markdown message in full; counting after clipping
            // loses the true height of long messages and shifts coordinates near the tail.
            let full_tail_rows = paragraph_line_count(&lines, width);
            let total_rows = if start_idx == 0 {
                full_tail_rows
            } else {
                self.fullscreen_exact_prefix_rows(start_idx, width, welcome_rows)
                    .unwrap_or_else(|| {
                        welcome_rows
                            .saturating_add(self.transcript_row_index.prefix_rows_at(start_idx))
                    })
                    .saturating_add(full_tail_rows)
            };
            if let Some(limit) = render_line_limit {
                let excess = lines.len().saturating_sub(limit);
                lines.drain(..excess);
            }
            let rendered_rows = paragraph_line_count(&lines, width);
            return FullscreenTranscriptRender {
                lines,
                total_rows,
                top: total_rows.saturating_sub(row_budget),
                local_top: rendered_rows.saturating_sub(row_budget),
            };
        }

        let message_top = top.saturating_sub(welcome_rows);
        let scroll_window = self.transcript_row_index.window_for_top(
            &self.messages,
            message_top,
            row_budget,
            render_budget,
            is_tool_run_message,
        );
        let mut start_idx = scroll_window.start_idx;
        let mut end_idx = scroll_window.end_idx;
        if let Some(stream_start) = self.fullscreen_stream_render_start()
            && end_idx > stream_start
        {
            start_idx = start_idx.min(stream_start);
            end_idx = self.messages.len();
        }
        // Active content merges into history on completion, so the window may begin at
        // the consolidated message. Calibrate the bounded prefix to preserve review position.
        let exact_prefix_rows = self.fullscreen_exact_prefix_rows(start_idx, width, welcome_rows);
        let estimated_prefix = if start_idx == 0 {
            0
        } else {
            welcome_rows.saturating_add(self.transcript_row_index.prefix_rows_at(start_idx))
        };
        if let Some(prefix) = exact_prefix_rows
            && !self.transcript_viewport.drag_active()
        {
            estimated_total_rows = estimated_total_rows
                .saturating_sub(estimated_prefix)
                .saturating_add(prefix);
            top = self
                .transcript_viewport
                .resolve_top(estimated_total_rows, row_budget);
        }
        let local_top = if let Some(prefix) = exact_prefix_rows {
            top.saturating_sub(prefix)
        } else {
            top.saturating_sub(estimated_prefix)
        };
        let render_line_limit =
            self.fullscreen_scrolled_render_line_limit(render_budget, row_budget, local_top);
        let active_messages = if end_idx == self.messages.len() {
            self.active_turn_display_messages_for_render()
        } else {
            Vec::new()
        };
        // A review window reaching the committed tail must render active text, not merely count its rows.
        let mut lines =
            if active_messages.is_empty() && self.fullscreen_stream_render_start().is_none() {
                self.render_transcript_range_limited_with_mode(
                    start_idx,
                    end_idx,
                    width,
                    render_line_limit,
                    LineLimitMode::Head,
                )
            } else {
                let (combined, active_from) =
                    self.fullscreen_combined_messages(start_idx, end_idx, active_messages);
                self.render_display_messages_limited_with_mode(
                    &combined,
                    width,
                    render_line_limit,
                    LineLimitMode::Head,
                    Some(active_from),
                )
            };
        if start_idx == 0 {
            let mut welcome_lines = self.fullscreen_welcome_lines(width, !lines.is_empty());
            if !welcome_lines.is_empty() {
                welcome_lines.append(&mut lines);
                lines = welcome_lines;
            }
        }
        if lines.is_empty() && self.startup_idle_surface_active() {
            lines.push(Line::from(Span::styled(
                "Ready",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            )));
        }
        let rendered_rows = paragraph_line_count(&lines, width);
        let render_limit_hit = render_line_limit.is_some_and(|max_lines| lines.len() >= max_lines);
        let estimated_distance_from_tail = estimated_total_rows
            .saturating_sub(row_budget)
            .saturating_sub(top);
        let exact_tail_prefix_rows = if !render_limit_hit && end_idx == self.messages.len() {
            Some(exact_prefix_rows.unwrap_or(estimated_prefix))
        } else {
            None
        };
        if let Some(exact_prefix_rows) = exact_tail_prefix_rows {
            let total_rows = exact_prefix_rows.saturating_add(rendered_rows);
            // Row-index estimates intentionally trade precision for speed. If
            // an upward wheel event leaves the tail, carrying the estimated
            // absolute `top` into this exact window can clamp it straight back
            // to the bottom. Several wheel events are then swallowed before
            // the accumulated delta exceeds the estimate error. Preserve the
            // user's distance from the tail instead, so the first wheel event
            // always moves the visible transcript.
            let (_, exact_top) = if self.transcript_viewport.drag_active() {
                let frozen_rows = self.transcript_viewport.content_rows();
                let frozen_top = self
                    .transcript_viewport
                    .resolve_top(frozen_rows, row_budget);
                let exact_top = remap_scroll_top_proportionally(
                    frozen_top,
                    frozen_rows,
                    total_rows,
                    row_budget,
                );
                (self.transcript_viewport.position(), exact_top)
            } else if self.transcript_viewport.is_tail_relative() {
                TranscriptScroll::from_tail(estimated_distance_from_tail)
                    .resolve_top(total_rows, row_budget)
            } else {
                self.transcript_viewport
                    .position()
                    .resolve_top(total_rows, row_budget)
            };
            let local_top = clamp_render_top_to_content(
                exact_top.saturating_sub(exact_prefix_rows),
                rendered_rows,
                row_budget,
            );
            return FullscreenTranscriptRender {
                lines,
                total_rows,
                top: exact_top,
                local_top,
            };
        }
        let local_top =
            if end_idx == self.messages.len() && self.transcript_viewport.is_tail_relative() {
                // Keep a partially rendered tail window bottom-anchored as well.
                // Otherwise an overestimated prefix can leave `local_top` clamped
                // at its maximum for multiple wheel ticks and then jump suddenly.
                rendered_rows
                    .saturating_sub(row_budget)
                    .saturating_sub(estimated_distance_from_tail)
            } else {
                clamp_render_top_to_content(local_top, rendered_rows, row_budget)
            };
        FullscreenTranscriptRender {
            lines,
            // `local_top` is an offset within the local render window and must not be
            // counted again in global rows; otherwise a small scroll near a long-message
            // tail makes the scrollbar report sudden content growth.
            total_rows: estimated_total_rows
                .max(top.saturating_add(row_budget))
                .max(rendered_rows),
            top,
            local_top,
        }
    }

    fn transcript_desired_rows(
        &mut self,
        terminal_width: u16,
        transcript_row_budget: usize,
    ) -> u16 {
        if transcript_row_budget == 0 {
            return 0;
        }
        let transcript_width = terminal_width.saturating_sub(2).max(1);
        let start_idx = self.scrollback_committed_until.min(self.messages.len());
        let render_line_limit = self.transcript_render_line_limit(transcript_row_budget);
        let visible_lines = self.render_transcript_range_limited_with_mode(
            start_idx,
            self.messages.len(),
            transcript_width,
            render_line_limit,
            LineLimitMode::Tail,
        );
        let active_text_visible = !self.streaming_thinking_status.trim().is_empty()
            || self.active_turn.as_ref().is_some_and(|active| {
                active
                    .entries
                    .iter()
                    .any(|entry| matches!(entry, ActiveEntry::Text(_)))
            });
        let mut desired_rows = paragraph_line_count(&visible_lines, transcript_width);
        if active_text_visible {
            // Incomplete text is tail-aligned in the current viewport, but a long partial
            // must not instantly fill the inline area. Expand naturally after complete lines commit.
            desired_rows = desired_rows.saturating_add(1);
        } else if desired_rows == 0 && self.startup_idle_surface_active() {
            desired_rows = 1;
        }
        if self.inline_turn_uses_live_tail() {
            desired_rows = desired_rows.min(INLINE_ACTIVE_TRANSCRIPT_MAX_ROWS);
        }
        desired_rows
            .min(transcript_row_budget)
            .min(usize::from(u16::MAX)) as u16
    }

    fn bottom_overlay_reserved_rows(&self) -> u16 {
        let mut rows = 0u16;
        if self.slash_menu.is_some() && !self.shutdown_in_progress {
            rows = rows.max(
                self.slash_menu_matches()
                    .len()
                    .min(SLASH_MENU_MAX_ITEMS)
                    .min(usize::from(u16::MAX)) as u16,
            );
        }
        if let Some(menu) = &self.mention_menu
            && !self.shutdown_in_progress
        {
            rows = rows.max(menu.candidates.len().min(8) as u16);
        }
        if self.footer_shortcuts_overlay && !self.shutdown_in_progress {
            rows = rows.max(
                shortcut_overlay_lines_with_mode_switch(
                    self.spinner.is_running(),
                    self.plan_mode.is_some(),
                    self.edit_previous_primed,
                )
                .len()
                .min(usize::from(u16::MAX)) as u16,
            );
        }
        rows
    }

    fn centered_overlay_min_height(&self, terminal_width: u16) -> u16 {
        let mut height = 0u16;
        if self.outline_open {
            height = height.max(18);
        }
        if self.keys_overlay.is_some() {
            height = height.max(
                shortcut_overlay_lines_with_mode_switch(false, self.plan_mode.is_some(), false)
                    .len()
                    .min(usize::from(u16::MAX)) as u16
                    + 2,
            );
        }
        if self.transcript_overlay.is_some() {
            height = height.max(18);
        }
        if self.side_question_overlay.is_some() {
            height = height.max(16);
        }
        if let Some(picker) = &self.picker_overlay {
            let rows = picker.matches().len();
            height = height.max(
                picker_overlay_natural_height(rows).saturating_add(
                    (rows.min(PICKER_MAX_ITEMS) as u16)
                        .saturating_mul(picker.item_height().saturating_sub(1)),
                ),
            );
        }
        if self.context_inspector.is_some() {
            height = height.max(CONTEXT_INSPECTOR_HEIGHT);
        }
        if let Some(inspector) = &self.settings_inspector {
            height = height.max(settings_inspector_natural_height(inspector.lines.len()));
        }
        if let Some(dialog) = &self.pending_permission {
            height = height.max(permission_dialog_natural_height(dialog));
        }
        if let Some(dialog) = &self.pending_question {
            height = height.max(question_dialog_natural_height(terminal_width, dialog));
        }
        if self.pending_goal_replacement.is_some() || self.permission_editor.is_some() {
            height = height.max(12);
        }
        height
    }

    fn inline_viewport_heights(
        &mut self,
        terminal_width: u16,
        terminal_height: u16,
    ) -> InlineViewportHeights {
        if self.copy_view.is_some() {
            return InlineViewportHeights {
                base: terminal_height.max(1),
                expanded: terminal_height.max(1),
                reserved_bottom_slack: 0,
                max_top: Some(0),
            };
        }
        let (status_height, pending_input_height) = self.bottom_pane_stack_heights(terminal_width);
        let footer_height = self.footer_height();
        let todo_height = todo_status_height(&self.todos);
        let composer_height = composer_height_for_width_with_limit(
            self,
            terminal_width,
            Some(composer_height_limit_for_terminal(
                terminal_height,
                status_height,
                pending_input_height,
                footer_height,
                todo_height,
            )),
        )
        .max(3);
        let fixed_height = composer_height
            .saturating_add(status_height)
            .saturating_add(pending_input_height)
            .saturating_add(todo_height)
            .saturating_add(footer_height)
            .saturating_add(BOTTOM_PANE_TOP_SPACER);
        let transcript_row_budget = terminal_height.saturating_sub(fixed_height) as usize;
        let transcript_rows = self.transcript_desired_rows(terminal_width, transcript_row_budget);
        let bottom_overlay_rows = self.bottom_overlay_reserved_rows();
        let startup_idle_surface = self.startup_idle_surface_active()
            && transcript_rows > 0
            && status_height == 0
            && pending_input_height == 0
            && bottom_overlay_rows == 0;
        let startup_live_viewport_top_limit = if startup_idle_surface
            || transcript_rows == 0
                && status_height == 0
                && pending_input_height == 0
                && bottom_overlay_rows == 0
        {
            self.startup_live_viewport_top_limit
        } else {
            None
        };
        let base = fixed_height
            .saturating_add(transcript_rows)
            .max(self.centered_overlay_min_height(terminal_width))
            .min(terminal_height.max(1));
        let default_bottom_slack =
            fullscreen_bottom_slack_rows(terminal_height).min(terminal_height.saturating_sub(base));
        let expanded = base
            .saturating_add(bottom_overlay_rows)
            .saturating_add(if startup_idle_surface {
                default_bottom_slack.saturating_mul(2)
            } else {
                0
            })
            .min(terminal_height.max(1));
        InlineViewportHeights {
            base,
            expanded,
            reserved_bottom_slack: default_bottom_slack,
            max_top: startup_live_viewport_top_limit,
        }
    }

    fn centered_overlay_active(&self) -> bool {
        self.copy_view.is_some()
            || self.pending_permission.is_some()
            || self.pending_question.is_some()
            || self.pending_goal_replacement.is_some()
            || self.permission_editor.is_some()
            || self.context_inspector.is_some()
            || self.settings_inspector.is_some()
            || self.keys_overlay.is_some()
            || self.picker_overlay.is_some()
            || self.transcript_overlay.is_some()
            || self.side_question_overlay.is_some()
    }

    #[cfg(test)]
    fn desired_height(&mut self, terminal_width: u16, terminal_height: u16) -> u16 {
        self.inline_viewport_heights(terminal_width, terminal_height)
            .expanded
    }

    #[cfg(test)]
    fn render_transcript_range(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
    ) -> Vec<Line<'static>> {
        self.render_transcript_range_limited(start_idx, end_idx, width, None)
    }

    fn render_transcript_range_hyperlink(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
    ) -> Vec<HyperlinkLine> {
        let end_idx = end_idx.min(self.messages.len());
        if start_idx >= end_idx {
            return Vec::new();
        }

        let visible_messages = &self.messages[start_idx..end_idx];
        let tool_transcript_expanded = self.effective_tool_transcript_expanded();
        let tool_output_expanded = self.effective_tool_output_expanded();
        let render_markdown = self.effective_render_markdown();
        let render_items = collapse_tool_runs_with_recent_expanded(
            visible_messages,
            start_idx,
            !tool_transcript_expanded,
            TOOL_SUMMARY_MIN_RUN_LEN,
            self.recent_turn_transcript_start,
        );
        let mut visible_lines: Vec<HyperlinkLine> = Vec::new();
        for item in render_items {
            match item {
                TranscriptRenderItem::Message {
                    absolute_idx,
                    message,
                } => {
                    let assistant_continuation =
                        assistant_message_is_continuation(&self.messages, absolute_idx);
                    let lines = if let Some(divider) = render_turn_divider_message(message, width) {
                        annotate_web_urls(divider)
                    } else {
                        render_message_hyperlink_continuation(
                            message,
                            MessageRenderOptions {
                                rail: None,
                                is_last_tool: false,
                                expanded: tool_output_expanded,
                                render_markdown,
                                code_theme: &self.code_theme,
                                width: Some(width),
                                assistant_continuation,
                            },
                        )
                    };
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        if !assistant_message_continues_next(&self.messages, absolute_idx) {
                            push_hyperlink_separator_after_message(&mut visible_lines);
                        }
                    }
                }
                TranscriptRenderItem::ToolPair(message) => {
                    let lines = render_message_hyperlink(
                        &message,
                        None,
                        false,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        Some(width),
                    );
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        push_hyperlink_separator_after_message(&mut visible_lines);
                    }
                }
                TranscriptRenderItem::ToolSummary { message, .. } => {
                    let lines = render_message_hyperlink(
                        &message,
                        None,
                        false,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        Some(width),
                    );
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        push_hyperlink_separator_after_message(&mut visible_lines);
                    }
                }
            }
        }
        visible_lines
    }

    fn render_transcript_range_limited(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
        max_lines: Option<usize>,
    ) -> Vec<Line<'static>> {
        self.render_transcript_range_limited_with_mode(
            start_idx,
            end_idx,
            width,
            max_lines,
            LineLimitMode::Head,
        )
    }

    fn render_transcript_range_limited_with_mode(
        &mut self,
        start_idx: usize,
        end_idx: usize,
        width: u16,
        max_lines: Option<usize>,
        limit_mode: LineLimitMode,
    ) -> Vec<Line<'static>> {
        let end_idx = end_idx.min(self.messages.len());
        if start_idx >= end_idx {
            return Vec::new();
        }

        let tool_transcript_expanded = self.effective_tool_transcript_expanded();
        let tool_output_expanded = self.effective_tool_output_expanded();
        let render_markdown = self.effective_render_markdown();
        self.render_cache.invalidate_if_stale(
            width,
            self.messages.render_epoch(),
            render_markdown,
            &self.code_theme,
            tool_output_expanded,
        );

        let visible_messages = &self.messages[start_idx..end_idx];
        let render_items = collapse_tool_runs_with_recent_expanded(
            visible_messages,
            start_idx,
            !tool_transcript_expanded,
            TOOL_SUMMARY_MIN_RUN_LEN,
            self.recent_turn_transcript_start,
        );
        let mut visible_lines: Vec<Line<'static>> = Vec::new();
        for item in render_items {
            match item {
                TranscriptRenderItem::Message {
                    absolute_idx,
                    message,
                } => {
                    let assistant_continuation =
                        assistant_message_is_continuation(&self.messages, absolute_idx);
                    let lines = if let Some(divider) = render_turn_divider_message(message, width) {
                        divider
                    } else {
                        match self.render_cache.get(
                            absolute_idx,
                            None,
                            false,
                            assistant_continuation,
                        ) {
                            Some(cached) => cached.clone(),
                            None => {
                                let rendered = render_message_with_width_continuation(
                                    message,
                                    MessageRenderOptions {
                                        rail: None,
                                        is_last_tool: false,
                                        expanded: tool_output_expanded,
                                        render_markdown,
                                        code_theme: &self.code_theme,
                                        width: Some(width),
                                        assistant_continuation,
                                    },
                                );
                                self.render_cache.insert(
                                    absolute_idx,
                                    None,
                                    false,
                                    assistant_continuation,
                                    rendered.clone(),
                                );
                                rendered
                            }
                        }
                    };
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        if !assistant_message_continues_next(&self.messages, absolute_idx) {
                            push_separator_after_message(&mut visible_lines);
                        }
                    }
                }
                TranscriptRenderItem::ToolPair(message) => {
                    let lines = render_message_with_width(
                        &message,
                        None,
                        false,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        Some(width),
                    );
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        push_separator_after_message(&mut visible_lines);
                    }
                }
                TranscriptRenderItem::ToolSummary { message, .. } => {
                    let lines = render_message_with_width(
                        &message,
                        None,
                        false,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        Some(width),
                    );
                    if !lines.is_empty() {
                        visible_lines.extend(lines);
                        push_separator_after_message(&mut visible_lines);
                    }
                }
            }
            if let Some(max_lines) = max_lines
                && visible_lines.len() >= max_lines
            {
                match limit_mode {
                    LineLimitMode::Head => {
                        visible_lines.truncate(max_lines);
                        break;
                    }
                    LineLimitMode::Tail => {
                        let excess = visible_lines.len().saturating_sub(max_lines);
                        if excess > 0 {
                            visible_lines.drain(..excess);
                        }
                    }
                }
            }
        }
        visible_lines
    }

    fn active_turn_display_messages_for_render(&self) -> Vec<DisplayMessage> {
        if self.agent_view.is_some() {
            return Vec::new();
        }
        let mut messages = self
            .active_turn
            .as_ref()
            .map(|active| active.display_messages(self.effective_active_tools_expanded()))
            .unwrap_or_default();
        if !self.streaming_thinking_status.trim().is_empty() {
            messages.push(DisplayMessage {
                role: MessageRole::System,
                text: format!(
                    "{LIVE_THINKING_MESSAGE_PREFIX}{}",
                    self.streaming_thinking_status
                ),
            });
        }
        messages
    }

    fn render_display_messages_limited_with_mode(
        &mut self,
        visible_messages: &[DisplayMessage],
        width: u16,
        max_lines: Option<usize>,
        limit_mode: LineLimitMode,
        active_from: Option<usize>,
    ) -> Vec<Line<'static>> {
        self.render_display_messages_keyed_with_mode(
            visible_messages,
            width,
            max_lines,
            limit_mode,
            self.effective_tool_output_expanded(),
            active_from,
        )
    }

    fn render_display_messages_keyed_with_mode(
        &mut self,
        visible_messages: &[DisplayMessage],
        width: u16,
        max_lines: Option<usize>,
        limit_mode: LineLimitMode,
        tool_output_expanded: bool,
        active_from: Option<usize>,
    ) -> Vec<Line<'static>> {
        if visible_messages.is_empty() {
            return Vec::new();
        }

        let tool_transcript_expanded = self.effective_tool_transcript_expanded();
        let render_markdown = self.effective_render_markdown();
        let render_items = collapse_tool_runs_with_minimum(
            visible_messages,
            0,
            !tool_transcript_expanded,
            TOOL_SUMMARY_MIN_RUN_LEN,
        );
        let mut visible_lines: Vec<Line<'static>> = Vec::new();
        for item in render_items {
            let block_lines = match item {
                TranscriptRenderItem::Message {
                    absolute_idx,
                    message,
                } => {
                    let is_active = active_from.is_some_and(|start| absolute_idx >= start);
                    if let Some(mut lines) = render_panel_message(
                        &message.text,
                        width,
                        self.subagent_animation_started_at.elapsed(),
                        max_lines,
                    ) {
                        push_separator_after_message(&mut lines);
                        visible_lines.extend(lines);
                        if let Some(max_lines) = max_lines
                            && visible_lines.len() >= max_lines
                        {
                            match limit_mode {
                                LineLimitMode::Head => {
                                    visible_lines.truncate(max_lines);
                                    break;
                                }
                                LineLimitMode::Tail => {
                                    let excess = visible_lines.len().saturating_sub(max_lines);
                                    visible_lines.drain(..excess);
                                }
                            }
                        }
                        continue;
                    }
                    let assistant_continuation =
                        assistant_message_is_continuation(visible_messages, absolute_idx);
                    let assistant_continues_next =
                        assistant_message_continues_next(visible_messages, absolute_idx);
                    // Streaming and completed states share Markdown rules. Code highlighting
                    // reuses incremental state with per-block limits; crossing a message-size
                    // threshold must not remove formatting and color from the whole message.
                    let message_render_markdown = render_markdown;
                    let key = keyed_transcript_block_fingerprint(
                        message,
                        width,
                        tool_output_expanded,
                        message_render_markdown,
                        &self.code_theme,
                        assistant_continuation,
                        assistant_continues_next,
                    );
                    if !is_active
                        && let Some(lines) = self.keyed_transcript_block_render_cache.get(key)
                    {
                        lines
                    } else {
                        let mut lines =
                            if let Some(divider) = render_turn_divider_message(message, width) {
                                divider
                            } else {
                                render_message_with_width_continuation(
                                    message,
                                    MessageRenderOptions {
                                        rail: None,
                                        is_last_tool: false,
                                        expanded: tool_output_expanded,
                                        render_markdown: message_render_markdown,
                                        code_theme: &self.code_theme,
                                        width: Some(width),
                                        assistant_continuation,
                                    },
                                )
                            };
                        if !lines.is_empty() && !assistant_continues_next {
                            push_separator_after_message(&mut lines);
                        }
                        if !is_active {
                            self.keyed_transcript_block_render_cache
                                .insert(key, lines.clone());
                        }
                        lines
                    }
                }
                TranscriptRenderItem::ToolPair(message) => {
                    let key = keyed_transcript_block_fingerprint(
                        &message,
                        width,
                        tool_output_expanded,
                        render_markdown,
                        &self.code_theme,
                        false,
                        false,
                    );
                    if let Some(lines) = self.keyed_transcript_block_render_cache.get(key) {
                        lines
                    } else {
                        let mut lines = render_message_with_width(
                            &message,
                            None,
                            false,
                            tool_output_expanded,
                            render_markdown,
                            &self.code_theme,
                            Some(width),
                        );
                        if !lines.is_empty() {
                            push_separator_after_message(&mut lines);
                        }
                        self.keyed_transcript_block_render_cache
                            .insert(key, lines.clone());
                        lines
                    }
                }
                TranscriptRenderItem::ToolSummary {
                    absolute_idx,
                    message,
                } => {
                    let animate = self.spinner.is_running()
                        && active_from.is_some_and(|start| absolute_idx >= start);
                    if animate {
                        let indicator =
                            motion::tool_summary_frame(self.spinner.snapshot().phase_elapsed);
                        let mut lines =
                            render_tool_summary_message(&message, indicator, &self.code_theme);
                        if !lines.is_empty() {
                            push_separator_after_message(&mut lines);
                        }
                        lines
                    } else {
                        let key = keyed_transcript_block_fingerprint(
                            &message,
                            width,
                            tool_output_expanded,
                            render_markdown,
                            &self.code_theme,
                            false,
                            false,
                        );
                        if let Some(lines) = self.keyed_transcript_block_render_cache.get(key) {
                            lines
                        } else {
                            let mut lines = render_message_with_width(
                                &message,
                                None,
                                false,
                                tool_output_expanded,
                                render_markdown,
                                &self.code_theme,
                                Some(width),
                            );
                            if !lines.is_empty() {
                                push_separator_after_message(&mut lines);
                            }
                            self.keyed_transcript_block_render_cache
                                .insert(key, lines.clone());
                            lines
                        }
                    }
                }
            };
            if !block_lines.is_empty() {
                visible_lines.extend(block_lines);
            }
            if let Some(max_lines) = max_lines
                && visible_lines.len() >= max_lines
            {
                match limit_mode {
                    LineLimitMode::Head => {
                        visible_lines.truncate(max_lines);
                        break;
                    }
                    LineLimitMode::Tail => {
                        let excess = visible_lines.len().saturating_sub(max_lines);
                        if excess > 0 {
                            visible_lines.drain(..excess);
                        }
                    }
                }
            }
        }
        visible_lines
    }

    fn render_active_turn_lines(&mut self, width: u16) -> Vec<Line<'static>> {
        if self.agent_view.is_some() {
            self.active_turn_render_cache = None;
            return Vec::new();
        }
        if self.active_turn.is_none() && self.streaming_thinking_status.trim().is_empty() {
            self.active_turn_render_cache = None;
            return Vec::new();
        }

        let active_tools_expanded = self.effective_active_tools_expanded();
        let tool_transcript_expanded = self.effective_tool_transcript_expanded();
        let render_markdown = self.effective_render_markdown();
        let active_messages = self.active_turn_display_messages_for_render();
        let key = ActiveTurnRenderCacheKey {
            active_render_revision: self.active_turn_render_revision,
            active_tools_expanded,
            tool_transcript_expanded,
            render_markdown,
            code_theme: self.code_theme.clone(),
            width,
            tool_summary_indicator: self.active_tool_summary_indicator(),
        };
        if let Some(cache) = self
            .active_turn_render_cache
            .as_ref()
            .filter(|cache| cache.key == key)
        {
            return cache.lines.clone();
        }

        let visible_lines = self.render_display_messages_keyed_with_mode(
            &active_messages,
            width,
            None,
            LineLimitMode::Head,
            active_tools_expanded,
            Some(0),
        );

        self.active_turn_render_cache = Some(ActiveTurnRenderCache {
            key,
            lines: visible_lines.clone(),
        });
        visible_lines
    }

    pub fn push_message(&mut self, role: MessageRole, text: impl Into<String>) {
        let text = sanitize_tui_text(&text.into());
        if display_text_is_hidden_internal_context(&text, role == MessageRole::User) {
            return;
        }
        self.preserve_review_before_content_change();
        self.messages.push(DisplayMessage { role, text });
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    pub(crate) fn clear_conversation_ui(&mut self, engine: &QueryEngine) -> bool {
        if let Err(error) = engine.start_new_session() {
            self.push_message(MessageRole::System, format!("无法新建会话：{error}"));
            return false;
        }
        self.reset_transcript_state_after_clear();
        engine.active_skills.write().unwrap().clear();
        self.refresh_engine_metadata(engine);
        self.push_message(
            MessageRole::System,
            "Conversation cleared. Type /help for available commands.",
        );
        true
    }

    fn edit_previous_message(&mut self, engine: &QueryEngine) {
        self.clear_edit_previous_prompt();
        let state_messages = engine.state.messages();
        // Skip hidden internal user messages (goal continuations, sub-agent
        // follow-up nudges): they are user-role in engine state but never
        // appear in the UI transcript. Editing one would leak the internal
        // scaffolding into the composer and desync the two truncation points.
        let Some(state_index) = state_messages.iter().rposition(|message| {
            matches!(message, Message::User { .. }) && !message_is_hidden_internal_context(message)
        }) else {
            self.push_message(MessageRole::System, "No previous message to edit.");
            return;
        };
        let prefill = editable_user_message_text(&state_messages[state_index]);

        let mut truncated_state = state_messages;
        truncated_state.truncate(state_index);
        engine.state.set_messages(truncated_state);

        if let Some(ui_index) = self
            .messages
            .iter()
            .rposition(|message| message.role == MessageRole::User)
        {
            self.messages.truncate(ui_index);
        }
        self.reset_transcript_derived_after_rewrite();
        self.prefill_input(prefill);
    }

    fn last_assistant_response_text(&self) -> Option<&str> {
        self.messages
            .iter()
            .rev()
            .find(|message| message.role == MessageRole::Assistant && !message.text.is_empty())
            .map(|message| message.text.as_str())
    }

    pub(crate) fn copy_last_assistant_response(&mut self) {
        self.copy_last_assistant_response_with(clipboard_copy::copy_to_clipboard);
    }

    fn copy_last_assistant_response_with(
        &mut self,
        copy_fn: impl FnOnce(&str) -> std::result::Result<clipboard_copy::ClipboardCopyResult, String>,
    ) {
        match self.last_assistant_response_text().map(str::to_string) {
            Some(text) => match copy_fn(&text) {
                Ok(result) => {
                    let (lease, copy_kind) = result.into_parts();
                    self.clipboard_lease = lease;
                    if copy_kind == clipboard_copy::ClipboardCopyKind::Osc52 {
                        self.push_message(MessageRole::System, clipboard_copy::OSC52_COPY_NOTICE)
                    } else {
                        self.push_message(MessageRole::System, "Copied last message to clipboard")
                    }
                }
                Err(error) => {
                    self.push_message(MessageRole::System, format!("Copy failed: {error}"))
                }
            },
            None => self.push_message(MessageRole::System, "No agent response to copy"),
        }
    }

    fn composer_text_for_external_editor(&self) -> String {
        expand_pending_pastes(&self.input, &self.pending_pastes)
    }

    fn apply_external_edit(&mut self, text: impl AsRef<str>) {
        self.reset_input_history_navigation();
        let normalized = text.as_ref().replace("\r\n", "\n").replace('\r', "\n");
        self.input = sanitize_tui_text(&normalized);
        self.pending_pastes.clear();
        self.cursor_grapheme_index = self.input_graphemes().len();
        self.input_scroll_row = 0;
        self.sync_composer_sidecars();
        self.clamp_input_scroll(self.last_input_width);
        self.force_next_viewport_redraw();
    }

    fn resolve_external_editor_command_or_report(&mut self) -> Option<Vec<String>> {
        Some(match external_editor::resolve_editor_command() {
            Ok(cmd) => cmd,
            Err(external_editor::EditorError::MissingEditor) => {
                self.push_message(
                    MessageRole::System,
                    "Cannot open external editor: set $VISUAL or $EDITOR before starting KCoder.",
                );
                return None;
            }
            Err(error) => {
                self.push_message(
                    MessageRole::System,
                    format!("Failed to open editor: {error}"),
                );
                return None;
            }
        })
    }

    fn finish_external_editor_result(&mut self, result: Result<String>) {
        match result {
            Ok(edited) => self.apply_external_edit(edited.trim_end()),
            Err(error) => self.push_message(
                MessageRole::System,
                format!("Failed to open editor: {error:#}"),
            ),
        }
    }

    async fn open_external_editor(&mut self) {
        let Some(editor_cmd) = self.resolve_external_editor_command_or_report() else {
            return;
        };
        let seed = self.composer_text_for_external_editor();
        let result = external_editor::run_editor(&seed, &editor_cmd).await;
        self.finish_external_editor_result(result);
    }

    async fn open_external_editor_with_restored_terminal<B: Backend + Write>(
        &mut self,
        terminal: &mut Terminal<B>,
        terminal_guard: &mut TerminalGuard,
        terminal_events: &TerminalEventController,
        frame_requester: &FrameRequester,
    ) -> Result<()> {
        let Some(editor_cmd) = self.resolve_external_editor_command_or_report() else {
            return Ok(());
        };
        let seed = self.composer_text_for_external_editor();

        terminal_events.pause().await;
        terminal
            .reset_cursor_style()
            .context("failed to reset cursor style before external editor")?;
        let _ = terminal.show_cursor();
        std::io::Write::flush(terminal.backend_mut())
            .context("failed to flush terminal before external editor")?;
        let restored_state = terminal_guard.restore_for_external_program_keep_raw();

        let editor_result = external_editor::run_editor(&seed, &editor_cmd).await;

        let reenter_result = terminal_guard
            .reenter_after_external_program(restored_state)
            .context("failed to re-enter KCoder terminal after external editor");
        flush_terminal_input_buffer();
        terminal_events.resume();
        terminal.invalidate_viewport();
        self.force_next_viewport_redraw();
        frame_requester.schedule_frame();
        self.finish_external_editor_result(editor_result);
        reenter_result
    }

    fn push_committed_active_message(&mut self, role: MessageRole, text: impl Into<String>) {
        self.push_committed_active_message_with_merge(role, text, true);
    }

    fn push_committed_stream_chunk(&mut self, role: MessageRole, text: impl Into<String>) {
        if role == MessageRole::Assistant && self.streaming_transcript_start.is_none() {
            self.streaming_transcript_start = Some(self.messages.len());
        }
        self.push_committed_active_message_with_merge(role, text, false);
    }

    fn push_committed_active_message_with_merge(
        &mut self,
        role: MessageRole,
        text: impl Into<String>,
        merge_assistant: bool,
    ) {
        self.preserve_review_before_content_change();
        let text = sanitize_tui_text(&text.into());
        if merge_assistant
            && role == MessageRole::Assistant
            && self.messages.len() > self.scrollback_committed_until
            && self.messages.append_to_last_assistant(&text)
        {
            if self.transcript_viewport.is_at_tail() {
                self.snap_to_bottom();
            }
            return;
        }
        self.push_message(role, text);
    }

    fn active_turn_contains_assistant_text(&self) -> bool {
        self.active_turn.as_ref().is_some_and(|active| {
            active
                .entries
                .iter()
                .any(|entry| matches!(entry, ActiveEntry::Text(_)))
        })
    }

    fn consolidate_finished_assistant_stream(&mut self) -> bool {
        if self.active_turn_contains_assistant_text() {
            return false;
        }
        let Some(stream_start) = self.streaming_transcript_start else {
            return false;
        };
        let touches_committed_scrollback = stream_start < self.scrollback_committed_until;
        if touches_committed_scrollback {
            self.streaming_transcript_start = None;
            return false;
        }

        let consolidated = self
            .messages
            .consolidate_trailing_assistant_run_from(stream_start)
            .is_some();
        self.streaming_transcript_start = None;
        if !consolidated {
            return false;
        }
        self.render_cache.clear();
        self.active_turn_render_cache = None;

        if touches_committed_scrollback {
            self.transcript_reflow.clear();
        }
        self.scrollback_committed_until = self.scrollback_committed_until.min(self.messages.len());
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
        true
    }

    fn scrollback_commit_target(&self, committed_until: usize) -> usize {
        let committed_until = committed_until.min(self.messages.len());
        let natural = transcript_scrollback_commit_target(self.messages.len(), committed_until);
        self.messages
            .iter()
            .enumerate()
            .skip(committed_until)
            .take(natural.saturating_sub(committed_until))
            .find_map(|(index, message)| {
                decode_panel_message(&message.text)
                    .is_some_and(|panel| !panel.all_terminal())
                    .then_some(index)
            })
            .unwrap_or(natural)
    }

    fn scrollback_commit_target_for_viewport(
        &self,
        committed_until: usize,
        _width: u16,
        visible_rows: usize,
    ) -> usize {
        let committed_until = committed_until.min(self.messages.len());
        let natural = self.scrollback_commit_target(committed_until);
        if self.inline_turn_uses_live_tail()
            && let Some(turn_start) = self.recent_turn_transcript_start
        {
            // Inline mode may move earlier current-turn content into native scrollback, while
            // retaining roughly one viewport of the newest tail so changes remain visible.
            // Release the holdback and archive the complete tail when the turn finishes.
            let retained_messages = visible_rows.clamp(1, TRANSCRIPT_RENDER_MAX_MESSAGES);
            return natural
                .saturating_sub(retained_messages)
                .max(turn_start)
                .max(committed_until)
                .min(natural);
        }
        natural
    }

    pub(crate) fn replace_transcript_from_history(&mut self, messages: &[Message]) {
        self.path_previews.clear();
        self.deferred_resumed_transcript = None;
        let prior_subagent_members = self
            .subagent_panels
            .values()
            .flat_map(|panel| panel.members.iter())
            .map(|member| (member.tool_call_id.clone(), member.clone()))
            .collect::<HashMap<_, _>>();
        self.messages.clear();
        self.scrollback_committed_until = 0;
        self.welcome_scrollback_committed = false;
        self.startup_live_viewport_top_limit = None;
        self.transcript_reflow.clear();
        self.render_cache.clear();
        self.transcript_viewport.replace_content();
        self.active_turn = None;
        self.bump_active_turn_render_revision();
        self.active_turn_render_cache = None;
        self.clear_streaming_presentation_state();
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.streaming_transcript_start = None;
        self.recent_turn_transcript_start = None;
        self.clear_subagent_panel_state();

        let tool_uses = collect_tool_use_lookup(messages);
        let tool_results = messages
            .iter()
            .flat_map(|message| match message {
                Message::User { content } | Message::Assistant { content, .. } => content.iter(),
            })
            .filter_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => Some((
                    tool_use_id.clone(),
                    (content_blocks_text(content), is_error.unwrap_or(false)),
                )),
                _ => None,
            })
            .collect::<HashMap<_, _>>();
        for msg in messages {
            if message_is_hidden_internal_context(msg) {
                continue;
            }
            self.push_history_message(msg, &tool_uses, &tool_results);
        }
        let panel_ids = self.subagent_panels.keys().copied().collect::<Vec<_>>();
        for panel_id in panel_ids {
            if let Some(panel) = self.subagent_panels.get_mut(&panel_id) {
                for member in &mut panel.members {
                    let Some(prior) = prior_subagent_members.get(&member.tool_call_id) else {
                        continue;
                    };
                    if member.phase.is_terminal() || prior.phase.is_terminal() {
                        continue;
                    }
                    member.phase = prior.phase;
                    member.delivery = prior.delivery;
                    member.status_text = prior.status_text.clone();
                    member.latest_model_text = prior.latest_model_text.clone();
                    member.current = prior.current;
                    member.total = prior.total;
                    if member.agent_id.is_none() {
                        member.agent_id = prior.agent_id.clone();
                    }
                }
            }
            self.sync_subagent_panel(panel_id);
        }
        self.snap_to_bottom();
        self.force_next_viewport_redraw();
    }

    fn replace_transcript_from_resumed_tail(
        &mut self,
        messages: &[Message],
        history: PreparedTranscriptHistory,
        loaded_start: usize,
    ) {
        self.replace_transcript_from_history(messages);
        if loaded_start > 0 {
            self.deferred_resumed_transcript = Some(DeferredResumedTranscript {
                history,
                loaded_display_len: self.messages.len(),
            });
        }
    }

    fn push_history_message(
        &mut self,
        message: &Message,
        tool_uses: &HashMap<String, (String, String)>,
        tool_results: &HashMap<String, (String, bool)>,
    ) {
        match message {
            Message::User { content }
                if Self::user_content_blocks_can_merge_for_display(content) =>
            {
                let text = content_blocks_text(content);
                if !text.is_empty() {
                    self.push_message(MessageRole::User, text);
                }
            }
            Message::User { content } => {
                for block in content {
                    self.push_history_block(MessageRole::User, block, tool_uses);
                }
            }
            Message::Assistant { content, .. } => {
                let mut panel = None;
                for block in content {
                    if let ContentBlock::ToolUse { id, name, input } = block
                        && history_tool_starts_subagent_panel(name, id, tool_results)
                    {
                        let current = panel.get_or_insert_with(|| {
                            let panel_id = self.next_subagent_panel_id;
                            self.next_subagent_panel_id =
                                self.next_subagent_panel_id.wrapping_add(1).max(1);
                            SubagentPanel::new(panel_id)
                        });
                        current.add_pending(
                            id.clone(),
                            subagent_item_text(name, &input.to_string()),
                            subagent_requested_delivery(&input.to_string()),
                        );
                        if let Some((output, is_error)) = tool_results.get(id) {
                            let result = parse_subagent_result(output, *is_error);
                            if let Some(agent_id) = result.agent_id.as_deref() {
                                current.associate(
                                    id,
                                    agent_id,
                                    if result.background {
                                        SubagentDelivery::Background
                                    } else {
                                        SubagentDelivery::Foreground
                                    },
                                );
                                if let Some(detail) = result.detail.as_deref() {
                                    current.update_progress(
                                        agent_id,
                                        "Writing response",
                                        Some(detail),
                                        None,
                                        None,
                                    );
                                }
                                match result.status.as_str() {
                                    "running" | "resuming" => {
                                        if result.background {
                                            current.promote(agent_id);
                                        } else {
                                            current.update_progress(
                                                agent_id, "Running", None, None, None,
                                            );
                                        }
                                    }
                                    "failed" => {
                                        current.finish(agent_id, SubagentPhase::Failed, "Failed");
                                    }
                                    "cancelled" => {
                                        current.finish(
                                            agent_id,
                                            SubagentPhase::Cancelled,
                                            "Cancelled",
                                        );
                                    }
                                    _ => {
                                        current.finish(
                                            agent_id,
                                            SubagentPhase::Completed,
                                            "Completed",
                                        );
                                    }
                                }
                            } else if !matches!(result.status.as_str(), "running" | "resuming") {
                                let (phase, label) = match result.status.as_str() {
                                    "failed" => (SubagentPhase::Failed, "Failed"),
                                    "cancelled" => (SubagentPhase::Cancelled, "Cancelled"),
                                    _ => (SubagentPhase::Completed, "Completed"),
                                };
                                current.finish_tool_call(id, phase, label);
                            }
                        }
                        continue;
                    }
                    self.commit_replayed_subagent_panel(panel.take());
                    self.push_history_block(MessageRole::Assistant, block, tool_uses);
                }
                self.commit_replayed_subagent_panel(panel);
            }
        }
    }

    fn commit_replayed_subagent_panel(&mut self, panel: Option<SubagentPanel>) {
        let Some(panel) = panel else {
            return;
        };
        for member in &panel.members {
            if let Some(agent_id) = member.agent_id.as_ref() {
                self.subagent_panel_by_agent
                    .insert(agent_id.clone(), panel.id);
            }
        }
        self.subagent_panels.insert(panel.id, panel.clone());
        self.push_message(MessageRole::System, panel.encode_message());
    }

    fn user_content_blocks_can_merge_for_display(content: &[ContentBlock]) -> bool {
        content.iter().all(|block| {
            matches!(
                block,
                ContentBlock::Text { .. }
                    | ContentBlock::Image { .. }
                    | ContentBlock::Thinking { .. }
                    | ContentBlock::RedactedThinking { .. }
            )
        })
    }

    fn push_history_block(
        &mut self,
        message_role: MessageRole,
        block: &ContentBlock,
        tool_uses: &HashMap<String, (String, String)>,
    ) {
        match block {
            ContentBlock::Text { text } => {
                if !text.is_empty() {
                    self.push_message(message_role, text.clone());
                }
            }
            ContentBlock::ToolUse { name, input, .. } => {
                self.push_message(
                    MessageRole::System,
                    format_tool_use(name, &input.to_string()),
                );
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let output = content_blocks_text(content);
                let (name, input) = tool_uses
                    .get(tool_use_id)
                    .cloned()
                    .unwrap_or_else(|| (tool_use_id.clone(), String::new()));
                if is_subagent_tool_name(&name)
                    || (is_send_message_tool_name(&name)
                        && matches!(
                            parse_subagent_result(&output, is_error.unwrap_or(false))
                                .status
                                .as_str(),
                            "running" | "resuming"
                        ))
                {
                    return;
                }
                let (_, status_text, diff_text) = format_completed_tool_display(
                    &name,
                    &input,
                    &output,
                    is_error.unwrap_or(false),
                );
                if !status_text.is_empty() {
                    self.push_message(MessageRole::System, status_text);
                }
                if let Some(diff) = diff_text {
                    self.push_message(MessageRole::System, diff);
                }
            }
            ContentBlock::Image { source } => {
                self.push_message(message_role, format!("[image: {}]", source.media_type));
            }
            ContentBlock::Thinking { thinking, .. } => {
                if let Some(summary) = reasoning_summary_text(thinking) {
                    self.push_message(MessageRole::System, summary);
                }
            }
            ContentBlock::RedactedThinking { .. } => {}
        }
    }

    fn set_input_history_path(&mut self, path: std::path::PathBuf) {
        self.input_history_path = Some(path);
    }

    fn load_input_history(&mut self) {
        let Some(path) = self.input_history_path.as_ref() else {
            return;
        };
        if !path.exists() {
            return;
        }
        match load_input_history_file(path) {
            Ok(history) => self.input_history = history,
            Err(e) => warn!("failed to load input history: {}", e),
        }
    }

    fn push_input_history(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        if self.input_history.last().map(String::as_str) != Some(&text) {
            self.input_history.push(text);
            if self.input_history.len() > INPUT_HISTORY_MAX_ENTRIES {
                self.input_history.remove(0);
            }
        }
        if let Some(path) = self.input_history_path.clone() {
            let history = self.input_history.clone();
            let save_lock = Arc::clone(&self.input_history_save_lock);
            let save_revision = Arc::clone(&self.input_history_save_revision);
            let revision = save_revision.fetch_add(1, Ordering::AcqRel) + 1;
            tokio::task::spawn_blocking(move || {
                let _guard = match save_lock.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if save_revision.load(Ordering::Acquire) != revision {
                    return;
                }
                if let Err(e) = save_input_history_file(&path, &history) {
                    warn!("failed to save input history: {}", e);
                }
            });
        }
    }

    fn reset_input_history_navigation(&mut self) {
        self.input_history_index = None;
        self.input_history_draft = None;
    }

    fn composer_draft_snapshot(&self) -> ComposerDraftSnapshot {
        ComposerDraftSnapshot {
            input: self.input.clone(),
            cursor_grapheme_index: self.cursor_grapheme_index,
            pending_pastes: self.pending_pastes.clone(),
            local_image_attachments: self.local_image_attachments.clone(),
            remote_image_urls: self.remote_image_urls.clone(),
            selected_remote_image_index: self.selected_remote_image_index,
        }
    }

    fn restore_composer_draft(&mut self, draft: ComposerDraftSnapshot) {
        self.input = draft.input;
        self.cursor_grapheme_index = draft
            .cursor_grapheme_index
            .min(self.input.graphemes(true).count());
        self.pending_pastes = draft.pending_pastes;
        self.local_image_attachments = draft.local_image_attachments;
        self.remote_image_urls = draft.remote_image_urls;
        self.selected_remote_image_index = draft.selected_remote_image_index;
        self.input_scroll_row = 0;
        self.sync_composer_sidecars();
        self.clamp_input_scroll(self.last_input_width);
    }

    fn input_history_status_label(&self) -> String {
        let Some(idx) = self.input_history_index else {
            return String::new();
        };
        if self.input_history.is_empty() {
            return String::new();
        }
        format!(
            "history {}/{}",
            idx.saturating_add(1).min(self.input_history.len()),
            self.input_history.len()
        )
    }

    fn recall_previous_input(&mut self) -> bool {
        if self.input_history.is_empty() {
            return false;
        }
        if self.input_history_index.is_none() {
            self.input_history_draft = Some(self.composer_draft_snapshot());
            self.input_history_index = Some(self.input_history.len().saturating_sub(1));
        } else if let Some(idx) = self.input_history_index
            && idx > 0
        {
            self.input_history_index = Some(idx - 1);
        }
        self.apply_history_recall();
        true
    }

    fn recall_next_input(&mut self) -> bool {
        let Some(idx) = self.input_history_index else {
            return false;
        };
        if idx + 1 < self.input_history.len() {
            self.input_history_index = Some(idx + 1);
            self.apply_history_recall();
        } else {
            self.input_history_index = None;
            if let Some(draft) = self.input_history_draft.take() {
                self.restore_composer_draft(draft);
            } else {
                self.cursor_grapheme_index = self.input_graphemes().len();
            }
        }
        true
    }

    fn apply_history_recall(&mut self) {
        if let Some(idx) = self.input_history_index
            && let Some(text) = self.input_history.get(idx).cloned()
        {
            self.input = text;
            self.pending_pastes.clear();
            self.local_image_attachments.clear();
            self.remote_image_urls.clear();
            self.selected_remote_image_index = None;
            self.cursor_grapheme_index = self.input_graphemes().len();
            self.input_scroll_row = 0;
            self.clamp_input_scroll(self.last_input_width);
        }
    }

    fn insert_text_at_cursor(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.reset_input_history_navigation();
        let byte_pos = self.byte_index_for_grapheme(self.cursor_grapheme_index);
        self.input.insert_str(byte_pos, text);
        self.cursor_grapheme_index += text.graphemes(true).count();
        self.clamp_input_scroll(self.last_input_width);
    }

    fn enter_shell_prompt_mode_if_requested(&mut self, key: KeyEvent) -> bool {
        if key.code != KeyCode::Char('!')
            || !key.modifiers.is_empty()
            || !self.composer_is_empty_for_shortcuts()
        {
            return false;
        }

        self.reset_input_history_navigation();
        self.input = "!".to_string();
        self.cursor_grapheme_index = 1;
        self.input_scroll_row = 0;
        self.force_next_viewport_redraw();
        true
    }

    fn enter_slash_menu_if_requested(&mut self, key: KeyEvent) -> bool {
        if key.code != KeyCode::Char('/')
            || !key.modifiers.is_empty()
            || !self.composer_is_empty_for_shortcuts()
        {
            return false;
        }

        self.reset_input_history_navigation();
        self.input = "/".to_string();
        self.cursor_grapheme_index = 1;
        self.input_scroll_row = 0;
        self.open_slash_menu();
        self.force_next_viewport_redraw();
        true
    }

    fn insert_newline_at_cursor(&mut self) {
        self.insert_text_at_cursor("\n");
        self.sync_composer_sidecars();
    }

    pub(crate) fn prefill_input(&mut self, text: String) {
        self.reset_input_history_navigation();
        self.input = text;
        self.pending_pastes.clear();
        self.remote_image_urls.clear();
        self.selected_remote_image_index = None;
        self.cursor_grapheme_index = self.input_graphemes().len();
        self.input_scroll_row = 0;
        self.sync_composer_sidecars();
        self.clamp_input_scroll(self.last_input_width);
    }

    fn prune_pending_pastes(&mut self) {
        self.pending_pastes
            .retain(|(placeholder, _)| self.input.contains(placeholder));
    }

    fn sync_composer_sidecars(&mut self) {
        self.prune_pending_pastes();
        self.sync_remote_image_selection();
        self.sync_local_image_attachments();
        self.sync_mention_menu();
        self.sync_slash_menu();
    }

    fn sync_remote_image_selection(&mut self) {
        if self.remote_image_urls.is_empty() {
            self.selected_remote_image_index = None;
        } else if let Some(selected) = self.selected_remote_image_index {
            self.selected_remote_image_index = Some(selected.min(self.remote_image_urls.len() - 1));
        }
    }

    fn clear_remote_image_selection(&mut self) {
        if self.selected_remote_image_index.take().is_some() {
            self.force_next_viewport_redraw();
        }
    }

    fn remove_selected_remote_image(&mut self, selected_index: usize) {
        if selected_index >= self.remote_image_urls.len() {
            self.clear_remote_image_selection();
            return;
        }

        self.remote_image_urls.remove(selected_index);
        self.selected_remote_image_index = if self.remote_image_urls.is_empty() {
            None
        } else {
            Some(selected_index.min(self.remote_image_urls.len() - 1))
        };
        self.relabel_local_image_attachments();
        self.force_next_viewport_redraw();
    }

    fn handle_remote_image_selection_key(&mut self, key: KeyEvent) -> bool {
        if self.remote_image_urls.is_empty()
            || key.modifiers != KeyModifiers::NONE
            || key.kind != KeyEventKind::Press
        {
            return false;
        }

        match key.code {
            KeyCode::Up => {
                if let Some(selected) = self.selected_remote_image_index {
                    self.selected_remote_image_index = Some(selected.saturating_sub(1));
                    self.force_next_viewport_redraw();
                    true
                } else if self.cursor_grapheme_index == 0 {
                    self.selected_remote_image_index = Some(self.remote_image_urls.len() - 1);
                    self.force_next_viewport_redraw();
                    true
                } else {
                    false
                }
            }
            KeyCode::Down => {
                if let Some(selected) = self.selected_remote_image_index {
                    if selected + 1 < self.remote_image_urls.len() {
                        self.selected_remote_image_index = Some(selected + 1);
                    } else {
                        self.selected_remote_image_index = None;
                    }
                    self.force_next_viewport_redraw();
                    true
                } else {
                    false
                }
            }
            KeyCode::Delete | KeyCode::Backspace => {
                if let Some(selected) = self.selected_remote_image_index {
                    self.remove_selected_remote_image(selected);
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    fn sync_local_image_attachments(&mut self) {
        if self.local_image_attachments.is_empty() {
            return;
        }

        let input = self.input.clone();
        let mut kept_images = Vec::new();
        for image in self.local_image_attachments.drain(..) {
            if input.contains(&image.placeholder) {
                kept_images.push(image);
            }
        }
        self.local_image_attachments = kept_images;
        self.relabel_local_image_attachments();
        let max_cursor = self.input_graphemes().len();
        self.cursor_grapheme_index = self.cursor_grapheme_index.min(max_cursor);
        self.clamp_input_scroll(self.last_input_width);
    }

    fn relabel_local_image_attachments(&mut self) {
        for index in 0..self.local_image_attachments.len() {
            let expected = local_image_placeholder(self.remote_image_urls.len() + index + 1);
            let image = &mut self.local_image_attachments[index];
            if image.placeholder == expected {
                continue;
            }
            self.input = self.input.replace(&image.placeholder, &expected);
            image.placeholder = expected;
        }
    }

    fn next_large_paste_placeholder(&self, char_count: usize) -> String {
        let base = format!("[Pasted Content {char_count} chars]");
        let prefix = format!("{base} #");
        let mut max_suffix = 0usize;

        for (placeholder, _) in &self.pending_pastes {
            if placeholder == &base {
                max_suffix = max_suffix.max(1);
                continue;
            }
            if let Some(suffix) = placeholder.strip_prefix(&prefix)
                && let Ok(value) = suffix.parse::<usize>()
            {
                max_suffix = max_suffix.max(value);
            }
        }

        if max_suffix == 0 {
            base
        } else {
            format!("{base} #{}", max_suffix + 1)
        }
    }

    fn insert_large_paste_placeholder(&mut self, pasted: String) {
        let char_count = pasted.chars().count();
        let placeholder = self.next_large_paste_placeholder(char_count);
        self.pending_pastes.push((placeholder.clone(), pasted));
        self.insert_text_at_cursor(&placeholder);
    }

    fn handle_paste_text(&mut self, pasted: &str) -> Result<()> {
        let normalized = pasted.replace("\r\n", "\n").replace('\r', "\n");
        let sanitized = sanitize_tui_text(&normalized);
        if sanitized.chars().count() > LARGE_PASTE_CHAR_THRESHOLD {
            self.insert_large_paste_placeholder(sanitized);
        } else if !self.try_attach_pasted_image(&sanitized)? {
            self.insert_text_at_cursor(&sanitized);
        }
        self.sync_composer_sidecars();
        Ok(())
    }

    fn handle_paste_text_for_active_overlay(&mut self, pasted: &str) -> bool {
        if self.history_search.is_some() {
            if let Some(query) = normalize_pasted_search_query(pasted) {
                let search = self.history_search.take().unwrap();
                let mut next_query = search.query.clone();
                next_query.push_str(&query);
                self.update_history_search_query(search, next_query);
            }
            return true;
        }

        if let Some(picker) = self.resume_session_picker.as_mut() {
            if let Some(query) = normalize_pasted_search_query(pasted) {
                picker.filter.push_str(&query);
                picker.selected = 0;
            }
            return true;
        }

        if let Some(picker) = self.picker_overlay.as_mut() {
            if let Some(query) = normalize_pasted_search_query(pasted) {
                picker.filter.push_str(&query);
                picker.selected = 0;
            }
            return true;
        }

        if let Some(editor) = self.permission_editor.as_mut() {
            let normalized = pasted.replace("\r\n", "\n").replace('\r', "\n");
            let sanitized = sanitize_tui_text(&normalized);
            if !sanitized.is_empty() {
                let byte_pos = byte_index_for_grapheme(&editor.text, editor.cursor_grapheme_index);
                editor.text.insert_str(byte_pos, &sanitized);
                editor.cursor_grapheme_index += sanitized.graphemes(true).count();
            }
            return true;
        }

        self.has_active_overlay()
    }

    fn try_attach_pasted_image(&mut self, pasted: &str) -> Result<bool> {
        let Some(path) = pasted_image_path(pasted, Path::new(&self.display_cwd)) else {
            return Ok(false);
        };
        let Some(media_type) = image_media_type(&path) else {
            return Ok(false);
        };
        let metadata = match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => return Ok(false),
        };
        if self.local_image_attachments.len() >= MAX_IMAGE_ATTACHMENTS {
            anyhow::bail!("maximum image attachments reached ({MAX_IMAGE_ATTACHMENTS})");
        }
        if metadata.len() > MAX_IMAGE_BYTES {
            anyhow::bail!(
                "image {} is larger than {} MB",
                path.display(),
                MAX_IMAGE_BYTES / 1024 / 1024
            );
        }

        let placeholder = local_image_placeholder(
            self.remote_image_urls.len() + self.local_image_attachments.len() + 1,
        );
        self.local_image_attachments.push(LocalImageAttachment {
            path,
            placeholder: placeholder.clone(),
            media_type: media_type.to_string(),
            clipboard_image: None,
        });
        self.insert_text_at_cursor(&format!("{placeholder} "));
        Ok(true)
    }

    fn attach_clipboard_image(&mut self, image: ClipboardImage) -> Result<()> {
        if self.local_image_attachments.len() >= MAX_IMAGE_ATTACHMENTS {
            anyhow::bail!("maximum image attachments reached ({MAX_IMAGE_ATTACHMENTS})");
        }
        let path = image.path().to_path_buf();
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("failed to inspect clipboard image {}", path.display()))?;
        if metadata.len() > MAX_IMAGE_BYTES {
            anyhow::bail!(
                "clipboard image is larger than {} MB after compression",
                MAX_IMAGE_BYTES / 1024 / 1024
            );
        }
        let placeholder = local_image_placeholder(
            self.remote_image_urls.len() + self.local_image_attachments.len() + 1,
        );
        self.local_image_attachments.push(LocalImageAttachment {
            path,
            placeholder: placeholder.clone(),
            media_type: "image/png".to_string(),
            clipboard_image: Some(image),
        });
        self.insert_text_at_cursor(&format!("{placeholder} "));
        self.sync_composer_sidecars();
        Ok(())
    }

    fn take_submitted_message(&mut self) -> SubmittedMessage {
        self.sync_composer_sidecars();
        let visible_text = self.input.trim().to_string();
        let text = expand_pending_pastes(&visible_text, &self.pending_pastes);
        let pending_pastes = self.pending_pastes.clone();
        let remote_image_urls = self.remote_image_urls.clone();
        let images = self
            .local_image_attachments
            .iter()
            .filter(|image| visible_text.contains(&image.placeholder))
            .cloned()
            .collect();
        self.local_image_attachments.clear();
        self.remote_image_urls.clear();
        self.selected_remote_image_index = None;
        self.pending_pastes.clear();
        SubmittedMessage {
            visible_text,
            text,
            images,
            remote_image_urls,
            pending_pastes,
        }
    }

    fn submit_composer_input(&mut self) -> Option<UserAction> {
        if self.input.trim().is_empty()
            && self.local_image_attachments.is_empty()
            && self.remote_image_urls.is_empty()
        {
            return None;
        }

        // Submitting is allowed even while a turn is in flight. The event loop
        // queues the new user message and only renders it as transcript history
        // when that queued turn actually starts.
        if self.spinner.is_running() {
            const MIN_SUBMIT_GAP_MS: u128 = 200;
            if let Some(last) = self.last_submit_at
                && last.elapsed().as_millis() < MIN_SUBMIT_GAP_MS
            {
                return None;
            }
        }

        let submitted = self.take_submitted_message();
        let text = submitted.text.clone();
        self.input.clear();
        self.cursor_grapheme_index = 0;
        self.input_scroll_row = 0;
        self.last_input_width = 0;
        self.startup_live_viewport_top_limit = None;
        self.close_slash_menu();
        self.force_next_viewport_redraw();
        self.input_history_index = None;
        self.input_history_draft = None;
        self.last_submit_at = Some(std::time::Instant::now());
        self.push_input_history(text.clone());
        if submitted.images.is_empty()
            && let Some(command) = shell_command_from_prompt(&text)
        {
            return Some(UserAction::RunShellCommand {
                command,
                history_text: text,
            });
        }
        if submitted.images.is_empty() && text.starts_with('/') {
            return Some(UserAction::SlashCommand(text));
        }
        Some(UserAction::Submit(submitted))
    }

    fn refresh_engine_metadata(&mut self, engine: &QueryEngine) {
        let cwd = engine.state.cwd().display().to_string();
        if self.display_cwd != cwd {
            self.mention_file_index.clear();
            self.mention_menu = None;
        }
        self.display_cwd = cwd;
        let settings = engine.settings.read().unwrap();
        self.model_name = settings.model.clone();
        self.reasoning_effort = settings.model_reasoning_effort.clone();
        drop(settings);
        self.provider_name = engine.provider_name();
        self.session_id = engine.session_id();
        self.plan_mode = engine.state.plan_mode();
        self.session_mode = engine.state.session_mode();
        self.orchestrate_progress_label = if self.session_mode.is_orchestrate() {
            let store =
                kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd());
            store.read_active_work().ok().and_then(|snapshot| {
                let parsed = kcoder_state::orchestrate_store::parse_plan(&snapshot.plan).ok()?;
                let todo_total = parsed
                    .tasks
                    .iter()
                    .filter(|task| !task.is_final_verification)
                    .count();
                let todo_done = parsed
                    .tasks
                    .iter()
                    .filter(|task| !task.is_final_verification && task.completed)
                    .count();
                let wave_total = parsed
                    .tasks
                    .iter()
                    .filter(|task| task.is_final_verification)
                    .count();
                let wave_done = parsed
                    .tasks
                    .iter()
                    .filter(|task| task.is_final_verification && task.completed)
                    .count();
                Some(format!(
                    "{} r{} · TODOs {}/{} · Wave {}/{} · {}",
                    snapshot.work.display_slug,
                    snapshot.work.revision,
                    todo_done,
                    todo_total,
                    wave_done,
                    wave_total,
                    format!("{:?}", snapshot.work.status).to_ascii_lowercase(),
                ))
            })
        } else {
            None
        };
        self.goal = engine.state.goal();
        self.todos = engine.state.todos();
        self.token_count = engine.estimated_token_count();
        let budget = engine.context_budget();
        self.token_total = budget.hard_input_limit();
        self.token_threshold = budget.auto_compact_threshold();
        // Prune background job hints that the engine no longer tracks. This
        // keeps status surfaces in sync if the user closed a hint via
        // `close_agent` or the engine dropped the record.
        let live: std::collections::HashSet<String> =
            engine.state.tasks().keys().cloned().collect();
        self.prune_background_job_hints(&live);
    }

    fn adjust_reasoning_effort(
        &mut self,
        engine: &QueryEngine,
        direction: ReasoningShortcutDirection,
    ) {
        let current_setting = engine
            .settings
            .read()
            .unwrap()
            .model_reasoning_effort
            .clone();
        let current_effort = reasoning_shortcut_anchor(current_setting.as_ref());
        let Some(next_effort) = next_reasoning_effort(&current_effort, direction) else {
            self.push_message(
                MessageRole::System,
                direction.bound_message(&current_effort),
            );
            return;
        };

        if let Err(error) = engine.set_client_reasoning_effort(&next_effort.to_string()) {
            self.push_message(MessageRole::System, format!("Cannot change reasoning: {error}"));
            return;
        }
        self.reasoning_effort = Some(next_effort.clone());
        self.push_message(
            MessageRole::System,
            format!(
                "Reasoning set to {}.",
                reasoning_effort_sentence_label(&next_effort)
            ),
        );
    }

    fn prune_background_job_hints(&mut self, live_ids: &std::collections::HashSet<String>) {
        self.background_job_hints
            .retain(|hint| live_ids.contains(&hint.id));
        self.background_job_progress
            .retain(|id, _| live_ids.contains(id));
        self.background_job_lifetimes
            .retain(|id, _| live_ids.contains(id));
    }

    /// Record a new background status hint. The hint list is capped at 16
    /// entries — older hints fall off the end so a long session does not leak
    /// memory.
    fn record_background_job_hint(&mut self, hint: BackgroundJobHint) {
        const MAX_HINTS: usize = 16;
        // Stable workflow IDs are intentionally reused by /workflow resume.
        // Replace an earlier lifecycle hint instead of stacking duplicate
        // Running entries that one terminal event can never all complete.
        let replacing_existing = self
            .background_job_hints
            .iter()
            .any(|existing| existing.id == hint.id);
        self.background_job_hints
            .retain(|existing| existing.id != hint.id);
        self.background_job_progress.remove(&hint.id);
        if replacing_existing {
            self.background_job_lifetimes.remove(&hint.id);
        }
        self.background_job_hints.push(hint);
        if self.background_job_hints.len() > MAX_HINTS {
            let drop = self.background_job_hints.len() - MAX_HINTS;
            self.background_job_hints.drain(0..drop);
        }
    }

    /// Mark a previously-registered hint as completed or failed. Returns
    /// `true` if a hint with the given id was found and updated. The
    /// `error` argument is stored on the hint so status surfaces can show
    /// the failure reason without re-fetching the task record.
    fn complete_background_job_hint(
        &mut self,
        id: &str,
        state: BackgroundJobHintState,
        error: Option<String>,
    ) -> bool {
        if let Some(hint) = self.background_job_hints.iter_mut().find(|h| h.id == id) {
            hint.state = state;
            hint.error = error;
            self.background_job_progress.remove(id);
            self.background_job_lifetimes.remove(id);
            return true;
        }
        false
    }

    fn update_background_job_progress(
        &mut self,
        id: &str,
        message: String,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        if !self
            .background_job_hints
            .iter()
            .any(|hint| hint.id == id && hint.state == BackgroundJobHintState::Running)
        {
            return false;
        }
        let now = Instant::now();
        if let Some(progress) = self.background_job_progress.get_mut(id) {
            let changed = progress.message != message
                || progress.current != current
                || progress.total != total;
            progress.message = message;
            progress.current = current;
            progress.total = total;
            progress.updated_at = now;
            return changed;
        }
        self.background_job_progress.insert(
            id.to_string(),
            BackgroundJobProgressHint {
                message,
                current,
                total,
                updated_at: now,
            },
        );
        true
    }

    fn update_background_job_lifetime_from_tool_result(&mut self, text: &str) -> bool {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return false;
        };
        let Some(task_id) = value.get("task_id").and_then(serde_json::Value::as_str) else {
            return false;
        };
        let Some(total_ms) = value
            .get("total_lifetime_ms")
            .and_then(serde_json::Value::as_u64)
        else {
            return false;
        };
        let Some(expires_at_ms) = value
            .get("expires_at_ms")
            .and_then(serde_json::Value::as_u64)
        else {
            return false;
        };
        if value.get("status").and_then(serde_json::Value::as_str) != Some("running")
            || value
                .get("lifecycle_scope")
                .and_then(serde_json::Value::as_str)
                != Some("kcoder_session")
        {
            return false;
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX);
        self.background_job_lifetimes.insert(
            task_id.to_string(),
            BackgroundJobLifetimeHint {
                total_timeout: Duration::from_millis(total_ms),
                deadline: Instant::now()
                    + Duration::from_millis(expires_at_ms.saturating_sub(now_ms)),
            },
        );
        true
    }

    fn push_subagent_pending(&mut self, tool_call_id: String, name: String, input: String) {
        self.spinner.mark_tool();
        self.drain_pending_streaming_text_all();
        self.streaming_message_done_pending = false;
        self.commit_streaming_thinking_summary();
        self.commit_streaming_text();
        self.consolidate_finished_assistant_stream();
        self.start_streaming_message();
        self.streaming_output_active = false;
        self.streaming_status_suppressed_after_output = false;
        self.turn_had_work_activity = true;

        let delivery = subagent_requested_delivery(&input);
        let item_text = subagent_item_text(&name, &input);
        let reusable_panel_id = self.open_subagent_panel.filter(|panel_id| {
            self.subagent_panels
                .get(panel_id)
                .is_some_and(|panel| !panel.all_terminal())
        });
        let panel_id = reusable_panel_id.unwrap_or_else(|| {
            let id = self.next_subagent_panel_id;
            self.next_subagent_panel_id = self.next_subagent_panel_id.wrapping_add(1).max(1);
            self.subagent_panels.insert(id, SubagentPanel::new(id));
            self.subagent_animation_started_at = Instant::now();
            self.open_subagent_panel = Some(id);
            id
        });
        let panel = self
            .subagent_panels
            .entry(panel_id)
            .or_insert_with(|| SubagentPanel::new(panel_id));
        panel.add_pending(tool_call_id.clone(), item_text, delivery);
        self.sync_subagent_panel(panel_id);
        let pending_agent = self.pending_subagent_associations.iter().find_map(
            |(agent_id, (pending_tool_call_id, run_in_background))| {
                (pending_tool_call_id == &tool_call_id)
                    .then_some((agent_id.clone(), *run_in_background))
            },
        );
        if let Some((agent_id, run_in_background)) = pending_agent {
            self.pending_subagent_associations.remove(&agent_id);
            self.associate_subagent_panel(&agent_id, &tool_call_id, run_in_background);
        }
    }

    fn convert_running_tool_to_subagent_panel(
        &mut self,
        tool_call_id: String,
        name: String,
        input: String,
    ) -> bool {
        let Some(entry_index) = self.active_turn.as_ref().and_then(|active| {
            active.entries.iter().rposition(|entry| {
                matches!(
                    entry,
                    ActiveEntry::Tool(ToolStatus::Running { id, .. }) if id == &tool_call_id
                )
            })
        }) else {
            return false;
        };

        let panel_id = self.next_subagent_panel_id;
        self.next_subagent_panel_id = self.next_subagent_panel_id.wrapping_add(1).max(1);
        let mut panel = SubagentPanel::new(panel_id);
        panel.add_pending(
            tool_call_id.clone(),
            subagent_item_text(&name, &input),
            SubagentDelivery::Background,
        );
        if let Some(active) = self.active_turn.as_mut() {
            active.entries[entry_index] = ActiveEntry::SubagentPanel(panel.clone());
        }
        self.subagent_panels.insert(panel_id, panel);
        self.open_subagent_panel = Some(panel_id);
        self.subagent_animation_started_at = Instant::now();

        let pending_agent = self.pending_subagent_associations.iter().find_map(
            |(agent_id, (pending_tool_call_id, run_in_background))| {
                (pending_tool_call_id == &tool_call_id)
                    .then_some((agent_id.clone(), *run_in_background))
            },
        );
        if let Some((agent_id, run_in_background)) = pending_agent {
            self.pending_subagent_associations.remove(&agent_id);
            self.associate_subagent_panel(&agent_id, &tool_call_id, run_in_background);
        } else {
            self.bump_active_turn_render_revision();
            self.fullscreen_transcript_render_cache = None;
            if self.transcript_viewport.is_at_tail() {
                self.snap_to_bottom();
            }
        }
        true
    }

    fn associate_subagent_panel(
        &mut self,
        agent_id: &str,
        tool_call_id: &str,
        run_in_background: bool,
    ) -> bool {
        let delivery = if run_in_background {
            SubagentDelivery::Background
        } else {
            SubagentDelivery::Foreground
        };
        let Some(panel_id) = self
            .subagent_panels
            .iter()
            .find_map(|(id, panel)| panel.has_tool_call(tool_call_id).then_some(*id))
        else {
            self.detach_subagent_routing_for_continuation(agent_id);
            const MAX_PENDING_ASSOCIATIONS: usize = 32;
            if self.pending_subagent_associations.len() >= MAX_PENDING_ASSOCIATIONS
                && let Some(oldest) = self.pending_subagent_associations.keys().next().cloned()
            {
                self.pending_subagent_associations.remove(&oldest);
            }
            self.pending_subagent_associations.insert(
                agent_id.to_string(),
                (tool_call_id.to_string(), run_in_background),
            );
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.associate(tool_call_id, agent_id, delivery));
        if changed {
            self.subagent_panel_by_agent
                .insert(agent_id.to_string(), panel_id);
            if let Some(pending) = self.pending_subagent_progress.remove(agent_id)
                && let Some(panel) = self.subagent_panels.get_mut(&panel_id)
            {
                panel.update_progress(
                    agent_id,
                    &pending.message,
                    pending.detail.as_deref(),
                    pending.current,
                    pending.total,
                );
                if pending.promoted {
                    panel.promote(agent_id);
                }
            }
            if let Some((phase, status)) = self.pending_subagent_terminal.remove(agent_id)
                && let Some(panel) = self.subagent_panels.get_mut(&panel_id)
            {
                panel.finish(agent_id, phase, status);
            }
            if let Some(applied) = self.pending_subagent_steer_applied.remove(agent_id)
                && let Some(panel) = self.subagent_panels.get_mut(&panel_id)
            {
                panel.apply_steer(agent_id, &applied.message_id, applied.queue_depth);
            }
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn detach_subagent_routing_for_continuation(&mut self, agent_id: &str) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.remove(agent_id) else {
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| {
                panel.finish(agent_id, SubagentPhase::Completed, "Previous run finished")
            });
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        true
    }

    fn update_subagent_panel_progress(
        &mut self,
        agent_id: &str,
        message: &str,
        detail: Option<&str>,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            const MAX_PENDING_PROGRESS: usize = 32;
            if self.pending_subagent_progress.len() >= MAX_PENDING_PROGRESS
                && let Some(oldest) = self.pending_subagent_progress.keys().next().cloned()
            {
                self.pending_subagent_progress.remove(&oldest);
            }
            self.pending_subagent_progress.insert(
                agent_id.to_string(),
                PendingSubagentProgress {
                    message: message.to_string(),
                    detail: detail.map(str::to_string),
                    current,
                    total,
                    promoted: false,
                },
            );
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.update_progress(agent_id, message, detail, current, total));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn promote_subagent_panel(&mut self, agent_id: &str) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            self.pending_subagent_progress
                .entry(agent_id.to_string())
                .or_insert_with(|| PendingSubagentProgress {
                    message: "Running in background".to_string(),
                    detail: None,
                    current: None,
                    total: None,
                    promoted: true,
                })
                .promoted = true;
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.promote(agent_id));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn apply_subagent_steer_to_panel(
        &mut self,
        agent_id: &str,
        message_id: &str,
        queue_depth: usize,
    ) -> bool {
        if let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        {
            view.steer_status = Some("Steering applied".to_string());
        }
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            const MAX_PENDING_STEER_EVENTS: usize = 32;
            if self.pending_subagent_steer_applied.len() >= MAX_PENDING_STEER_EVENTS
                && let Some(oldest) = self.pending_subagent_steer_applied.keys().next().cloned()
            {
                self.pending_subagent_steer_applied.remove(&oldest);
            }
            self.pending_subagent_steer_applied.insert(
                agent_id.to_string(),
                PendingSubagentSteerApplied {
                    message_id: message_id.to_string(),
                    queue_depth,
                },
            );
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.apply_steer(agent_id, message_id, queue_depth));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn queue_subagent_steer_in_panel(
        &mut self,
        agent_id: &str,
        message_id: &str,
        queue_depth: usize,
    ) -> bool {
        if let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        {
            view.steer_status = Some("Steering queued".to_string());
        }
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.queue_steer(agent_id, message_id, queue_depth));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn set_agent_view_steer_status(&mut self, agent_id: &str, status: impl Into<String>) -> bool {
        let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        else {
            return false;
        };
        view.steer_status = Some(status.into());
        self.force_next_viewport_redraw();
        true
    }

    #[cfg(test)]
    fn enter_agent_view(&mut self, agent_id: String, display_name: String) {
        self.enter_agent_view_with_transcript(
            agent_id,
            display_name,
            PathBuf::new(),
            Vec::new(),
            None,
        );
    }

    fn enter_agent_view_with_transcript(
        &mut self,
        agent_id: String,
        display_name: String,
        transcript_path: PathBuf,
        messages: Vec<Message>,
        fingerprint: Option<AgentTranscriptFingerprint>,
    ) {
        if self.agent_view.is_some() {
            self.leave_agent_view();
        }
        let parent_viewport = std::mem::take(&mut self.transcript_viewport);
        self.close_outline();
        let parent_navigation = std::mem::take(&mut self.navigation);
        let parent_outline = std::mem::take(&mut self.outline);
        self.transcript_viewport.snap_to_bottom();
        self.agent_view = Some(AgentViewState {
            live_revision: None,
            agent_id,
            display_name,
            steer_status: None,
            transcript_path,
            transcript: Self::project_agent_transcript(&messages),
            fingerprint,
            pending_steers: Vec::new(),
            parent_viewport,
            parent_navigation,
            parent_outline,
            refresh_after: Instant::now(),
            load_error: None,
        });
        self.invalidate_transcript_rendering();
    }

    async fn enter_agent_view_from_task(
        &mut self,
        engine: &QueryEngine,
        agent_id: String,
        display_name: String,
    ) -> Result<(), String> {
        let transcript_path = engine
            .state
            .task(&agent_id)
            .and_then(|task| task.transcript_path)
            .unwrap_or_else(|| engine.state.subagent_transcript_path(&agent_id));
        let (messages, fingerprint) = match tokio::fs::read(&transcript_path).await {
            Ok(bytes) => {
                let messages = serde_json::from_slice::<Vec<Message>>(&bytes)
                    .map_err(|error| format!("failed to parse child transcript: {error}"))?;
                let fingerprint =
                    tokio::fs::metadata(&transcript_path)
                        .await
                        .ok()
                        .map(|metadata| AgentTranscriptFingerprint {
                            len: metadata.len(),
                            modified: metadata.modified().ok(),
                        });
                (messages, fingerprint)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
            Err(error) => {
                return Err(format!(
                    "failed to read child transcript {}: {error}",
                    transcript_path.display()
                ));
            }
        };
        self.enter_agent_view_with_transcript(
            agent_id,
            display_name,
            transcript_path,
            messages,
            fingerprint,
        );
        self.refresh_agent_view_transcript(engine, true).await;
        Ok(())
    }

    fn project_agent_transcript(messages: &[Message]) -> TranscriptStore {
        let mut projection = ReplApp::default();
        projection.replace_transcript_from_history(messages);
        projection.messages
    }

    fn apply_agent_live_snapshot(
        &mut self,
        snapshot: kcoder_engine::agent_live_view::AgentLiveSnapshot,
    ) -> bool {
        self.preserve_review_before_content_change();
        let Some(view) = self.agent_view.as_mut() else {
            return false;
        };
        let mut transcript = Self::project_agent_transcript(&snapshot.messages);
        if snapshot.text_truncated {
            transcript.push(DisplayMessage { role: MessageRole::System, text: "Live preview shows the latest 256 KiB; the complete response will appear when committed.".into() });
        }
        if !snapshot.pending_text.is_empty() {
            transcript.push(DisplayMessage {
                role: MessageRole::Assistant,
                text: snapshot.pending_text,
            });
        }
        for pending in &view.pending_steers {
            if !transcript
                .iter()
                .any(|message| message.role == MessageRole::User && message.text == pending.body)
            {
                transcript.push(DisplayMessage {
                    role: MessageRole::User,
                    text: pending.body.clone(),
                });
                transcript.push(DisplayMessage {
                    role: MessageRole::System,
                    text: format!("Steering queued · {}", pending.message_id),
                });
            }
        }
        transcript.push(DisplayMessage {
            role: MessageRole::System,
            text: format!("Agent status: {}", snapshot.phase),
        });
        view.transcript.reconcile_projection(&transcript);
        view.live_revision = Some(snapshot.revision);
        view.load_error = None;
        self.invalidate_agent_transcript_rendering();
        true
    }

    fn invalidate_agent_transcript_rendering(&mut self) {
        // Snapshots only change content. Preserve the last painted wheel geometry without forcing a full-screen repaint.
        self.render_cache.clear();
        self.fullscreen_transcript_render_cache = None;
        self.transcript_row_index = TranscriptRowIndex::default();
        self.clear_transcript_selection();
    }

    async fn refresh_agent_view_transcript(&mut self, engine: &QueryEngine, force: bool) -> bool {
        let Some(view) = self.agent_view.as_mut() else {
            return false;
        };
        let now = Instant::now();
        if !force && now < view.refresh_after {
            return false;
        }
        view.refresh_after = now + Duration::from_millis(250);
        let id = view.agent_id.clone();
        let previous = if force { None } else { view.live_revision };
        if let Some(snapshot) = engine.subagent_live_snapshot(&id, previous) {
            return self.apply_agent_live_snapshot(snapshot);
        }
        if engine.has_subagent_live_view(&id) {
            return false;
        }
        // Once the writer exits, reload the final durable checkpoint even if
        // its metadata matches the file observed before entering the live view.
        let force = force || view.live_revision.take().is_some();
        if view.transcript_path.as_os_str().is_empty() {
            return false;
        }
        let transcript_path = view.transcript_path.clone();
        let previous_fingerprint = view.fingerprint;
        let metadata = match tokio::fs::metadata(&transcript_path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(error) => {
                view.load_error = Some(error.to_string());
                return true;
            }
        };
        let fingerprint = AgentTranscriptFingerprint {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        };
        if !force && previous_fingerprint == Some(fingerprint) {
            return false;
        }
        let bytes = match tokio::fs::read(&transcript_path).await {
            Ok(bytes) => bytes,
            Err(error) => {
                if let Some(view) = self.agent_view.as_mut() {
                    view.load_error = Some(error.to_string());
                }
                return true;
            }
        };
        let messages = match serde_json::from_slice::<Vec<Message>>(&bytes) {
            Ok(messages) => messages,
            Err(error) => {
                if let Some(view) = self.agent_view.as_mut() {
                    view.load_error = Some(error.to_string());
                }
                return true;
            }
        };
        let pending_steers = self
            .agent_view
            .as_ref()
            .map(|view| view.pending_steers.clone())
            .unwrap_or_default();
        let mut transcript = Self::project_agent_transcript(&messages);
        for pending in &pending_steers {
            if !transcript
                .iter()
                .any(|message| message.role == MessageRole::User && message.text == pending.body)
            {
                transcript.push(DisplayMessage {
                    role: MessageRole::User,
                    text: pending.body.clone(),
                });
            }
            transcript.push(DisplayMessage {
                role: MessageRole::System,
                text: format!("Steering queued · {}", pending.message_id),
            });
        }
        self.preserve_review_before_content_change();
        let Some(view) = self.agent_view.as_mut() else {
            return false;
        };
        view.transcript.reconcile_projection(&transcript);
        view.fingerprint = Some(fingerprint);
        view.load_error = None;
        self.invalidate_agent_transcript_rendering();
        true
    }

    fn queue_agent_view_steer(&mut self, agent_id: &str, message_id: &str, body: &str) -> bool {
        let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        else {
            return false;
        };
        if view
            .pending_steers
            .iter()
            .any(|pending| pending.message_id == message_id)
        {
            return false;
        }
        let body = sanitize_tui_text(body);
        view.pending_steers.push(PendingAgentViewSteer {
            message_id: message_id.to_string(),
            body: body.clone(),
        });
        view.transcript.push(DisplayMessage {
            role: MessageRole::User,
            text: body,
        });
        view.transcript.push(DisplayMessage {
            role: MessageRole::System,
            text: format!("Steering queued · {message_id}"),
        });
        self.invalidate_transcript_rendering();
        true
    }

    fn finish_agent_view_steer(&mut self, agent_id: &str, message_id: &str) -> bool {
        let Some(view) = self
            .agent_view
            .as_mut()
            .filter(|view| view.agent_id == agent_id)
        else {
            return false;
        };
        let before = view.pending_steers.len();
        view.pending_steers
            .retain(|pending| pending.message_id != message_id);
        before != view.pending_steers.len()
    }

    fn leave_agent_view(&mut self) -> bool {
        let Some(view) = self.agent_view.take() else {
            return false;
        };
        self.transcript_viewport = view.parent_viewport;
        self.close_outline();
        self.navigation = view.parent_navigation;
        self.outline = view.parent_outline;
        self.invalidate_transcript_rendering();
        true
    }

    fn viewed_agent_id(&self) -> Option<&str> {
        self.agent_view.as_ref().map(|view| view.agent_id.as_str())
    }

    fn pause_subagent_panel(&mut self, agent_id: &str, status: &str, detail: Option<&str>) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.pause(agent_id, status, detail));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn restart_subagent_panel(&mut self, agent_id: &str, delivery: SubagentDelivery) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            return false;
        };
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.restart(agent_id, delivery));
        if changed {
            self.subagent_animation_started_at = Instant::now();
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn finish_subagent_panel(
        &mut self,
        agent_id: &str,
        phase: SubagentPhase,
        status: impl Into<String>,
    ) -> bool {
        let Some(panel_id) = self.subagent_panel_by_agent.get(agent_id).copied() else {
            const MAX_PENDING_TERMINALS: usize = 32;
            if self.pending_subagent_terminal.len() >= MAX_PENDING_TERMINALS
                && let Some(oldest) = self.pending_subagent_terminal.keys().next().cloned()
            {
                self.pending_subagent_terminal.remove(&oldest);
            }
            self.pending_subagent_terminal
                .entry(agent_id.to_string())
                .or_insert_with(|| (phase, status.into()));
            return false;
        };
        let status = status.into();
        let changed = self
            .subagent_panels
            .get_mut(&panel_id)
            .is_some_and(|panel| panel.finish(agent_id, phase, status));
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn finish_subagent_tool_call(
        &mut self,
        tool_call_id: &str,
        text: &str,
        is_error: bool,
    ) -> bool {
        let Some(panel_id) = self
            .subagent_panels
            .iter()
            .find_map(|(id, panel)| panel.has_tool_call(tool_call_id).then_some(*id))
        else {
            return false;
        };
        let result = parse_subagent_result(text, is_error);
        let agent_id = result.agent_id.clone();
        if let Some(agent_id) = agent_id.as_deref() {
            self.associate_subagent_panel(agent_id, tool_call_id, result.background);
        }
        if let (Some(agent_id), Some(detail)) = (agent_id.as_deref(), result.detail.as_deref()) {
            self.update_subagent_panel_progress(
                agent_id,
                "Writing response",
                Some(detail),
                None,
                None,
            );
        }
        let changed = match (agent_id.as_deref(), result.status.as_str()) {
            (Some(agent_id), "running" | "resuming") => self.promote_subagent_panel(agent_id),
            (_, "queued" | "finishing") => {
                self.subagent_panels
                    .get_mut(&panel_id)
                    .is_some_and(|panel| {
                        panel.finish_tool_call(
                            tool_call_id,
                            if is_error {
                                SubagentPhase::Failed
                            } else {
                                SubagentPhase::Completed
                            },
                            if is_error { "Failed" } else { "Completed" },
                        )
                    })
            }
            (Some(agent_id), "failed") => {
                self.finish_subagent_panel(agent_id, SubagentPhase::Failed, "Failed")
            }
            (Some(agent_id), "cancelled") => {
                self.finish_subagent_panel(agent_id, SubagentPhase::Cancelled, "Cancelled")
            }
            (Some(agent_id), _) => {
                self.finish_subagent_panel(agent_id, SubagentPhase::Completed, "Completed")
            }
            (None, "running" | "resuming") => false,
            (None, _) => self
                .subagent_panels
                .get_mut(&panel_id)
                .is_some_and(|panel| {
                    panel.finish_tool_call(
                        tool_call_id,
                        if is_error {
                            SubagentPhase::Failed
                        } else {
                            SubagentPhase::Completed
                        },
                        if is_error { "Failed" } else { "Completed" },
                    )
                }),
        };
        if changed {
            self.sync_subagent_panel(panel_id);
        }
        changed
    }

    fn sync_subagent_panel(&mut self, panel_id: u64) {
        let Some(panel) = self.subagent_panels.get(&panel_id).cloned() else {
            return;
        };
        let mut found = false;
        if let Some(active) = self.active_turn.as_mut()
            && let Some(entry) = active.entries.iter_mut().find(|entry| {
                matches!(entry, ActiveEntry::SubagentPanel(candidate) if candidate.id == panel_id)
            })
        {
            *entry = ActiveEntry::SubagentPanel(panel.clone());
            found = true;
        }
        let encoded = panel.encode_message();
        if self.messages.replace_first(
            |message| panel_message_id(&message.text) == Some(panel_id),
            DisplayMessage {
                role: MessageRole::System,
                text: encoded.clone(),
            },
        ) {
            found = true;
        }
        if !found {
            self.start_streaming_message();
            if let Some(active) = self.active_turn.as_mut() {
                active.entries.push(ActiveEntry::SubagentPanel(panel));
            }
        }
        self.bump_active_turn_render_revision();
        self.fullscreen_transcript_render_cache = None;
        if self.transcript_viewport.is_at_tail() {
            self.snap_to_bottom();
        }
    }

    fn reconcile_subagent_panels_from_engine(&mut self, engine: &QueryEngine) {
        let mut tasks = engine
            .state
            .tasks()
            .into_values()
            .filter(|task| task.managed && task.kind == TaskKind::Subagent)
            .collect::<Vec<_>>();
        tasks.sort_by_key(|task| task.created_at_ms);
        for task in tasks {
            let Some(tool_call_id) = task.parent_tool_call_id.as_deref() else {
                continue;
            };
            self.associate_subagent_panel(
                &task.id,
                tool_call_id,
                task.delivery == TaskDelivery::Background,
            );
            if matches!(
                task.status,
                TaskStatus::Pending | TaskStatus::Running | TaskStatus::Paused
            ) {
                self.restart_subagent_panel(
                    &task.id,
                    if task.delivery == TaskDelivery::Background {
                        SubagentDelivery::Background
                    } else {
                        SubagentDelivery::Foreground
                    },
                );
            }
            match task.status {
                TaskStatus::Pending | TaskStatus::Running
                    if task.delivery == TaskDelivery::Background =>
                {
                    self.promote_subagent_panel(&task.id);
                    let detail = orchestrate_agent_status_detail(&task);
                    self.update_subagent_panel_progress(
                        &task.id,
                        "Running in background",
                        Some(&detail),
                        Some(1),
                        task.max_turns,
                    );
                }
                TaskStatus::Pending | TaskStatus::Running => {
                    let detail = orchestrate_agent_status_detail(&task);
                    self.update_subagent_panel_progress(
                        &task.id,
                        "Running",
                        Some(&detail),
                        Some(1),
                        task.max_turns,
                    );
                }
                TaskStatus::Paused => {
                    let detail = orchestrate_agent_status_detail(&task);
                    self.pause_subagent_panel(&task.id, "Paused at a safe boundary", Some(&detail));
                }
                TaskStatus::Halted => {
                    self.finish_subagent_panel(&task.id, SubagentPhase::Halted, "Halted");
                }
                TaskStatus::Completed => {
                    self.finish_subagent_panel(&task.id, SubagentPhase::Completed, "Completed");
                }
                TaskStatus::Failed => {
                    self.finish_subagent_panel(
                        &task.id,
                        SubagentPhase::Failed,
                        task.output.as_deref().unwrap_or("Failed"),
                    );
                }
                TaskStatus::Cancelled => {
                    self.finish_subagent_panel(&task.id, SubagentPhase::Cancelled, "Cancelled");
                }
            }
        }
    }

    fn latest_background_job_progress(&self) -> Option<&BackgroundJobProgressHint> {
        self.background_job_hints
            .iter()
            .filter(|hint| hint.state == BackgroundJobHintState::Running)
            .filter_map(|hint| self.background_job_progress.get(&hint.id))
            .max_by_key(|progress| progress.updated_at)
    }

    fn tiny_terminal_subagent_status(&self, width: u16, height: u16) -> Option<String> {
        const FULL_PANEL_MIN_TERMINAL_HEIGHT: u16 = 18;
        (height < FULL_PANEL_MIN_TERMINAL_HEIGHT)
            .then(|| self.subagent_panels.values().max_by_key(|panel| panel.id))
            .flatten()
            .map(|panel| compact_panel_status(panel, width))
    }

    /// Public accessor used by status renderers.
    pub fn background_job_hints(&self) -> &[BackgroundJobHint] {
        &self.background_job_hints
    }

    fn background_status_label(&self) -> String {
        let mut agent_running = 0usize;
        let mut agent_failed = 0usize;
        let mut task_running = 0usize;
        let mut task_failed = 0usize;

        for hint in &self.background_job_hints {
            let is_tool_task =
                kcoder_tools::background::is_tool_background_task_description(&hint.description);
            match (is_tool_task, hint.state) {
                (true, BackgroundJobHintState::Running) => task_running += 1,
                (true, BackgroundJobHintState::Failed) => task_failed += 1,
                (false, BackgroundJobHintState::Running) => agent_running += 1,
                (false, BackgroundJobHintState::Failed) => agent_failed += 1,
                (
                    _,
                    BackgroundJobHintState::Paused
                    | BackgroundJobHintState::Halted
                    | BackgroundJobHintState::Completed
                    | BackgroundJobHintState::Cancelled,
                ) => {}
            }
        }

        let mut parts = Vec::new();
        if let Some(part) = background_status_group_label("agents", agent_running, agent_failed) {
            parts.push(part);
        }
        if let Some(part) = background_status_group_label("tasks", task_running, task_failed) {
            parts.push(part);
        }
        if let Some(progress) = self.latest_background_job_progress() {
            parts.push(progress.label());
        }
        let lifetime = self
            .background_job_hints
            .iter()
            .filter(|hint| {
                hint.state == BackgroundJobHintState::Running
                    && kcoder_tools::background::is_tool_background_task_description(
                        &hint.description,
                    )
            })
            .filter_map(|hint| self.background_job_lifetimes.get(&hint.id))
            .min_by_key(|lifetime| lifetime.deadline);
        if let Some(lifetime) = lifetime {
            parts.push(lifetime.label());
        }
        let quiet_for = self
            .background_job_hints
            .iter()
            .filter(|hint| hint.state == BackgroundJobHintState::Running)
            .filter_map(|hint| {
                self.background_job_progress
                    .get(&hint.id)
                    .map(|progress| progress.updated_at.elapsed())
                    .or_else(|| hint.started_at.map(|started| started.elapsed()))
            })
            .max()
            .filter(|elapsed| *elapsed >= Duration::from_secs(15));
        if let Some(quiet_for) = quiet_for {
            parts.push(format!(
                "no background update {}",
                format_worked_duration(quiet_for)
            ));
        }
        parts.join(" · ")
    }

    fn has_running_background_job(&self) -> bool {
        self.background_job_hints
            .iter()
            .any(|hint| hint.state == BackgroundJobHintState::Running)
    }

    fn status_indicator_visible(&self) -> bool {
        let stream_output_should_hide_status = self.streaming_output_active
            || (self.streaming_status_suppressed_after_output && self.pending_input_count() == 0);
        if stream_output_should_hide_status && self.active_status_detail().is_none() {
            return false;
        }
        self.has_interruptible_turn() || self.active_turn.is_some()
    }

    fn status_elapsed(&self) -> Duration {
        self.turn_started_at
            .map(|started| started.elapsed())
            .unwrap_or_default()
    }

    fn active_status_detail(&self) -> Option<String> {
        self.active_turn
            .as_ref()
            .and_then(|active| {
                active.entries.iter().rev().find_map(|entry| match entry {
                    ActiveEntry::Tool(ToolStatus::Running { name, input, .. })
                        if !(name.eq_ignore_ascii_case("write") && input.is_empty()) =>
                    {
                        Some(format_running_tool_detail(name, input))
                    }
                    ActiveEntry::Tool(ToolStatus::Running { .. }) => None,
                    ActiveEntry::Tool(ToolStatus::Done { status_text, .. }) => {
                        Some(status_text.trim().to_string()).filter(|text| !text.is_empty())
                    }
                    ActiveEntry::SubagentPanel(_) => None,
                    ActiveEntry::Text(_) => None,
                })
            })
            .or_else(|| reasoning_status_detail(&self.streaming_thinking_status))
    }

    fn running_tool_activity(&self) -> Option<(String, String, bool)> {
        self.active_turn.as_ref().and_then(|active| {
            active.entries.iter().rev().find_map(|entry| match entry {
                ActiveEntry::Tool(ToolStatus::Running { name, input, .. })
                    if !(name.eq_ignore_ascii_case("write") && input.is_empty()) =>
                {
                    Some((
                        format_running_tool_activity(name, input),
                        format_running_tool_detail(name, input),
                        is_agent_tool_name(name),
                    ))
                }
                _ => None,
            })
        })
    }

    fn running_tool_count(&self) -> usize {
        self.active_turn.as_ref().map_or(0, |active| {
            active
                .entries
                .iter()
                .filter(|entry| matches!(entry, ActiveEntry::Tool(ToolStatus::Running { .. })))
                .count()
        })
    }

    fn active_todo_label(&self) -> Option<String> {
        self.todos
            .iter()
            .find(|todo| todo.status == TodoStatus::InProgress)
            .and_then(|todo| {
                todo.active_form
                    .as_deref()
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                    .or_else(|| {
                        let content = todo.content.trim();
                        (!content.is_empty()).then_some(content)
                    })
            })
            .map(ToOwned::to_owned)
    }

    fn activity_presentation(&self) -> ActivityPresentation {
        let snapshot = self.spinner.snapshot();
        let running_tool = self.running_tool_activity();
        let mut base_label = if let Some((label, _, _)) = running_tool.as_ref() {
            label.clone()
        } else if let Some(label) = self.foreground_operation_label.as_ref() {
            label.clone()
        } else if let Some(label) = self.path_previews.label() {
            label
        } else if let Some((name, chars)) = self.spinner.preparing_tool_progress() {
            if chars == 0 {
                format!("Preparing {name} input")
            } else {
                format!(
                    "Preparing {name} input · {} chars",
                    format_progress_count(chars)
                )
            }
        } else if let Some(todo) = self.active_todo_label() {
            todo
        } else if snapshot.phase == ActivityPhase::Thinking {
            format!(
                "Thinking · {}",
                format_worked_duration(snapshot.phase_elapsed)
            )
        } else {
            snapshot.phase.default_label().to_string()
        };
        if running_tool
            .as_ref()
            .is_some_and(|(_, _, is_agent)| *is_agent)
            && let Some(progress) = self.latest_background_job_progress()
        {
            // The tool title already carries the delegated task. Keep the
            // footer heartbeat short enough to survive narrow terminals and
            // reserve the full task description for the detail/summary row.
            base_label = progress.label();
        }
        let running_tool_count = self.running_tool_count();
        if running_tool_count > 1 {
            base_label.push_str(&format!(" · {running_tool_count} tools running"));
        }
        let silence_text = snapshot.silence_text();
        let label = silence_text
            .as_ref()
            .map(|silence| format!("{silence} · {base_label}"))
            .unwrap_or(base_label);

        let mut details = Vec::new();
        if let Some((_, detail, _)) = running_tool {
            if detail != label {
                details.push(detail);
            }
        } else if let Some(detail) = reasoning_status_detail(&self.streaming_thinking_status) {
            if detail != label {
                details.push(detail);
            }
        } else if let Some(detail) = self.active_status_detail()
            && detail != label
        {
            details.push(detail);
        }
        if let Some(duration) = snapshot.thought_for {
            details.push(format!("Thought for {}", format_worked_duration(duration)));
        }
        if snapshot.is_long_task() {
            let mut summary = format!("Elapsed {}", format_worked_duration(snapshot.elapsed));
            if snapshot.estimated_output_tokens > 0 {
                summary.push_str(&format!(
                    " · ~{} output tokens",
                    snapshot.estimated_output_tokens
                ));
            }
            details.push(summary);
        }

        ActivityPresentation {
            snapshot,
            indicator: snapshot.indicator(),
            label,
            detail: (!details.is_empty()).then(|| details.join(" · ")),
        }
    }

    fn goal_status_label(&self) -> String {
        let Some(goal) = self.goal.as_ref() else {
            return String::new();
        };
        goal_status_label(goal)
    }

    pub(crate) fn open_goal_replacement_confirmation(
        &mut self,
        existing: Goal,
        objective: String,
        token_budget: Option<u64>,
        mode: GoalMode,
    ) {
        self.open_goal_replacement_confirmation_with_verification(
            existing,
            objective,
            token_budget,
            mode,
            GoalVerificationKind::Artifact,
        );
    }

    pub(crate) fn open_goal_replacement_confirmation_with_verification(
        &mut self,
        existing: Goal,
        objective: String,
        token_budget: Option<u64>,
        mode: GoalMode,
        verification_kind: GoalVerificationKind,
    ) {
        if self.has_active_modal() {
            return;
        }
        self.spinner.pause();
        self.prepare_blocking_modal();
        self.pending_goal_replacement = Some(GoalReplacementDialog {
            existing_summary: compact_goal_summary(&existing),
            objective,
            token_budget,
            mode,
            verification_kind,
            selected: 0,
        });
        self.open_overlay_state(OverlayKind::GoalReplacement);
    }

    fn focus_composer_at_mouse(&mut self, column: u16, row: u16) -> bool {
        let Some(content_area) = self.last_composer_content else {
            return false;
        };
        let Some(composer_area) = self.last_composer_area else {
            return false;
        };

        if !rect_contains(composer_area, column, row) {
            return false;
        }

        self.close_nonblocking_overlays();

        if rect_contains(content_area, column, row) {
            self.composer_preferred_col = None;
            let visual_row = row
                .saturating_sub(content_area.y)
                .saturating_add(self.input_scroll_row as u16) as usize;
            let visual_col = column.saturating_sub(content_area.x) as usize;
            self.cursor_grapheme_index = self.grapheme_index_for_visual_position(
                content_area.width.max(1),
                visual_row,
                visual_col,
            );
            self.clamp_input_scroll(content_area.width.max(1));
        }

        true
    }

    fn kill_input_range(&mut self, start: usize, end: usize) {
        self.remove_input_range(start, end, true);
    }

    fn remove_input_range(&mut self, start: usize, end: usize, store_kill: bool) {
        let len = self.input.graphemes(true).count();
        let start = start.min(len);
        let end = end.min(len);
        if start >= end {
            return;
        }

        self.reset_input_history_navigation();
        let start_byte = self.byte_index_for_grapheme(start);
        let end_byte = self.byte_index_for_grapheme(end);
        let removed = self.input[start_byte..end_byte].to_string();
        if store_kill && !removed.is_empty() {
            self.composer_kill_buffer = ComposerKillBuffer {
                text: removed.clone(),
                pending_pastes: self
                    .pending_pastes
                    .iter()
                    .filter(|(placeholder, _)| removed.contains(placeholder))
                    .cloned()
                    .collect(),
                local_image_attachments: self
                    .local_image_attachments
                    .iter()
                    .filter(|image| removed.contains(&image.placeholder))
                    .cloned()
                    .collect(),
            };
        }
        self.input.replace_range(start_byte..end_byte, "");
        self.cursor_grapheme_index = start;
        self.sync_composer_sidecars();
        self.clamp_input_scroll(self.last_input_width);
    }

    fn kill_to_beginning_of_current_line(&mut self) {
        let (line_start, _) = self.current_line_range();
        let cursor = self.cursor_grapheme_index;
        if cursor == line_start {
            if line_start > 0 {
                self.kill_input_range(line_start - 1, line_start);
            }
        } else {
            self.kill_input_range(line_start, cursor);
        }
    }

    fn kill_to_end_of_current_line(&mut self) {
        let (_, line_end) = self.current_line_range();
        let cursor = self.cursor_grapheme_index.min(line_end);
        let input_len = self.input.graphemes(true).count();
        if cursor == line_end {
            if line_end < input_len {
                self.kill_input_range(cursor, line_end + 1);
            }
        } else {
            self.kill_input_range(cursor, line_end);
        }
    }

    fn yank_composer_kill_buffer(&mut self) {
        if self.composer_kill_buffer.is_empty() {
            return;
        }

        let kill = self.composer_kill_buffer.clone();
        let mut text = kill.text;
        let mut staged_replacements = Vec::new();

        for (index, (old_placeholder, actual)) in kill.pending_pastes.into_iter().enumerate() {
            if !text.contains(&old_placeholder) {
                continue;
            }
            let token = format!("\x1fkcoder-paste-yank-{index}\x1f");
            text = text.replace(&old_placeholder, &token);
            let placeholder = self.next_large_paste_placeholder(actual.chars().count());
            self.pending_pastes.push((placeholder.clone(), actual));
            staged_replacements.push((token, placeholder));
        }

        for (index, mut image) in kill.local_image_attachments.into_iter().enumerate() {
            if self.local_image_attachments.len() >= MAX_IMAGE_ATTACHMENTS {
                continue;
            }
            if !text.contains(&image.placeholder) {
                continue;
            }
            let token = format!("\x1fkcoder-image-yank-{index}\x1f");
            text = text.replace(&image.placeholder, &token);
            image.placeholder = local_image_placeholder(self.local_image_attachments.len() + 1);
            staged_replacements.push((token, image.placeholder.clone()));
            self.local_image_attachments.push(image);
        }

        for (token, placeholder) in staged_replacements {
            text = text.replace(&token, &placeholder);
        }

        self.insert_text_at_cursor(&text);
        self.sync_composer_sidecars();
    }

    fn scroll_transcript_lines(&mut self, delta_lines: i32) {
        self.cancel_pending_navigation_for_input();
        if delta_lines < 0 && self.navigation.anchor.is_none() {
            self.expand_deferred_resumed_transcript();
        }
        self.transcript_viewport.scroll_lines(delta_lines);
        self.finish_manual_scroll_at_tail();
    }

    /// Read full history only on the first explicit review. Keep post-resume messages
    /// as an additional tail and retain the distance-from-tail anchor so inserting old
    /// records before it does not move the viewport.
    fn expand_deferred_resumed_transcript(&mut self) -> bool {
        if self.deferred_resumed_transcript.is_none() {
            return false;
        }
        let content_rows = self.transcript_viewport.content_rows();
        let viewport_rows = self.transcript_viewport.viewport_rows().max(1);
        let top = self
            .transcript_viewport
            .resolve_top(content_rows, viewport_rows);
        let distance_from_tail = content_rows
            .saturating_sub(viewport_rows)
            .saturating_sub(top);
        let deferred = self
            .deferred_resumed_transcript
            .take()
            .expect("deferred transcript was checked above");
        let extra_messages =
            self.messages[deferred.loaded_display_len.min(self.messages.len())..].to_vec();
        let full_history = match deferred.history.load_all() {
            Ok(messages) => messages,
            Err(error) => {
                self.push_message(
                    MessageRole::System,
                    format!("Failed to load earlier resumed transcript: {error}"),
                );
                return false;
            }
        };

        self.replace_transcript_from_history(&full_history);
        for message in extra_messages {
            self.messages.push(message);
        }
        self.transcript_viewport
            .set_position(TranscriptScroll::from_tail(distance_from_tail));
        self.prime_deferred_resume_content_rows();
        self.force_next_viewport_redraw();
        true
    }

    /// Complete a deferred transcript before a foreground turn begins, preventing the
    /// first review during an active turn from rebuilding everything and clearing streaming
    /// state. If the caller recorded a transcript start, remap it from tail-fragment plus
    /// new-message coordinates to full-history plus new-message coordinates.
    fn expand_deferred_resumed_transcript_before_turn(
        &mut self,
        transcript_start: Option<usize>,
    ) -> Option<usize> {
        let Some(loaded_display_len) = self
            .deferred_resumed_transcript
            .as_ref()
            .map(|deferred| deferred.loaded_display_len)
        else {
            return transcript_start;
        };
        let old_len = self.messages.len();
        if !self.expand_deferred_resumed_transcript() {
            return transcript_start;
        }
        let extra_len = old_len.saturating_sub(loaded_display_len);
        let expanded_display_len = self.messages.len().saturating_sub(extra_len);
        transcript_start.map(|index| {
            if index >= loaded_display_len {
                expanded_display_len.saturating_add(index - loaded_display_len)
            } else {
                index.min(expanded_display_len)
            }
        })
    }

    fn prime_deferred_resume_content_rows(&mut self) {
        if !self.fullscreen_surface {
            return;
        }
        let Some(area) = self.transcript_viewport.transcript_area() else {
            return;
        };
        let row_budget =
            usize::from(area.height.max(1)).saturating_add(TRANSCRIPT_RENDER_OVERSCAN_ROWS);
        let total_rows = self
            .render_fullscreen_transcript_window(area.width.max(1), row_budget)
            .total_rows;
        self.transcript_viewport.prime_content_rows(total_rows);
    }

    fn clear_transcript_selection(&mut self) {
        self.transcript_selection = None;
        self.transcript_selection_rows = None;
        self.transcript_selection_drag_active = false;
    }

    fn transcript_selection_mouse_blocked(&self) -> bool {
        self.centered_overlay_active()
            || self.history_search.is_some()
            || self.resume_session_picker.is_some()
            || self.slash_menu.is_some()
            || self.pending_permission.is_some()
            || self.permission_editor.is_some()
            || self.pending_question.is_some()
            || self.pending_goal_replacement.is_some()
            || self.context_inspector.is_some()
            || self.settings_inspector.is_some()
            || self.picker_overlay.is_some()
            || self.keys_overlay.is_some()
            || self.transcript_overlay.is_some()
    }

    fn transcript_selection_point_for_mouse(
        &self,
        column: u16,
        row: u16,
        require_inside: bool,
    ) -> Option<TranscriptSelectionPoint> {
        let area = self.transcript_viewport.transcript_area()?;
        if area.width == 0 || area.height == 0 {
            return None;
        }
        if require_inside && !rect_contains(area, column, row) {
            return None;
        }

        let row = if row < area.y {
            0
        } else if row >= area.bottom() {
            area.height.saturating_sub(1)
        } else {
            row.saturating_sub(area.y)
        };
        let column = if column < area.x {
            0
        } else if column >= area.right() {
            area.width
        } else {
            column.saturating_sub(area.x)
        };

        Some(TranscriptSelectionPoint {
            row: usize::from(row),
            column: usize::from(column),
        })
    }

    fn begin_transcript_selection(&mut self, column: u16, row: u16) -> bool {
        if self.transcript_selection_mouse_blocked() || self.last_transcript_visible_rows.is_empty()
        {
            return false;
        }
        let Some(point) = self.transcript_selection_point_for_mouse(column, row, true) else {
            return false;
        };
        self.transcript_selection = Some(TranscriptSelection::new(point));
        self.transcript_selection_rows = Some(self.last_transcript_visible_rows.clone());
        self.transcript_selection_drag_active = true;
        true
    }

    fn update_transcript_selection(&mut self, column: u16, row: u16) -> bool {
        if !self.transcript_selection_drag_active {
            return false;
        }
        if self
            .transcript_selection_rows
            .as_ref()
            .is_some_and(|rows| rows != &self.last_transcript_visible_rows)
        {
            self.transcript_selection_drag_active = false;
            self.set_transient_status("The view changed and the old selection was fixed; Ctrl+C copies, F9 selects across screens");
            return true;
        }
        let Some(point) = self.transcript_selection_point_for_mouse(column, row, false) else {
            self.clear_transcript_selection();
            return false;
        };
        if let Some(selection) = self.transcript_selection.as_mut() {
            selection.head = point;
        }
        true
    }

    fn finish_transcript_selection(&mut self, column: u16, row: u16) -> bool {
        if !self.transcript_selection_drag_active {
            return false;
        }
        let _ = self.update_transcript_selection(column, row);
        self.transcript_selection_drag_active = false;
        if let Some(selection) = self.transcript_selection
            && selected_text_from_visible_rows(&self.last_transcript_visible_rows, selection)
                .is_some()
        {
            self.set_transient_status("Text selected; press Ctrl+C to copy");
        }
        true
    }

    fn copy_transcript_selection(&mut self) -> bool {
        self.copy_transcript_selection_with(clipboard_copy::copy_to_clipboard)
    }

    fn copy_transcript_selection_with(
        &mut self,
        copy_fn: impl FnOnce(&str) -> std::result::Result<clipboard_copy::ClipboardCopyResult, String>,
    ) -> bool {
        let Some(selection) = self.transcript_selection else {
            return false;
        };
        let Some(text) = selected_text_from_visible_rows(
            self.transcript_selection_rows
                .as_deref()
                .unwrap_or(&self.last_transcript_visible_rows),
            selection,
        ) else {
            if self
                .transcript_selection_rows
                .as_ref()
                .is_some_and(|rows| rows != &self.last_transcript_visible_rows)
            {
                self.set_transient_status(
                    "The view changed during selection; press F9 to select again or Esc to clear",
                );
                return true;
            }
            return false;
        };

        match copy_fn(&text) {
            Ok(result) => {
                let (lease, copy_kind) = result.into_parts();
                self.clipboard_lease = lease;
                if copy_kind == clipboard_copy::ClipboardCopyKind::Osc52 {
                    self.set_transient_status(clipboard_copy::OSC52_COPY_NOTICE);
                } else {
                    self.set_transient_status("Copied selected text to clipboard");
                    self.clear_transcript_selection();
                }
            }
            Err(error) => self.set_transient_status(format!("Copy failed: {error}")),
        }
        true
    }

    fn scroll_transcript_to_scrollbar_row(&mut self, row: u16, immediate_redraw: bool) {
        self.transcript_viewport.drag_to_row(row);
        if immediate_redraw {
            self.frame_rate_limiter.reset();
        }
    }

    fn apply_transcript_scrollbar_command(
        &mut self,
        command: TranscriptScrollbarCommand,
        immediate_redraw: bool,
    ) {
        self.transcript_viewport.apply_command(command);
        if immediate_redraw {
            self.frame_rate_limiter.reset();
        }
    }

    pub(crate) fn open_resume_session_picker(&mut self, entries: Vec<ResumeSessionEntry>) {
        if entries.is_empty() {
            self.push_message(MessageRole::System, "No previous session to resume.");
            return;
        }
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.resume_session_picker = Some(ResumeSessionPicker {
            entries,
            selected: 0,
            filter: String::new(),
        });
        self.open_overlay_state(OverlayKind::ResumeSession);
        self.transcript_viewport.apply_pending_scroll();
        self.force_next_viewport_redraw();
    }

    fn close_resume_session_picker(&mut self) {
        self.resume_session_picker = None;
        self.close_overlay_state(OverlayKind::ResumeSession);
        self.force_next_viewport_redraw();
    }

    fn resume_session_picker_selected_path(&self) -> Option<PathBuf> {
        let picker = self.resume_session_picker.as_ref()?;
        let matches = resume_session_picker_matches(picker);
        let selected = picker.selected.min(matches.len().saturating_sub(1));
        let entry_index = *matches.get(selected)?;
        Some(picker.entries[entry_index].path.clone())
    }

    fn resume_session_picker_page_step(&self) -> usize {
        self.transcript_viewport
            .viewport_rows()
            .saturating_sub(RESUME_SESSION_PICKER_HEADER_LINES + RESUME_SESSION_PICKER_FOOTER_LINES)
            .max(1)
    }

    fn handle_resume_session_picker_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        if is_ctrl_c_key(&key) {
            self.close_resume_session_picker();
            return None;
        }

        let altgr = key_hint::is_altgr(key.modifiers);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL) && !altgr;
        let alt = key.modifiers.contains(KeyModifiers::ALT) && !altgr;

        match key.code {
            KeyCode::Esc => {
                self.close_resume_session_picker();
                None
            }
            KeyCode::Enter => {
                let path = self.resume_session_picker_selected_path();
                self.close_resume_session_picker();
                path.map(UserAction::ResumeSession)
            }
            KeyCode::Up | KeyCode::Char('p') if matches!(key.code, KeyCode::Up) || ctrl => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.selected = picker.selected.saturating_sub(1);
                }
                None
            }
            KeyCode::Down | KeyCode::Char('n') if matches!(key.code, KeyCode::Down) || ctrl => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    let matches_len = resume_session_picker_matches(picker).len();
                    picker.selected = picker
                        .selected
                        .saturating_add(1)
                        .min(matches_len.saturating_sub(1));
                }
                None
            }
            KeyCode::Home => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.selected = 0;
                }
                None
            }
            KeyCode::End => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.selected = resume_session_picker_matches(picker)
                        .len()
                        .saturating_sub(1);
                }
                None
            }
            KeyCode::PageUp => {
                let step = self.resume_session_picker_page_step();
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.selected = picker.selected.saturating_sub(step);
                }
                None
            }
            KeyCode::PageDown => {
                let step = self.resume_session_picker_page_step();
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    let matches_len = resume_session_picker_matches(picker).len();
                    picker.selected = picker
                        .selected
                        .saturating_add(step)
                        .min(matches_len.saturating_sub(1));
                }
                None
            }
            KeyCode::Backspace => {
                if let Some(picker) = self.resume_session_picker.as_mut()
                    && !picker.filter.is_empty()
                {
                    picker.filter.pop();
                    picker.selected = 0;
                }
                None
            }
            KeyCode::Char(c) if (!ctrl && !alt || altgr) && !c.is_ascii_control() => {
                if let Some(picker) = self.resume_session_picker.as_mut() {
                    picker.filter.push(c);
                    picker.selected = 0;
                }
                None
            }
            _ => None,
        }
    }

    fn finish_permission_dialog_with_response(&mut self, response: PermissionResponse) {
        let dialog = self.pending_permission.take().unwrap();
        self.close_overlay_state(OverlayKind::Permission);
        if response == PermissionResponse::Edit {
            self.open_permission_editor(dialog);
        } else {
            let _ = dialog.response_tx.send(PermissionDialogResult {
                response,
                modified_input: None,
            });
            self.activate_next_modal_or_resume_spinner();
        }
    }

    fn handle_permission_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        match key.code {
            KeyCode::Left | KeyCode::Up if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.as_mut().unwrap();
                dialog.selected = dialog.selected.saturating_sub(1);
            }
            KeyCode::Right | KeyCode::Down if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.as_mut().unwrap();
                if dialog.selected + 1 < PERMISSION_OPTION_RESPONSES.len() {
                    dialog.selected += 1;
                }
            }
            KeyCode::Home if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.as_mut().unwrap();
                dialog.selected = 0;
            }
            KeyCode::End if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.as_mut().unwrap();
                dialog.selected = PERMISSION_OPTION_RESPONSES.len().saturating_sub(1);
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                let selected = self
                    .pending_permission
                    .as_ref()
                    .map(|dialog| dialog.selected)
                    .unwrap_or(0);
                self.finish_permission_dialog_with_response(
                    PERMISSION_OPTION_RESPONSES
                        [selected.min(PERMISSION_OPTION_RESPONSES.len() - 1)],
                );
            }
            KeyCode::Char(c)
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                let c = c.to_ascii_lowercase();
                let response = match c {
                    'y' => Some(PermissionResponse::AllowOnce),
                    'a' => Some(PermissionResponse::AllowAlways),
                    's' => Some(PermissionResponse::AllowForSession),
                    'n' | 'd' => Some(PermissionResponse::DenyOnce),
                    'e' => Some(PermissionResponse::Edit),
                    '1'..='7' => c.to_digit(10).and_then(|digit| {
                        PERMISSION_OPTION_RESPONSES.get(digit as usize - 1).copied()
                    }),
                    _ => None,
                };
                if let Some(response) = response {
                    self.finish_permission_dialog_with_response(response);
                }
            }
            KeyCode::Esc if key.modifiers.is_empty() => {
                let dialog = self.pending_permission.take().unwrap();
                let _ = dialog.response_tx.send(PermissionDialogResult {
                    response: PermissionResponse::DenyOnce,
                    modified_input: None,
                });
                self.close_overlay_state(OverlayKind::Permission);
                self.activate_next_modal_or_resume_spinner();
            }
            _ => {}
        }
        None
    }

    fn has_active_modal(&self) -> bool {
        matches!(
            self.active_overlay,
            Some(
                OverlayKind::Permission
                    | OverlayKind::PermissionEditor
                    | OverlayKind::Question
                    | OverlayKind::GoalReplacement
            )
        )
    }

    fn overlay_payload_kinds(&self) -> Vec<OverlayKind> {
        let mut kinds = Vec::new();
        if self.pending_permission.is_some() {
            kinds.push(OverlayKind::Permission);
        }
        if self.permission_editor.is_some() {
            kinds.push(OverlayKind::PermissionEditor);
        }
        if self.pending_question.is_some() {
            kinds.push(OverlayKind::Question);
        }
        if self.pending_goal_replacement.is_some() {
            kinds.push(OverlayKind::GoalReplacement);
        }
        if self.history_search.is_some() {
            kinds.push(OverlayKind::HistorySearch);
        }
        if self.resume_session_picker.is_some() {
            kinds.push(OverlayKind::ResumeSession);
        }
        if self.context_inspector.is_some() {
            kinds.push(OverlayKind::ContextInspector);
        }
        if self.settings_inspector.is_some() {
            kinds.push(OverlayKind::SettingsInspector);
        }
        if self.keys_overlay.is_some() {
            kinds.push(OverlayKind::Keys);
        }
        if self.transcript_overlay.is_some() {
            kinds.push(OverlayKind::Transcript);
        }
        if self.copy_view.is_some() {
            kinds.push(OverlayKind::Copy);
        }
        if self.outline_open {
            kinds.push(OverlayKind::Outline);
        }
        if self.picker_overlay.is_some() {
            kinds.push(OverlayKind::Picker);
        }
        if self.side_question_overlay.is_some() {
            kinds.push(OverlayKind::SideQuestion);
        }
        kinds
    }

    fn active_overlay_kinds(&self) -> Vec<OverlayKind> {
        self.active_overlay.into_iter().collect()
    }

    fn has_active_overlay(&self) -> bool {
        self.active_overlay.is_some()
    }

    fn assert_overlay_state_consistent(&self) {
        debug_assert_eq!(self.active_overlay_kinds(), self.overlay_payload_kinds());
    }

    fn open_overlay_state(&mut self, kind: OverlayKind) {
        debug_assert!(self.active_overlay.is_none());
        self.active_overlay = Some(kind);
        self.assert_overlay_state_consistent();
    }

    fn close_overlay_state(&mut self, kind: OverlayKind) {
        if self.active_overlay == Some(kind) {
            self.active_overlay = None;
        }
        self.assert_overlay_state_consistent();
    }

    fn close_nonblocking_overlays(&mut self) {
        self.navigation.cancel_heading_work();
        self.outline_open = false;
        self.outline_geometry = None;
        self.outline_press = None;
        self.history_search = None;
        self.resume_session_picker = None;
        self.context_inspector = None;
        self.settings_inspector = None;
        self.keys_overlay = None;
        self.footer_shortcuts_overlay = false;
        self.transcript_overlay = None;
        self.copy_view = None;
        self.picker_overlay = None;
        if let Some(overlay) = self.side_question_overlay.take() {
            overlay.cancel.cancel();
        }
        if matches!(
            self.active_overlay,
            Some(
                OverlayKind::HistorySearch
                    | OverlayKind::ResumeSession
                    | OverlayKind::ContextInspector
                    | OverlayKind::SettingsInspector
                    | OverlayKind::Keys
                    | OverlayKind::Transcript
                    | OverlayKind::Outline
                    | OverlayKind::Copy
                    | OverlayKind::Picker
                    | OverlayKind::SideQuestion
            )
        ) {
            self.active_overlay = None;
        }
        self.assert_overlay_state_consistent();
    }

    fn open_side_question(&mut self, question: String) -> Option<(u64, CancellationToken)> {
        if !self.prepare_nonblocking_overlay() {
            return None;
        }
        self.side_question_sequence = self.side_question_sequence.wrapping_add(1).max(1);
        let id = self.side_question_sequence;
        let cancel = CancellationToken::new();
        self.side_question_overlay = Some(SideQuestionOverlay {
            id,
            question,
            status: SideQuestionStatus::Loading,
            scroll: 0,
            cancel: cancel.clone(),
            started_at: Instant::now(),
        });
        self.open_overlay_state(OverlayKind::SideQuestion);
        Some((id, cancel))
    }

    fn handle_side_question_key(&mut self, key: KeyEvent) {
        let Some(overlay) = self.side_question_overlay.as_mut() else {
            return;
        };
        match key.code {
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char(' ') if key.modifiers.is_empty() => {
                overlay.cancel.cancel();
                self.side_question_overlay = None;
                self.close_overlay_state(OverlayKind::SideQuestion);
            }
            KeyCode::Up => overlay.scroll = overlay.scroll.saturating_sub(1),
            KeyCode::Down => overlay.scroll = overlay.scroll.saturating_add(1),
            KeyCode::PageUp => overlay.scroll = overlay.scroll.saturating_sub(8),
            KeyCode::PageDown => overlay.scroll = overlay.scroll.saturating_add(8),
            _ => {}
        }
    }

    fn prepare_blocking_modal(&mut self) {
        self.close_slash_menu();
        self.close_nonblocking_overlays();
    }

    fn prepare_nonblocking_overlay(&mut self) -> bool {
        if self.has_active_modal() {
            return false;
        }
        self.close_slash_menu();
        self.close_nonblocking_overlays();
        true
    }

    fn enqueue_permission_dialog(&mut self, dialog: PermissionDialog) {
        self.spinner.pause();
        if self.has_active_modal() {
            self.permission_queue.push_back(dialog);
        } else {
            self.prepare_blocking_modal();
            self.pending_permission = Some(dialog);
            self.open_overlay_state(OverlayKind::Permission);
        }
    }

    fn enqueue_question_dialog(&mut self, dialog: QuestionDialog) {
        self.spinner.pause();
        if self.has_active_modal() {
            self.question_queue.push_back(dialog);
        } else {
            self.prepare_blocking_modal();
            self.pending_question = Some(dialog);
            self.open_overlay_state(OverlayKind::Question);
        }
    }

    fn activate_next_modal_or_resume_spinner(&mut self) {
        if self.has_active_modal() {
            return;
        }
        if let Some(dialog) = self.permission_queue.pop_front() {
            self.prepare_blocking_modal();
            self.pending_permission = Some(dialog);
            self.open_overlay_state(OverlayKind::Permission);
            self.spinner.pause();
        } else if let Some(dialog) = self.question_queue.pop_front() {
            self.prepare_blocking_modal();
            self.pending_question = Some(dialog);
            self.open_overlay_state(OverlayKind::Question);
            self.spinner.pause();
        } else {
            self.spinner.resume();
        }
    }

    fn has_interruptible_turn(&self) -> bool {
        self.turn_state.is_active() || self.is_loading || self.spinner.is_running()
    }

    fn has_active_goal(&self) -> bool {
        self.goal
            .as_ref()
            .is_some_and(|goal| goal.status == GoalStatus::Active)
    }

    fn deny_permission_dialog(dialog: PermissionDialog) {
        let _ = dialog.response_tx.send(PermissionDialogResult {
            response: PermissionResponse::DenyOnce,
            modified_input: None,
        });
    }

    fn cancel_question_dialog(dialog: QuestionDialog) {
        let _ = dialog.response_tx.send(UserQuestionResponse {
            questions: dialog.request.questions,
            answers: dialog.request.answers,
            annotations: dialog.request.annotations,
        });
    }

    fn cancel_blocking_modals(&mut self) {
        if let Some(dialog) = self.pending_permission.take() {
            Self::deny_permission_dialog(dialog);
            self.close_overlay_state(OverlayKind::Permission);
        }
        if let Some(editor) = self.permission_editor.take() {
            let _ = editor.response_tx.send(PermissionDialogResult {
                response: PermissionResponse::DenyOnce,
                modified_input: None,
            });
            self.close_overlay_state(OverlayKind::PermissionEditor);
        }
        while let Some(dialog) = self.permission_queue.pop_front() {
            Self::deny_permission_dialog(dialog);
        }
        if let Some(dialog) = self.pending_question.take() {
            Self::cancel_question_dialog(dialog);
            self.close_overlay_state(OverlayKind::Question);
        }
        if self.pending_goal_replacement.take().is_some() {
            self.close_overlay_state(OverlayKind::GoalReplacement);
        }
        while let Some(dialog) = self.question_queue.pop_front() {
            Self::cancel_question_dialog(dialog);
        }
    }

    fn interrupt_current_turn(&mut self) -> Option<UserAction> {
        if self.deferred_turn_finish_pending
            && !self.turn_state.is_active()
            && !self.has_active_goal()
        {
            self.clear_quit_shortcut();
            self.cancel_blocking_modals();
            return Some(UserAction::CompleteDeferredTurn);
        }
        let has_interruptible_turn = self.has_interruptible_turn();
        if !has_interruptible_turn && !self.has_active_goal() {
            return None;
        }
        self.clear_quit_shortcut();
        if has_interruptible_turn {
            // Escape while a wait-style tool (Sleep, wait) is running collapses
            // its remaining wait to a short grace period instead of cancelling
            // the turn: the tool still returns normally, so the model can
            // continue with fresh results after a stale time estimate.
            if self
                .active_turn
                .as_ref()
                .is_some_and(|active| active.has_running_shortenable_tool())
            {
                self.set_transient_status("Shortened the wait to 0.5s");
                return Some(UserAction::ShortenToolWait);
            }
            self.path_previews.clear();
            let was_already_cancelled = self
                .turn_state
                .cancel_flag()
                .map(|cancel| {
                    let was_cancelled = cancel.is_cancelled();
                    cancel.cancel();
                    was_cancelled
                })
                .unwrap_or(false);
            self.cancel_blocking_modals();
            self.set_loading(false);
            self.flush_active_turn();
            if let Some(handle) = self.take_deferred_turn_finish_handle() {
                await_turn_task_for_logging(handle);
            }
            if !was_already_cancelled {
                self.push_message(MessageRole::System, "Cancelled.".to_string());
            }
        }
        Some(UserAction::Interrupt)
    }

    fn open_permission_editor(&mut self, dialog: PermissionDialog) {
        self.prepare_blocking_modal();
        let text = serde_json::to_string_pretty(&dialog.input)
            .unwrap_or_else(|_| dialog.input.to_string());
        self.permission_editor = Some(PermissionEditor {
            tool_name: dialog.tool_name,
            text,
            cursor_grapheme_index: 0,
            response_tx: dialog.response_tx,
        });
        self.open_overlay_state(OverlayKind::PermissionEditor);
    }

    fn close_permission_editor(&mut self, result: PermissionDialogResult) {
        if let Some(editor) = self.permission_editor.take() {
            let _ = editor.response_tx.send(result);
            self.close_overlay_state(OverlayKind::PermissionEditor);
        }
        self.activate_next_modal_or_resume_spinner();
    }

    fn handle_permission_editor_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        let editor = self.permission_editor.as_mut()?;
        match key.code {
            KeyCode::Esc => {
                self.close_permission_editor(PermissionDialogResult {
                    response: PermissionResponse::DenyOnce,
                    modified_input: None,
                });
            }
            KeyCode::Enter if key.modifiers == KeyModifiers::CONTROL => {
                let editor = self.permission_editor.take().unwrap();
                let result = match serde_json::from_str::<serde_json::Value>(&editor.text) {
                    Ok(input) => PermissionDialogResult {
                        response: PermissionResponse::AllowOnce,
                        modified_input: Some(input),
                    },
                    Err(e) => {
                        self.push_message(
                            MessageRole::System,
                            format!("Invalid JSON in edited tool input: {}", e),
                        );
                        PermissionDialogResult {
                            response: PermissionResponse::DenyOnce,
                            modified_input: None,
                        }
                    }
                };
                let _ = editor.response_tx.send(result);
                self.close_overlay_state(OverlayKind::PermissionEditor);
                self.activate_next_modal_or_resume_spinner();
            }
            KeyCode::Char(c) if !key_hint::has_ctrl_or_alt(key.modifiers) => {
                let byte_pos = byte_index_for_grapheme(&editor.text, editor.cursor_grapheme_index);
                editor.text.insert(byte_pos, c);
                editor.cursor_grapheme_index += 1;
            }
            KeyCode::Backspace if editor.cursor_grapheme_index > 0 => {
                let start = byte_index_for_grapheme(&editor.text, editor.cursor_grapheme_index - 1);
                let end = byte_index_for_grapheme(&editor.text, editor.cursor_grapheme_index);
                editor.text.replace_range(start..end, "");
                editor.cursor_grapheme_index -= 1;
            }
            KeyCode::Delete => {
                let graphemes = editor.text.graphemes(true).collect::<Vec<_>>();
                let idx = editor.cursor_grapheme_index.min(graphemes.len());
                if idx < graphemes.len() {
                    let start = byte_index_for_grapheme(&editor.text, idx);
                    let end = byte_index_for_grapheme(&editor.text, idx + 1);
                    editor.text.replace_range(start..end, "");
                }
            }
            KeyCode::Left if editor.cursor_grapheme_index > 0 => {
                editor.cursor_grapheme_index -= 1;
            }
            KeyCode::Right => {
                let len = editor.text.graphemes(true).count();
                if editor.cursor_grapheme_index < len {
                    editor.cursor_grapheme_index += 1;
                }
            }
            KeyCode::Home => {
                editor.cursor_grapheme_index = 0;
            }
            KeyCode::End => {
                editor.cursor_grapheme_index = editor.text.graphemes(true).count();
            }
            _ => {}
        }
        None
    }

    fn handle_question_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        let area = self.last_frame_area;
        let dialog = self.pending_question.as_mut().unwrap();
        let option_count = question_dialog_option_count(&dialog.request.questions[dialog.focused]);
        let multi_select = dialog.request.questions[dialog.focused].multi_select;

        match key.code {
            KeyCode::Up if key.modifiers.is_empty() => {
                move_question_dialog_cursor_by(dialog, -1, area, true);
            }
            KeyCode::Char('k')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                move_question_dialog_cursor_by(dialog, -1, area, true);
            }
            KeyCode::Down if key.modifiers.is_empty() => {
                move_question_dialog_cursor_by(dialog, 1, area, true);
            }
            KeyCode::Char('j')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                move_question_dialog_cursor_by(dialog, 1, area, true);
            }
            KeyCode::Home if key.modifiers.is_empty() => {
                set_question_dialog_cursor(dialog, 0, area, true);
            }
            KeyCode::End if key.modifiers.is_empty() => {
                set_question_dialog_cursor(dialog, option_count.saturating_sub(1), area, true);
            }
            KeyCode::PageUp if key.modifiers.is_empty() => {
                let visible = question_dialog_visible_options_for_area(dialog, area).max(1);
                move_question_dialog_cursor_by(dialog, -(visible as isize), area, false);
            }
            KeyCode::PageDown if key.modifiers.is_empty() => {
                let visible = question_dialog_visible_options_for_area(dialog, area).max(1);
                move_question_dialog_cursor_by(dialog, visible as isize, area, false);
            }
            KeyCode::Left if dialog.focused > 0 => {
                let next = dialog.focused.saturating_sub(1);
                question_dialog_set_focus(dialog, next, area);
            }
            KeyCode::Right if dialog.focused + 1 < dialog.request.questions.len() => {
                let next = dialog.focused.saturating_add(1);
                question_dialog_set_focus(dialog, next, area);
            }
            KeyCode::Char(' ') if multi_select && key.modifiers.is_empty() => {
                let idx = dialog.cursor;
                if dialog.selected.contains(&idx) {
                    if dialog.selected.len() > 1 {
                        dialog.selected.retain(|&i| i != idx);
                    }
                } else {
                    dialog.selected.push(idx);
                    dialog.selected.sort_unstable();
                }
                question_dialog_clear_current_answer(dialog);
                question_dialog_save_current_state(dialog);
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                let mut dialog = self.pending_question.take().unwrap();
                question_dialog_commit_current_answer(&mut dialog);
                question_dialog_save_current_state(&mut dialog);
                dialog.focused = dialog.focused.saturating_add(1);
                if dialog.focused < dialog.request.questions.len() {
                    question_dialog_restore_focused_state(&mut dialog, area);
                    self.pending_question = Some(dialog);
                } else {
                    let response = UserQuestionResponse {
                        questions: dialog.request.questions,
                        answers: dialog.request.answers,
                        annotations: dialog.request.annotations,
                    };
                    let _ = dialog.response_tx.send(response);
                    self.close_overlay_state(OverlayKind::Question);
                    self.activate_next_modal_or_resume_spinner();
                }
            }
            KeyCode::Esc if key.modifiers.is_empty() => {
                let dialog = self.pending_question.take().unwrap();
                let response = UserQuestionResponse {
                    questions: dialog.request.questions,
                    answers: dialog.request.answers,
                    annotations: dialog.request.annotations,
                };
                let _ = dialog.response_tx.send(response);
                self.close_overlay_state(OverlayKind::Question);
                self.activate_next_modal_or_resume_spinner();
            }
            _ => {}
        }
        None
    }

    fn handle_goal_replacement_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        match key.code {
            KeyCode::Left | KeyCode::Up | KeyCode::Right | KeyCode::Down
                if key.modifiers.is_empty() =>
            {
                let dialog = self.pending_goal_replacement.as_mut().unwrap();
                dialog.selected = 1usize.saturating_sub(dialog.selected.min(1));
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                let selected = self
                    .pending_goal_replacement
                    .as_ref()
                    .map(|dialog| dialog.selected)
                    .unwrap_or(1);
                if selected == 0 {
                    return self.confirm_goal_replacement();
                }
                self.cancel_goal_replacement();
            }
            KeyCode::Char('y') | KeyCode::Char('Y')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                return self.confirm_goal_replacement();
            }
            KeyCode::Char('n') | KeyCode::Char('N')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                self.cancel_goal_replacement();
            }
            KeyCode::Esc if key.modifiers.is_empty() => self.cancel_goal_replacement(),
            _ => {}
        }
        None
    }

    fn confirm_goal_replacement(&mut self) -> Option<UserAction> {
        let dialog = self.pending_goal_replacement.take()?;
        self.close_overlay_state(OverlayKind::GoalReplacement);
        self.activate_next_modal_or_resume_spinner();
        Some(UserAction::ConfirmGoalReplacement {
            objective: dialog.objective,
            token_budget: dialog.token_budget,
            mode: dialog.mode,
            verification_kind: dialog.verification_kind,
        })
    }

    fn cancel_goal_replacement(&mut self) {
        if self.pending_goal_replacement.take().is_some() {
            self.close_overlay_state(OverlayKind::GoalReplacement);
            self.push_message(MessageRole::System, "Goal replacement cancelled.");
            self.activate_next_modal_or_resume_spinner();
        }
    }

    fn open_history_search(&mut self) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.expand_deferred_resumed_transcript();
        let search = HistorySearch {
            query: String::new(),
            selected: 0,
            matches: Vec::new(),
            status: HistorySearchStatus::Idle,
            original_input: self.input.clone(),
            original_cursor_grapheme_index: self.cursor_grapheme_index,
            original_input_scroll_row: self.input_scroll_row,
        };
        self.history_search = Some(search);
        self.open_overlay_state(OverlayKind::HistorySearch);
    }

    fn history_search_matches_for_query(&self, query: &str) -> Vec<usize> {
        if query.is_empty() {
            return Vec::new();
        }
        let query = query.to_lowercase();
        self.messages
            .iter()
            .enumerate()
            .filter(|(_, msg)| msg.role == MessageRole::User)
            .filter_map(|(i, msg)| {
                if query.is_empty() || msg.text.to_lowercase().contains(&query) {
                    Some(i)
                } else {
                    None
                }
            })
            .collect()
    }

    fn restore_history_search_original_draft(&mut self, search: &HistorySearch) {
        self.input = search.original_input.clone();
        self.cursor_grapheme_index = search.original_cursor_grapheme_index;
        self.input_scroll_row = search.original_input_scroll_row;
        self.clamp_input_scroll(self.last_input_width);
    }

    fn preview_history_search_match(&mut self, message_index: usize) {
        let Some(message) = self.messages.get(message_index) else {
            return;
        };
        self.input = sanitize_tui_text(&message.text);
        self.cursor_grapheme_index = self.input_graphemes().len();
        self.input_scroll_row = 0;
        self.clamp_input_scroll(self.last_input_width);
    }

    fn refresh_history_search_preview(&mut self, mut search: HistorySearch) {
        search.matches = self.history_search_matches_for_query(&search.query);
        if search.matches.is_empty() {
            search.selected = 0;
            search.status = if search.query.is_empty() {
                HistorySearchStatus::Idle
            } else {
                HistorySearchStatus::NoMatch
            };
            self.restore_history_search_original_draft(&search);
        } else {
            if search.selected >= search.matches.len() {
                search.selected = search.matches.len().saturating_sub(1);
            }
            search.status = HistorySearchStatus::Match;
            if let Some(&message_index) = search.matches.get(search.selected) {
                self.preview_history_search_match(message_index);
            }
        }
        self.history_search = Some(search);
    }

    fn update_history_search_query(&mut self, mut search: HistorySearch, query: String) {
        search.query = query;
        search.selected = usize::MAX;
        self.refresh_history_search_preview(search);
    }

    fn close_history_search_accepting_preview(&mut self) {
        self.history_search = None;
        self.close_overlay_state(OverlayKind::HistorySearch);
        self.clear_edit_previous_prompt();
    }

    fn cancel_history_search(&mut self, search: HistorySearch) {
        self.restore_history_search_original_draft(&search);
        self.history_search = None;
        self.close_overlay_state(OverlayKind::HistorySearch);
        self.clear_edit_previous_prompt();
    }

    fn handle_history_key(&mut self, key: KeyEvent) {
        let mut search = self.history_search.take().unwrap();
        let altgr = key_hint::is_altgr(key.modifiers);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL) && !altgr;
        let alt = key.modifiers.contains(KeyModifiers::ALT) && !altgr;

        match key.code {
            KeyCode::Esc => {
                self.cancel_history_search(search);
                return;
            }
            KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'c') => {
                self.cancel_history_search(search);
                return;
            }
            KeyCode::Char('\u{0003}') if key.modifiers.is_empty() => {
                self.cancel_history_search(search);
                return;
            }
            KeyCode::Enter => {
                if search.status == HistorySearchStatus::Match {
                    self.close_history_search_accepting_preview();
                } else {
                    self.history_search = Some(search);
                }
                return;
            }
            KeyCode::Up => {
                if search.selected > 0 {
                    search.selected -= 1;
                }
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Down => {
                if search.selected + 1 < search.matches.len() {
                    search.selected += 1;
                }
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'r') => {
                if search.selected > 0 {
                    search.selected -= 1;
                }
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'s') => {
                if search.selected + 1 < search.matches.len() {
                    search.selected += 1;
                }
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Home => {
                search.selected = 0;
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::End => {
                search.selected = search.matches.len().saturating_sub(1);
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::PageUp => {
                search.selected = search.selected.saturating_sub(8);
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::PageDown => {
                search.selected = search
                    .selected
                    .saturating_add(8)
                    .min(search.matches.len().saturating_sub(1));
                self.refresh_history_search_preview(search);
                return;
            }
            KeyCode::Backspace if !search.query.is_empty() => {
                let graphemes: Vec<&str> = search.query.graphemes(true).collect();
                let query = graphemes[..graphemes.len() - 1].concat();
                self.update_history_search_query(search, query);
                return;
            }
            KeyCode::Char(c)
                if ctrl && c.eq_ignore_ascii_case(&'h') && !search.query.is_empty() =>
            {
                let graphemes: Vec<&str> = search.query.graphemes(true).collect();
                let query = graphemes[..graphemes.len() - 1].concat();
                self.update_history_search_query(search, query);
                return;
            }
            KeyCode::Char(c) if ctrl && c.eq_ignore_ascii_case(&'u') => {
                self.update_history_search_query(search, String::new());
                return;
            }
            KeyCode::Char(c) if !ctrl && !alt && !c.is_ascii_control() => {
                let mut query = search.query.clone();
                query.push(c);
                self.update_history_search_query(search, query);
                return;
            }
            _ => {}
        }

        self.history_search = Some(search);
    }

    fn open_slash_menu(&mut self) {
        if self.has_active_overlay() {
            return;
        }
        self.slash_menu = Some(SlashMenu { selected: 0 });
    }

    fn close_slash_menu(&mut self) {
        self.slash_menu = None;
    }

    fn cancel_slash_menu_draft(&mut self) {
        self.close_slash_menu();
        if self.input.starts_with('/') {
            self.reset_input_history_navigation();
            self.input.clear();
            self.cursor_grapheme_index = 0;
            self.input_scroll_row = 0;
            self.last_input_width = 0;
        }
        self.clear_edit_previous_prompt();
        self.force_next_viewport_redraw();
    }

    fn accept_slash_menu_selection(&mut self, selected: usize) {
        let selected_name = self
            .slash_menu_matches()
            .get(selected)
            .map(|cmd| cmd.name().to_string());
        if let Some(name) = selected_name {
            self.input = format!("{} ", name);
            self.cursor_grapheme_index = self.input_graphemes().len();
            self.clamp_input_scroll(self.last_input_width);
        }
        self.close_slash_menu();
    }

    fn submit_slash_menu_selection(&mut self, selected: usize) -> Option<UserAction> {
        if self
            .slash_menu_matches()
            .get(selected)
            .is_some_and(|cmd| cmd.needs_arguments())
        {
            self.accept_slash_menu_selection(selected);
            return None;
        }
        let selected_name = self
            .slash_menu_matches()
            .get(selected)
            .map(|cmd| cmd.name().to_string());
        self.close_slash_menu();
        let name = selected_name?;

        self.reset_input_history_navigation();
        self.input.clear();
        self.pending_pastes.clear();
        self.local_image_attachments.clear();
        self.remote_image_urls.clear();
        self.selected_remote_image_index = None;
        self.cursor_grapheme_index = 0;
        self.input_scroll_row = 0;
        self.last_input_width = 0;
        self.last_submit_at = Some(std::time::Instant::now());
        self.push_input_history(name.clone());
        self.force_next_viewport_redraw();
        Some(UserAction::SlashCommand(name))
    }

    fn open_context_inspector(&mut self, breakdown: ContextBreakdown) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.context_inspector = Some(ContextInspector { breakdown });
        self.open_overlay_state(OverlayKind::ContextInspector);
    }

    fn close_context_inspector(&mut self) {
        self.context_inspector = None;
        self.close_overlay_state(OverlayKind::ContextInspector);
    }

    fn handle_context_inspector_key(&mut self, key: KeyEvent) {
        if is_ctrl_c_key(&key) {
            self.close_context_inspector();
            return;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.close_context_inspector();
            }
            _ => {}
        }
    }

    fn open_settings_inspector(&mut self, lines: Vec<String>) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.settings_inspector = Some(SettingsInspector { lines });
        self.open_overlay_state(OverlayKind::SettingsInspector);
    }

    fn close_settings_inspector(&mut self) {
        self.settings_inspector = None;
        self.close_overlay_state(OverlayKind::SettingsInspector);
    }

    fn handle_settings_inspector_key(&mut self, key: KeyEvent) {
        if is_ctrl_c_key(&key) {
            self.close_settings_inspector();
            return;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.close_settings_inspector();
            }
            _ => {}
        }
    }

    fn open_keys_overlay(&mut self) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.keys_overlay = Some(KeysOverlay);
        self.open_overlay_state(OverlayKind::Keys);
    }

    fn close_keys_overlay(&mut self) {
        self.keys_overlay = None;
        self.close_overlay_state(OverlayKind::Keys);
    }

    fn handle_keys_overlay_key(&mut self, key: KeyEvent) {
        if is_ctrl_c_key(&key) {
            self.close_keys_overlay();
            return;
        }
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('?') => {
                self.close_keys_overlay();
            }
            _ => {}
        }
    }

    fn toggle_footer_shortcuts_overlay(&mut self) {
        self.footer_shortcuts_overlay = !self.footer_shortcuts_overlay;
        self.force_next_viewport_redraw();
    }

    fn close_footer_shortcuts_overlay(&mut self) {
        if self.footer_shortcuts_overlay {
            self.footer_shortcuts_overlay = false;
            self.force_next_viewport_redraw();
        }
    }

    fn open_transcript_overlay(&mut self) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        self.expand_deferred_resumed_transcript();
        self.transcript_overlay = Some(TranscriptOverlay::new_at_bottom());
        self.open_overlay_state(OverlayKind::Transcript);
        self.force_next_viewport_redraw();
    }

    fn close_transcript_overlay(&mut self) {
        if self.navigation.inline {
            let previous = self.navigation.inline_previous_position.unwrap_or_default();
            self.navigation = transcript_navigation::NavigationState::default();
            self.transcript_viewport.set_position(previous);
        }
        self.transcript_overlay = None;
        self.close_overlay_state(OverlayKind::Transcript);
        self.force_next_viewport_redraw();
    }

    fn handle_transcript_overlay_key(&mut self, key: KeyEvent) {
        if self.navigation.inline {
            let step = match key.code {
                KeyCode::Up => Some(-3),
                KeyCode::Down => Some(3),
                KeyCode::PageUp => Some(-(self.transcript_viewport.viewport_rows() as i32).max(1)),
                KeyCode::PageDown => Some(self.transcript_viewport.viewport_rows().max(1) as i32),
                _ => None,
            };
            if let Some(step) = step {
                self.transcript_viewport.scroll_lines(step);
                return;
            }
            if key.code == KeyCode::End {
                self.jump_transcript("latest");
                return;
            }
        }
        if is_ctrl_c_key(&key) {
            self.close_transcript_overlay();
            return;
        }
        if is_tool_transcript_toggle_shortcut(&key) {
            self.toggle_tool_transcript_expanded();
            return;
        }
        match key.code {
            KeyCode::Esc if key.modifiers.is_empty() => {
                self.close_transcript_overlay();
            }
            KeyCode::Char('q')
                if matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT) =>
            {
                self.close_transcript_overlay();
            }
            _ if is_transcript_overlay_shortcut(&key) => {
                self.close_transcript_overlay();
            }
            KeyCode::Up => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.scroll_by(-3);
                }
            }
            KeyCode::Down => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.scroll_by(3);
                }
            }
            KeyCode::PageUp => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.page_by(-1);
                }
            }
            KeyCode::PageDown => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.page_by(1);
                }
            }
            KeyCode::Home => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.scroll_home();
                }
            }
            KeyCode::End => {
                if let Some(overlay) = self.transcript_overlay.as_mut() {
                    overlay.scroll_end();
                }
            }
            _ => {}
        }
    }

    #[cfg(test)]
    fn open_picker_overlay(
        &mut self,
        title: &'static str,
        items: Vec<String>,
        on_confirm: PickerAction,
    ) {
        self.open_picker_overlay_with_selected(title, items, on_confirm, 0);
    }

    fn open_picker_overlay_with_selected(
        &mut self,
        title: &'static str,
        items: Vec<String>,
        on_confirm: PickerAction,
        selected: usize,
    ) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        let selected = selected.min(items.len().saturating_sub(1));
        self.picker_overlay = Some(PickerOverlay {
            title,
            all_items: items,
            item_values: Vec::new(),
            selected,
            filter: String::new(),
            item_turns: Vec::new(),
            on_confirm,
        });
        self.open_overlay_state(OverlayKind::Picker);
    }

    /// Open the rewind picker: one row per past user prompt, each carrying
    /// its checkpoint turn number. Confirming emits `/rewind <turn>`.
    pub(crate) fn open_rewind_picker(&mut self, entries: Vec<(u64, String)>) {
        if !self.prepare_nonblocking_overlay() {
            return;
        }
        let items: Vec<String> = entries
            .iter()
            .map(|(turn, preview)| format!("{turn}. {preview}"))
            .collect();
        let item_turns: Vec<u64> = entries.into_iter().map(|(turn, _)| turn).collect();
        // Preselect the latest prompt: rewinding usually targets a recent turn.
        let selected = items.len().saturating_sub(1);
        self.picker_overlay = Some(PickerOverlay {
            title: "Rewind to before which prompt? (files and conversation are restored)",
            all_items: items,
            item_values: Vec::new(),
            selected,
            filter: String::new(),
            item_turns,
            on_confirm: PickerAction::RewindToTurn,
        });
        self.open_overlay_state(OverlayKind::Picker);
    }

    fn close_picker_overlay(&mut self) {
        self.picker_overlay = None;
        self.close_overlay_state(OverlayKind::Picker);
    }

    fn handle_picker_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        let altgr = key_hint::is_altgr(key.modifiers);
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL) && !altgr;
        let alt = key.modifiers.contains(KeyModifiers::ALT) && !altgr;
        if is_ctrl_c_key(&key) {
            self.close_picker_overlay();
            return None;
        }
        let picker = self.picker_overlay.as_mut()?;
        let matches = picker.matches();
        match key.code {
            KeyCode::Esc => {
                self.close_picker_overlay();
                None
            }
            KeyCode::Up => {
                if picker.selected > 0 {
                    picker.selected -= 1;
                }
                None
            }
            KeyCode::Char('p') if key.modifiers == KeyModifiers::CONTROL => {
                if picker.selected > 0 {
                    picker.selected -= 1;
                }
                None
            }
            KeyCode::Down => {
                if picker.selected + 1 < matches.len() {
                    picker.selected += 1;
                }
                None
            }
            KeyCode::Char('n') if key.modifiers == KeyModifiers::CONTROL => {
                if picker.selected + 1 < matches.len() {
                    picker.selected += 1;
                }
                None
            }
            KeyCode::Home => {
                picker.selected = 0;
                None
            }
            KeyCode::End => {
                picker.selected = matches.len().saturating_sub(1);
                None
            }
            KeyCode::PageUp => {
                picker.selected = picker.selected.saturating_sub(PICKER_MAX_ITEMS);
                None
            }
            KeyCode::PageDown => {
                picker.selected = picker
                    .selected
                    .saturating_add(PICKER_MAX_ITEMS)
                    .min(matches.len().saturating_sub(1));
                None
            }
            KeyCode::Backspace => {
                if !picker.filter.is_empty() {
                    picker.filter.pop();
                    picker.selected = 0;
                }
                None
            }
            KeyCode::Char(c) if (!ctrl && !alt || altgr) && !c.is_ascii_control() => {
                picker.filter.push(c);
                picker.selected = 0;
                None
            }
            KeyCode::Enter => {
                let indexed = picker.matches_indexed();
                let (item_index, item) = indexed.get(picker.selected).cloned()?;
                let value = picker.value_for_original_index(item_index, &item);
                let action = picker.on_confirm;
                let rewind_turn = if matches!(action, PickerAction::RewindToTurn) {
                    picker.selected_turn()
                } else {
                    None
                };
                self.close_picker_overlay();
                match action {
                    PickerAction::ViewAgent => {
                        Some(UserAction::SlashCommand(format!("/agent view {value}")))
                    }
                    PickerAction::SwitchModel => {
                        Some(UserAction::SlashCommand(format!("/model {}", value)))
                    }
                    PickerAction::SwitchTheme => {
                        Some(UserAction::SlashCommand(format!("/theme {}", item)))
                    }
                    PickerAction::RewindToTurn => {
                        rewind_turn.map(|turn| UserAction::SlashCommand(format!("/rewind {turn}")))
                    }
                }
            }
            _ => None,
        }
    }

    fn slash_menu_query(&self) -> &str {
        self.input.strip_prefix('/').unwrap_or("")
    }

    fn slash_menu_query_is_empty(&self) -> bool {
        self.slash_menu_query().trim_start().is_empty()
    }

    fn slash_menu_query_has_arguments(&self) -> bool {
        self.slash_menu_query()
            .contains(|c: char| c.is_whitespace())
    }

    fn slash_menu_can_accept_selection(&self) -> bool {
        !self.slash_menu_query_has_arguments()
    }

    fn slash_menu_matches(&self) -> Vec<&dyn slash::SlashCommand> {
        let query = self.slash_menu_query().trim_start().to_lowercase();
        if query.is_empty() {
            return self.slash_registry.iter().collect();
        }

        let mut exact = Vec::new();
        let mut prefix = Vec::new();
        for cmd in self.slash_registry.iter() {
            match slash_menu_match_kind(cmd, &query) {
                SlashMenuMatchKind::Exact => exact.push(cmd),
                SlashMenuMatchKind::Prefix => prefix.push(cmd),
                SlashMenuMatchKind::None => {}
            }
        }
        exact.extend(prefix);
        exact
    }

    fn move_slash_menu_selection_up(&mut self) {
        if let Some(menu) = self.slash_menu.as_mut()
            && menu.selected > 0
        {
            menu.selected -= 1;
        }
    }

    fn move_slash_menu_selection_down(&mut self) {
        let count = self.slash_menu_matches().len();
        if let Some(menu) = self.slash_menu.as_mut()
            && menu.selected + 1 < count
        {
            menu.selected += 1;
        }
    }

    /// Handle keys for the slash-command menu. Returns `true` if the event was
    /// consumed by the menu.
    fn handle_slash_menu_key(&mut self, key: KeyEvent) -> bool {
        if self.slash_menu.is_none() {
            return false;
        }

        match key.code {
            KeyCode::Esc => {
                self.cancel_slash_menu_draft();
                true
            }
            KeyCode::Up => {
                self.move_slash_menu_selection_up();
                true
            }
            KeyCode::Char('p') if key.modifiers == KeyModifiers::CONTROL => {
                self.move_slash_menu_selection_up();
                true
            }
            KeyCode::Down => {
                self.move_slash_menu_selection_down();
                true
            }
            KeyCode::Char('n') if key.modifiers == KeyModifiers::CONTROL => {
                self.move_slash_menu_selection_down();
                true
            }
            KeyCode::Home => {
                if let Some(menu) = self.slash_menu.as_mut() {
                    menu.selected = 0;
                }
                true
            }
            KeyCode::End => {
                let count = self.slash_menu_matches().len();
                if let Some(menu) = self.slash_menu.as_mut() {
                    menu.selected = count.saturating_sub(1);
                }
                true
            }
            KeyCode::PageUp => {
                if let Some(menu) = self.slash_menu.as_mut() {
                    menu.selected = menu.selected.saturating_sub(8);
                }
                true
            }
            KeyCode::PageDown => {
                let count = self.slash_menu_matches().len();
                if let Some(menu) = self.slash_menu.as_mut() {
                    menu.selected = menu.selected.saturating_add(8).min(count.saturating_sub(1));
                }
                true
            }
            KeyCode::Enter | KeyCode::Tab => {
                if !self.slash_menu_can_accept_selection() {
                    self.close_slash_menu();
                    return false;
                }
                let selected = self
                    .slash_menu
                    .as_ref()
                    .map(|menu| menu.selected)
                    .unwrap_or(0);
                self.accept_slash_menu_selection(selected);
                true
            }
            KeyCode::Char('/') if key.modifiers.is_empty() => {
                if self.slash_menu_query_is_empty() {
                    return true;
                }
                if !self.slash_menu_can_accept_selection() {
                    self.close_slash_menu();
                    return false;
                }
                let selected = self
                    .slash_menu
                    .as_ref()
                    .map(|menu| menu.selected)
                    .unwrap_or(0);
                self.accept_slash_menu_selection(selected);
                true
            }
            _ => false,
        }
    }

    /// Open or close the slash menu based on the current input.
    fn sync_slash_menu(&mut self) {
        if self.mention_menu.is_some() {
            self.close_slash_menu();
            return;
        }
        if self.has_active_overlay() {
            self.close_slash_menu();
            return;
        }
        let should_open =
            self.input.starts_with('/') && !self.input.contains(|c: char| c.is_whitespace());
        if should_open && self.slash_menu.is_none() {
            self.open_slash_menu();
        } else if !should_open {
            self.close_slash_menu();
        }
        let count = self.slash_menu_matches().len();
        if let Some(menu) = self.slash_menu.as_mut()
            && menu.selected >= count
        {
            menu.selected = count.saturating_sub(1);
        }
    }

    fn sync_mention_menu(&mut self) {
        if self.has_active_overlay() || self.input.starts_with('/') {
            self.mention_menu = None;
            return;
        }
        let cursor = self.byte_index_for_grapheme(self.cursor_grapheme_index);
        let prefix = &self.input[..cursor.min(self.input.len())];
        let Some(at) = prefix.rfind('@') else {
            self.mention_menu = None;
            return;
        };
        if at > 0
            && !prefix[..at]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace)
        {
            self.mention_menu = None;
            return;
        }
        let query = &prefix[at + 1..];
        if query.contains(char::is_whitespace) {
            self.mention_menu = None;
            return;
        }
        let previous_selected = self
            .mention_menu
            .as_ref()
            .and_then(|menu| menu.candidates.get(menu.selected))
            .cloned();
        if self.mention_file_index.is_empty() {
            self.mention_file_index = project_file_index(Path::new(&self.display_cwd), 20_000);
        }
        let mut candidates = fuzzy_file_candidates(&self.mention_file_index, query, 40);
        if candidates.is_empty() {
            self.mention_menu = None;
            return;
        }
        let selected = previous_selected
            .and_then(|path| candidates.iter().position(|candidate| candidate == &path))
            .unwrap_or(0);
        candidates.truncate(40);
        self.mention_menu = Some(MentionMenu {
            replace_start: at,
            replace_end: cursor,
            candidates,
            selected,
        });
    }

    fn accept_mention_selection(&mut self) {
        let Some(menu) = self.mention_menu.take() else {
            return;
        };
        let Some(path) = menu.candidates.get(menu.selected) else {
            return;
        };
        let replacement = format!("@{} ", path.replace(' ', "\\ "));
        self.input
            .replace_range(menu.replace_start..menu.replace_end, &replacement);
        let byte_cursor = menu.replace_start + replacement.len();
        self.cursor_grapheme_index = self.input[..byte_cursor].graphemes(true).count();
        self.sync_composer_sidecars();
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> Option<UserAction> {
        if !matches!(key.kind, KeyEventKind::Press | KeyEventKind::Repeat) {
            return None;
        }
        if self.copy_view.is_some() {
            self.handle_copy_key(key);
            return None;
        }
        if key.code == KeyCode::F(9) && key.modifiers.is_empty() {
            self.open_copy_view();
            return None;
        }
        if key.code == KeyCode::Esc
            && self.transcript_selection.is_some()
            && !self.has_active_overlay()
        {
            self.clear_transcript_selection();
            return None;
        }
        if key.code == KeyCode::Esc
            && !self.has_active_modal()
            && !self.outline_open
            && self.navigation.pending()
        {
            self.cancel_pending_navigation_for_input();
            return None;
        }

        if key.kind == KeyEventKind::Press && is_suspend_key(&key) {
            return Some(UserAction::Suspend);
        }
        if !matches!(key.code, KeyCode::Up | KeyCode::Down) {
            self.composer_preferred_col = None;
        }

        let altgr = key_hint::is_altgr(key.modifiers);
        let shortcut_overlay_key_code = key.code == KeyCode::Char('?')
            && matches!(key.modifiers, KeyModifiers::NONE | KeyModifiers::SHIFT);
        let shortcut_overlay_key = key.kind == KeyEventKind::Press && shortcut_overlay_key_code;
        let shortcut_overlay_repeat_key =
            key.kind == KeyEventKind::Repeat && shortcut_overlay_key_code;
        if self.footer_shortcuts_overlay {
            if shortcut_overlay_repeat_key {
                return None;
            }
            if shortcut_overlay_key && self.composer_is_empty_for_shortcuts() {
                self.toggle_footer_shortcuts_overlay();
                return None;
            }
            if key.code == KeyCode::Esc && key.modifiers.is_empty() {
                self.close_footer_shortcuts_overlay();
                self.show_edit_previous_hint();
                return None;
            }
        }

        let ctrl_c_quit = key_hint::ctrl(KeyCode::Char('c'));
        let is_interrupt_key = is_ctrl_c_key(&key);
        if is_interrupt_key && self.active_overlay.is_none() && self.copy_transcript_selection() {
            return None;
        }
        if is_interrupt_key {
            match self.active_overlay {
                Some(OverlayKind::Copy) => {
                    self.handle_copy_key(key);
                    return None;
                }
                Some(OverlayKind::Outline) => {
                    self.close_outline();
                    return None;
                }
                Some(OverlayKind::Permission) => {
                    return self
                        .handle_permission_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
                }
                Some(OverlayKind::PermissionEditor) => {
                    return self.handle_permission_editor_key(KeyEvent::new(
                        KeyCode::Esc,
                        KeyModifiers::NONE,
                    ));
                }
                Some(OverlayKind::Question) => {
                    return self
                        .handle_question_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
                }
                Some(OverlayKind::GoalReplacement) => {
                    return self.handle_goal_replacement_key(KeyEvent::new(
                        KeyCode::Esc,
                        KeyModifiers::NONE,
                    ));
                }
                Some(OverlayKind::HistorySearch) => {
                    self.handle_history_key(key);
                    return None;
                }
                Some(OverlayKind::ResumeSession) => {
                    return self.handle_resume_session_picker_key(key);
                }
                Some(OverlayKind::ContextInspector) => {
                    self.handle_context_inspector_key(key);
                    return None;
                }
                Some(OverlayKind::SettingsInspector) => {
                    self.handle_settings_inspector_key(key);
                    return None;
                }
                Some(OverlayKind::Keys) => {
                    self.handle_keys_overlay_key(key);
                    return None;
                }
                Some(OverlayKind::Transcript) => {
                    self.handle_transcript_overlay_key(key);
                    return None;
                }
                Some(OverlayKind::Picker) => return self.handle_picker_key(key),
                Some(OverlayKind::SideQuestion) => {
                    self.handle_side_question_key(key);
                    return None;
                }
                None => {}
            }
        }
        if is_interrupt_key {
            if !self.has_active_overlay() && self.composer_has_draft() {
                self.clear_composer_for_ctrl_c();
                self.clear_quit_shortcut();
                return None;
            }
            if let Some(action) = self.interrupt_current_turn() {
                if !DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED {
                    self.clear_quit_shortcut();
                }
                return Some(action);
            }
        }
        if key.code == KeyCode::Esc
            && key.modifiers.is_empty()
            && !self.has_active_overlay()
            && self.slash_menu.is_none()
            && self.leave_agent_view()
        {
            self.set_transient_status("Returned to parent conversation");
            return None;
        }
        let is_escape_interrupt =
            key.code == KeyCode::Esc && !self.has_active_overlay() && self.slash_menu.is_none();
        if is_escape_interrupt && let Some(action) = self.interrupt_current_turn() {
            return Some(action);
        }

        let is_quit_shortcut_key = ctrl_c_quit.is_press(key);
        let is_edit_previous_key = key.code == KeyCode::Esc && key.modifiers.is_empty();
        if is_edit_previous_key && self.active_quit_shortcut_key().is_some() {
            self.clear_quit_shortcut();
            self.show_edit_previous_hint();
            return None;
        }
        if !is_quit_shortcut_key {
            self.clear_quit_shortcut();
        }
        if !is_edit_previous_key && !shortcut_overlay_key {
            self.clear_edit_previous_prompt();
        }

        // Permission dialog takes precedence over all other input.
        if self.pending_permission.is_some() {
            return self.handle_permission_key(key);
        }

        // Permission input editor overlay.
        if self.permission_editor.is_some() {
            return self.handle_permission_editor_key(key);
        }

        // User question dialog overlay.
        if self.pending_question.is_some() {
            return self.handle_question_key(key);
        }

        // Local `/goal` replacement confirmation dialog.
        if self.pending_goal_replacement.is_some() {
            return self.handle_goal_replacement_key(key);
        }

        if self.handle_outline_key(key) {
            return None;
        }

        // Full transcript overlay takes precedence over normal input.
        if self.transcript_overlay.is_some() {
            self.handle_transcript_overlay_key(key);
            return None;
        }

        if self.side_question_overlay.is_some() {
            self.handle_side_question_key(key);
            return None;
        }

        // History search overlay takes precedence over normal input.
        if self.history_search.is_some() {
            self.handle_history_key(key);
            return None;
        }

        // Previous-session picker lives in the committed transcript area.
        if self.resume_session_picker.is_some() {
            return self.handle_resume_session_picker_key(key);
        }

        if let Some(menu) = self.mention_menu.as_mut() {
            match key.code {
                KeyCode::Up => {
                    menu.selected = menu.selected.saturating_sub(1);
                    return None;
                }
                KeyCode::Down => {
                    menu.selected = (menu.selected + 1).min(menu.candidates.len() - 1);
                    return None;
                }
                KeyCode::Tab | KeyCode::Enter => {
                    self.accept_mention_selection();
                    return None;
                }
                KeyCode::Esc => {
                    self.mention_menu = None;
                    return None;
                }
                _ => {}
            }
        }

        // Slash command menu takes precedence for navigation/acceptance keys.
        if self.slash_menu.is_some() && key.code == KeyCode::Enter && key.modifiers.is_empty() {
            if !self.slash_menu_can_accept_selection() {
                self.close_slash_menu();
            } else {
                let selected = self
                    .slash_menu
                    .as_ref()
                    .map(|menu| menu.selected)
                    .unwrap_or(0);
                return self.submit_slash_menu_selection(selected);
            }
        }
        if self.slash_menu.is_some() && key.code == KeyCode::Tab {
            if !self.slash_menu_can_accept_selection() {
                self.close_slash_menu();
            } else {
                let selected = self
                    .slash_menu
                    .as_ref()
                    .map(|menu| menu.selected)
                    .unwrap_or(0);
                self.accept_slash_menu_selection(selected);
                return None;
            }
        }
        if self.slash_menu.is_some() && self.handle_slash_menu_key(key) {
            return None;
        }

        // Context inspector overlay.
        if self.context_inspector.is_some() {
            self.handle_context_inspector_key(key);
            return None;
        }

        // Settings inspector overlay.
        if self.settings_inspector.is_some() {
            self.handle_settings_inspector_key(key);
            return None;
        }

        // Keyboard shortcuts overlay.
        if self.keys_overlay.is_some() {
            self.handle_keys_overlay_key(key);
            return None;
        }

        // Generic picker overlay.
        if self.picker_overlay.is_some() {
            return self.handle_picker_key(key);
        }

        if self.handle_remote_image_selection_key(key) {
            return None;
        }
        self.clear_remote_image_selection();

        if is_clipboard_image_paste_key(&key) {
            return Some(UserAction::PasteClipboardImage);
        }

        if shortcut_overlay_key && self.composer_is_empty_for_shortcuts() {
            self.toggle_footer_shortcuts_overlay();
            return None;
        }
        self.close_footer_shortcuts_overlay();

        if self.enter_slash_menu_if_requested(key) {
            return None;
        }
        if self.enter_shell_prompt_mode_if_requested(key) {
            return None;
        }

        let edit_queued_message_key = !altgr
            && ((key.code == KeyCode::Up && key.modifiers == KeyModifiers::ALT)
                || (key.code == KeyCode::Left && key.modifiers == KeyModifiers::SHIFT));
        if edit_queued_message_key && self.restore_latest_queued_message_for_edit() {
            return None;
        }

        if is_tool_transcript_toggle_shortcut(&key) {
            self.toggle_tool_transcript_expanded();
            return None;
        }

        if is_transcript_overlay_shortcut(&key) {
            self.open_transcript_overlay();
            return None;
        }

        if !altgr && key.modifiers.contains(KeyModifiers::ALT) {
            match key.code {
                KeyCode::Char(',') => {
                    return Some(UserAction::AdjustReasoning(
                        ReasoningShortcutDirection::Lower,
                    ));
                }
                KeyCode::Char('.') => {
                    return Some(UserAction::AdjustReasoning(
                        ReasoningShortcutDirection::Raise,
                    ));
                }
                _ => {}
            }
        }

        match key.code {
            _ if is_interrupt_key => {
                return if DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED {
                    self.handle_quit_shortcut(ctrl_c_quit)
                } else {
                    self.clear_quit_shortcut();
                    Some(UserAction::Quit)
                };
            }
            KeyCode::Char('d') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.input.is_empty() {
                    return Some(UserAction::Quit);
                }
                let graphemes = self.input_graphemes();
                let idx = self.cursor_grapheme_index.min(graphemes.len());
                if idx < graphemes.len() {
                    self.reset_input_history_navigation();
                    let start = self.byte_index_for_grapheme(idx);
                    let end = self.byte_index_for_grapheme(idx + 1);
                    self.input.replace_range(start..end, "");
                    self.sync_composer_sidecars();
                }
                return None;
            }
            KeyCode::Char('q') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                return Some(UserAction::Quit);
            }
            KeyCode::Char('r') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.open_history_search();
                return None;
            }
            KeyCode::Char('g') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                return Some(UserAction::OpenExternalEditor);
            }
            KeyCode::Char('l') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.has_interruptible_turn() {
                    self.push_message(
                        MessageRole::System,
                        "Ctrl+L is disabled while a task is in progress.",
                    );
                    return None;
                }
                return Some(UserAction::ClearUi);
            }
            KeyCode::Char('o') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                return Some(UserAction::CopyLastResponse);
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'r') =>
            {
                return Some(UserAction::ToggleRawOutput);
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'b') =>
            {
                self.cursor_grapheme_index = self.beginning_of_previous_word();
                self.clamp_input_scroll(self.last_input_width);
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'f') =>
            {
                self.cursor_grapheme_index = self.end_of_next_word();
                self.clamp_input_scroll(self.last_input_width);
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'d') =>
            {
                let start = self.cursor_grapheme_index;
                let end = self.end_of_next_word();
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.modifiers.contains(KeyModifiers::ALT)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'h') =>
            {
                let start = self.beginning_of_previous_word();
                let end = self.cursor_grapheme_index;
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && !altgr
                    && c.eq_ignore_ascii_case(&'w') =>
            {
                let start = self.beginning_of_previous_word();
                let end = self.cursor_grapheme_index;
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.move_cursor_to_beginning_of_current_line(true);
                return None;
            }
            KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.move_cursor_to_end_of_current_line(true);
                return None;
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.kill_to_beginning_of_current_line();
                return None;
            }
            KeyCode::Char('k') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.kill_to_end_of_current_line();
                return None;
            }
            KeyCode::Char('y') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                self.yank_composer_kill_buffer();
                return None;
            }
            KeyCode::Char('h') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.cursor_grapheme_index > 0 {
                    self.reset_input_history_navigation();
                    let start = self.byte_index_for_grapheme(self.cursor_grapheme_index - 1);
                    let end = self.byte_index_for_grapheme(self.cursor_grapheme_index);
                    self.input.replace_range(start..end, "");
                    self.cursor_grapheme_index -= 1;
                    self.sync_composer_sidecars();
                    self.clamp_input_scroll(self.last_input_width);
                }
                return None;
            }
            KeyCode::Char('b') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.cursor_grapheme_index > 0 {
                    self.cursor_grapheme_index -= 1;
                    self.clamp_input_scroll(self.last_input_width);
                }
                return None;
            }
            KeyCode::Char('f') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                let graphemes = self.input_graphemes();
                if self.cursor_grapheme_index < graphemes.len() {
                    self.cursor_grapheme_index += 1;
                    self.clamp_input_scroll(self.last_input_width);
                }
                return None;
            }
            KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.input_history_index.is_some() {
                    self.recall_previous_input();
                } else if self.can_move_cursor_vertical(self.last_input_width, -1) {
                    self.move_cursor_vertical(self.last_input_width, -1);
                } else if self.recall_previous_input() {
                    // History recall consumed the key.
                } else {
                    self.scroll_transcript_lines(-TRANSCRIPT_SCROLL_LINES);
                }
                return None;
            }
            KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) && !altgr => {
                if self.input_history_index.is_some() {
                    self.recall_next_input();
                } else if self.can_move_cursor_vertical(self.last_input_width, 1) {
                    self.move_cursor_vertical(self.last_input_width, 1);
                } else if self.recall_next_input() {
                    // History recall consumed the key.
                } else {
                    self.scroll_transcript_lines(TRANSCRIPT_SCROLL_LINES);
                }
                return None;
            }
            KeyCode::Char(c)
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && !altgr
                    && (c.eq_ignore_ascii_case(&'j') || c.eq_ignore_ascii_case(&'m')) =>
            {
                self.insert_newline_at_cursor();
                return None;
            }
            KeyCode::Backspace
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    || key.modifiers.contains(KeyModifiers::ALT) =>
            {
                let start = self.beginning_of_previous_word();
                let end = self.cursor_grapheme_index;
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Delete
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    || key.modifiers.contains(KeyModifiers::ALT) =>
            {
                let start = self.cursor_grapheme_index;
                let end = self.end_of_next_word();
                self.kill_input_range(start, end);
                return None;
            }
            KeyCode::Left
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    || key.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.cursor_grapheme_index = self.beginning_of_previous_word();
                self.clamp_input_scroll(self.last_input_width);
                return None;
            }
            KeyCode::Right
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    || key.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.cursor_grapheme_index = self.end_of_next_word();
                self.clamp_input_scroll(self.last_input_width);
                return None;
            }
            KeyCode::Up if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.recall_previous_input();
                return None;
            }
            KeyCode::Down if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.recall_next_input();
                return None;
            }
            KeyCode::Esc => {
                if matches!(shell_prompt_display_text(&self.input), Some("")) {
                    self.reset_input_history_navigation();
                    self.input.clear();
                    self.cursor_grapheme_index = 0;
                    self.input_scroll_row = 0;
                    self.force_next_viewport_redraw();
                    return None;
                }
                return self.handle_edit_previous_escape();
            }
            KeyCode::Enter | KeyCode::Char('\n' | '\r') => {
                if key.modifiers.contains(KeyModifiers::SHIFT)
                    || key.modifiers.contains(KeyModifiers::ALT)
                {
                    self.insert_newline_at_cursor();
                    return None;
                }
                if let Some(action) = self.submit_composer_input() {
                    return Some(action);
                }
            }
            KeyCode::BackTab => {
                let command = if self.plan_mode.is_some() {
                    "/unplan"
                } else {
                    "/plan"
                };
                return Some(UserAction::SlashCommand(command.to_string()));
            }
            KeyCode::Tab => {
                if shell_command_from_prompt(&self.input).is_some()
                    && !self.has_interruptible_turn()
                {
                    return None;
                }
                if let Some(action) = self.submit_composer_input() {
                    return Some(action);
                }
            }
            KeyCode::Char(c)
                if (!key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT)
                    || altgr)
                    && !c.is_ascii_control() =>
            {
                let mut text = String::new();
                text.push(c);
                self.insert_text_at_cursor(&text);
                self.sync_composer_sidecars();
            }
            KeyCode::Backspace if self.cursor_grapheme_index > 0 => {
                self.reset_input_history_navigation();
                let start = self.byte_index_for_grapheme(self.cursor_grapheme_index - 1);
                let end = self.byte_index_for_grapheme(self.cursor_grapheme_index);
                self.input.replace_range(start..end, "");
                self.cursor_grapheme_index -= 1;
                self.sync_composer_sidecars();
                self.clamp_input_scroll(self.last_input_width);
            }
            KeyCode::Delete => {
                let graphemes = self.input_graphemes();
                let idx = self.cursor_grapheme_index.min(graphemes.len());
                if idx < graphemes.len() {
                    self.reset_input_history_navigation();
                    let start = self.byte_index_for_grapheme(idx);
                    let end = self.byte_index_for_grapheme(idx + 1);
                    self.input.replace_range(start..end, "");
                    self.sync_composer_sidecars();
                }
            }
            KeyCode::Left if self.cursor_grapheme_index > 0 => {
                self.cursor_grapheme_index -= 1;
                self.clamp_input_scroll(self.last_input_width);
            }
            KeyCode::Right => {
                let graphemes = self.input_graphemes();
                if self.cursor_grapheme_index < graphemes.len() {
                    self.cursor_grapheme_index += 1;
                    self.clamp_input_scroll(self.last_input_width);
                }
            }
            KeyCode::Up => {
                if self.input_history_index.is_some() {
                    self.recall_previous_input();
                } else if self.can_move_cursor_vertical(self.last_input_width, -1) {
                    self.move_cursor_vertical(self.last_input_width, -1);
                } else if self.recall_previous_input() {
                    // History recall consumed the key.
                } else {
                    self.scroll_transcript_lines(-TRANSCRIPT_SCROLL_LINES);
                }
            }
            KeyCode::Down => {
                if self.input_history_index.is_some() {
                    self.recall_next_input();
                } else if self.can_move_cursor_vertical(self.last_input_width, 1) {
                    self.move_cursor_vertical(self.last_input_width, 1);
                } else if self.recall_next_input() {
                    // History recall consumed the key.
                } else {
                    self.scroll_transcript_lines(TRANSCRIPT_SCROLL_LINES);
                }
            }
            KeyCode::Home => {
                self.move_cursor_to_beginning_of_current_line(false);
            }
            KeyCode::End => {
                if self.composer_is_empty_for_shortcuts() && !self.transcript_viewport.is_at_tail()
                {
                    self.snap_to_bottom();
                    self.force_next_viewport_redraw();
                } else {
                    self.move_cursor_to_end_of_current_line(false);
                }
            }
            KeyCode::PageUp => {
                let page = self.transcript_viewport.viewport_rows().max(1) as i32;
                self.scroll_transcript_lines(-page);
            }
            KeyCode::PageDown => {
                let page = self.transcript_viewport.viewport_rows().max(1) as i32;
                self.transcript_viewport.scroll_lines(page);
            }
            _ => {}
        }
        None
    }

    fn render_full_transcript_overlay_lines(&mut self, width: u16) -> Vec<Line<'static>> {
        let width = width.max(1);
        let active_messages = self.active_turn_display_messages_for_render();
        let mut lines = if active_messages.is_empty() {
            self.render_transcript_range_limited(0, self.messages.len(), width, None)
        } else {
            let mut combined_messages = self.messages.iter().cloned().collect::<Vec<_>>();
            let active_from = combined_messages.len();
            combined_messages.extend(active_messages);
            self.render_display_messages_limited_with_mode(
                &combined_messages,
                width,
                None,
                LineLimitMode::Head,
                Some(active_from),
            )
        };
        if lines.is_empty() {
            lines.push(Line::from(Span::styled(
                "No transcript yet.",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            )));
        }
        lines
    }

    fn draw_transcript_overlay(&mut self, frame: &mut Frame) {
        if self.navigation.inline && self.navigation.anchor.is_some() {
            self.draw_navigation_overlay(frame);
            return;
        }
        use ratatui::widgets::{Clear, Widget};

        let area = frame.area();
        if area.width == 0 || area.height == 0 {
            return;
        }

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(KCODER_UI_THEME.accent_primary))
            .title(Span::styled(
                " T R A N S C R I P T ",
                Style::default()
                    .fg(KCODER_UI_THEME.accent_primary)
                    .add_modifier(Modifier::BOLD),
            ))
            .title_bottom(Span::styled(
                " Esc/q close · ↑/↓ scroll · PgUp/PgDn page ",
                Style::default().fg(KCODER_UI_THEME.text_muted),
            ));
        let inner = block.inner(area);
        let inner_width = inner.width.max(1);
        let inner_height = inner.height;
        let lines = self.render_full_transcript_overlay_lines(inner_width);
        let total_rows = paragraph_line_count(&lines, inner_width);
        let top = if let Some(overlay) = self.transcript_overlay.as_mut() {
            overlay.last_line_count = total_rows;
            overlay.last_height = inner_height;
            let top = overlay.resolved_top();
            if overlay.scroll_top != usize::MAX {
                overlay.scroll_top = top;
            }
            top
        } else {
            0
        };

        Clear.render(area, frame.buffer_mut());
        frame.render_widget(block, area);
        let paragraph = Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .scroll((top as u16, 0))
            .style(Style::default().bg(KCODER_UI_THEME.panel_bg));
        frame.render_widget(paragraph, inner);
    }

    pub fn draw(&mut self, frame: &mut Frame) {
        self.refresh_outline();
        let Some(mut agent_transcript) = self
            .agent_view
            .as_mut()
            .map(|view| std::mem::take(&mut view.transcript))
        else {
            self.draw_current_surface(frame);
            return;
        };
        std::mem::swap(&mut self.messages, &mut agent_transcript);
        self.draw_current_surface(frame);
        std::mem::swap(&mut self.messages, &mut agent_transcript);
        if let Some(view) = self.agent_view.as_mut() {
            view.transcript = agent_transcript;
        }
    }

    fn draw_current_surface(&mut self, frame: &mut Frame) {
        let area = frame.area();
        self.last_frame_area = Some(area);
        if self.copy_view.is_some() {
            self.navigation_footer.clear();
            self.draw_copy_view(frame);
            return;
        }
        // The inline history layer owns a complete independent surface; the underlying live surface must not submit fewer rows and clamp its anchor.
        if self.navigation.inline && self.navigation.anchor.is_some() && !self.has_active_modal() {
            self.navigation_footer.clear();
            self.draw_navigation_overlay(frame);
            self.draw_outline(frame);
            return;
        }
        let parked_navigation_viewport = (self.navigation.inline
            && self.navigation.anchor.is_some())
        .then(|| std::mem::take(&mut self.transcript_viewport));
        frame.render_widget(
            Block::default().style(Style::default().bg(KCODER_UI_THEME.surface_bg)),
            area,
        );

        let (mut status_height, mut pending_input_height) =
            self.bottom_pane_stack_heights(area.width);
        let fullscreen_status_in_footer =
            self.fullscreen_surface && self.resume_session_picker.is_none();
        if fullscreen_status_in_footer {
            status_height = 0;
            pending_input_height = self.pending_input_preview_height(area.width, 0);
        }
        let tiny_subagent_status = self.tiny_terminal_subagent_status(area.width, area.height);
        if tiny_subagent_status.is_some() {
            status_height = status_height.max(1);
        }
        let footer_height = self.footer_height();
        let desired_todo_height = todo_status_height(&self.todos);
        let composer_height = composer_height_for_width_with_limit(
            self,
            area.width,
            Some(composer_height_limit_for_terminal(
                area.height,
                status_height,
                pending_input_height,
                footer_height,
                desired_todo_height,
            )),
        );
        let fixed_height = composer_height
            .saturating_add(status_height)
            .saturating_add(pending_input_height)
            .saturating_add(desired_todo_height)
            .saturating_add(footer_height)
            .saturating_add(BOTTOM_PANE_TOP_SPACER);
        let transcript_row_budget = area.height.saturating_sub(fixed_height) as usize;
        let message_height = if self.fullscreen_surface {
            area.height
        } else {
            self.transcript_desired_rows(area.width, transcript_row_budget)
        };
        let bottom_overlay_height = self.bottom_overlay_reserved_rows();
        let layout = split_repl_layout(
            area,
            ReplLayoutHeights {
                message: message_height,
                bottom_overlay: bottom_overlay_height,
                composer: composer_height,
                status: status_height,
                pending_input: pending_input_height,
                footer: footer_height,
                todo: desired_todo_height,
            },
        );
        let message_area = layout.message;
        let bottom_overlay_area = layout.bottom_overlay;
        let status_area = layout.status;
        let pending_input_area = layout.pending_input;
        let input_area = layout.input;
        let footer_area = layout.footer;
        let tail_area = layout.tail;
        let todo_area = layout.todo;
        let dialog_host_area =
            dialog_host_area_for_todo(area, todo_area.map_or(0, |todo| todo.height));
        self.last_bottom_overlay_area = bottom_overlay_area;

        let reserve_scrollbar_gutter =
            self.fullscreen_surface && self.resume_session_picker.is_none();
        let transcript_area =
            transcript_area_for_message_area(message_area, reserve_scrollbar_gutter);
        let inner_area = transcript_area;
        self.transcript_viewport.begin_frame(inner_area);
        let inner_width = inner_area.width.max(1);

        let row_budget = usize::from(inner_area.height);
        let mut deferred_transcript_scrollbar = None;

        let fullscreen_render = if self.fullscreen_surface && self.resume_session_picker.is_none() {
            Some(self.render_fullscreen_transcript_window(inner_width, row_budget))
        } else {
            None
        };
        let visible_lines = if let Some(picker) = &self.resume_session_picker {
            resume_session_picker_lines(picker, inner_width, row_budget)
        } else if let Some(render) = fullscreen_render.as_ref() {
            render.lines.clone()
        } else {
            self.render_inline_live_transcript_lines(inner_width, row_budget)
        };
        if self.resume_session_picker.is_none() {
            let rendered_line_count = fullscreen_render.as_ref().map_or_else(
                || paragraph_line_count(&visible_lines, inner_area.width.max(1)),
                |render| render.total_rows,
            );
            let visible_top = fullscreen_render.as_ref().map_or(0, |render| render.top);
            self.transcript_viewport
                .commit_render(rendered_line_count, visible_top);
        }
        if inner_area.height > 0 {
            let (visible_lines, render_top) = if self.resume_session_picker.is_some() {
                (visible_lines, 0)
            } else if let Some(render) = fullscreen_render.as_ref() {
                if self.agent_view.is_some()
                    && !self.navigation.displaying
                    && self.transcript_viewport.is_at_tail()
                    && render.total_rows <= usize::from(inner_area.height)
                {
                    // Keep short child output near the composer without counting top padding as transcript rows.
                    bottom_aligned_paragraph(visible_lines, inner_width, inner_area.height)
                } else {
                    (visible_lines, render.local_top)
                }
            } else {
                bottom_aligned_paragraph(visible_lines, inner_width, inner_area.height)
            };
            let (visible_lines, render_top) = if self.fullscreen_surface
                && !self.navigation.displaying
                && self.resume_session_picker.is_none()
                && !visible_lines.is_empty()
            {
                scroll_render_window_lines(
                    visible_lines,
                    inner_width,
                    render_top,
                    usize::from(inner_area.height.max(1)),
                    usize::from(inner_area.height.max(1)),
                )
            } else {
                (visible_lines, render_top)
            };
            self.last_transcript_visible_rows = if self.navigation.displaying {
                transcript_selection::navigation_visible_rows_for_selection(
                    &visible_lines,
                    inner_width,
                    inner_area.height,
                    render_top,
                )
            } else {
                transcript_visible_rows_for_selection(
                    &visible_lines,
                    inner_width,
                    inner_area.height,
                    render_top,
                )
            };
            frame.render_widget(ratatui::widgets::Clear, inner_area);
            // Navigation output already contains visual rows; replay its cells directly without wrapping or truncating again.
            if self.navigation.displaying {
                frame.render_widget(
                    navigation_render::NavigationLines {
                        lines: &visible_lines,
                        local_top: render_top,
                    },
                    inner_area,
                );
            } else {
                frame.render_widget(
                    Paragraph::new(Text::from(visible_lines))
                        .wrap(Wrap { trim: false })
                        .scroll((render_top as u16, 0))
                        .style(Style::default().bg(KCODER_UI_THEME.surface_bg)),
                    inner_area,
                );
            }
            render_transcript_selection_highlight(
                frame,
                inner_area,
                &self.last_transcript_visible_rows,
                self.transcript_selection.filter(|_| {
                    self.transcript_selection_rows
                        .as_ref()
                        .is_none_or(|rows| rows == &self.last_transcript_visible_rows)
                }),
            );
            if let Some(gutter_area) = transcript_gutter_area(message_area, inner_area) {
                frame.render_widget(
                    Paragraph::new("").style(Style::default().bg(KCODER_UI_THEME.surface_bg)),
                    gutter_area,
                );
            }
            if let Some(render) = fullscreen_render.as_ref() {
                // Select one scrollbar geometry source of truth based on drag state:
                // - Not dragging: use (total_rows, top) actually drawn this frame. Rendering
                //   locates by estimated rows and commits actual rows; resolving coordinates
                //   again would offset the thumb from visible content on estimation-error frames.
                // - Dragging: use the frozen coordinate system. Estimated total_rows varies
                //   between frames and would make thumb height jitter under the pointer. The
                //   frozen basis is stable while proportional remapping aligns content and thumb.
                let viewport_rows = usize::from(inner_area.height.max(1));
                let (scrollbar_content_rows, scrollbar_top_for_render) =
                    if self.transcript_viewport.drag_active() {
                        let frozen_rows = self.transcript_viewport.content_rows();
                        (
                            frozen_rows,
                            self.transcript_viewport
                                .resolve_top(frozen_rows, viewport_rows),
                        )
                    } else {
                        (render.total_rows, render.top)
                    };
                self.transcript_viewport.update_painted_drag_edges(
                    scrollbar_content_rows,
                    scrollbar_top_for_render,
                    message_area.height,
                );
                self.transcript_viewport
                    .set_scrollbar_area(transcript_scrollbar_area(
                        message_area,
                        scrollbar_content_rows,
                        viewport_rows,
                    ));
                deferred_transcript_scrollbar = Some((
                    message_area,
                    scrollbar_content_rows,
                    viewport_rows,
                    scrollbar_top_for_render,
                ));
            }
        } else {
            self.last_transcript_visible_rows.clear();
            self.clear_transcript_selection();
        }
        if self.transcript_viewport.scrollbar_area().is_none() {
            self.transcript_viewport.set_scrollbar_area(None);
        }
        if let Some(todo_area) = todo_area {
            draw_todo_status(frame, &self.todos, todo_area);
        }

        let compact_status = self.compact_status_label();
        let activity = self.activity_presentation();
        let fullscreen_footer_status_detail =
            if fullscreen_status_in_footer && self.status_indicator_visible() {
                activity.detail.clone()
            } else {
                None
            };

        if let Some(status_area) = status_area {
            if let Some(tiny_status) = tiny_subagent_status.as_ref() {
                Paragraph::new(Line::from(Span::styled(
                    tiny_status.clone(),
                    Style::default()
                        .fg(KCODER_UI_THEME.mode_agent)
                        .add_modifier(Modifier::BOLD),
                )))
                .style(Style::default().bg(KCODER_UI_THEME.surface_bg))
                .render(status_area, frame.buffer_mut());
            } else {
                let mut status_data = StatusIndicatorData::new(
                    &activity.label,
                    activity.detail.as_deref(),
                    &compact_status,
                    self.status_elapsed(),
                    StatusIndicatorControls {
                        show_interrupt_hint: self.has_interruptible_turn(),
                        interrupt_hint: "esc",
                        is_running: self.spinner.is_running(),
                    },
                    &KCODER_UI_THEME,
                )
                .with_activity_indicator(activity.indicator, activity.snapshot.needs_attention);
                status_data.started_at = self.turn_started_at;
                status_data.details_capitalization = StatusDetailsCapitalization::Preserve;
                StatusIndicatorWidget::new(status_data).render(status_area, frame.buffer_mut());
            }
        }

        if let Some(pending_input_area) = pending_input_area {
            let preview_area =
                pending_input_preview_content_area(pending_input_area, status_area.is_some());
            if !preview_area.is_empty() {
                self.pending_input_preview()
                    .render(preview_area, frame.buffer_mut());
            }
        }

        // Input pane (multi-line composer).
        let [_remote_images_area, inner] =
            composer_content_areas(input_area, self.remote_image_urls.len());
        self.last_composer_area = Some(input_area);
        self.last_composer_content = Some(inner);
        self.last_input_width = inner.width;
        let content_width = inner.width.max(1);
        let rows = self.wrap_composer_display_rows(content_width);
        let total_rows = rows.len();
        let visible_row_count = usize::from(inner.height.max(MIN_COMPOSER_ROWS));
        self.input_scroll_row = self
            .input_scroll_row
            .min(total_rows.saturating_sub(visible_row_count));

        let image_placeholders = self
            .local_image_attachments
            .iter()
            .map(|image| image.placeholder.as_str())
            .collect::<Vec<_>>();
        let paste_placeholders = self
            .pending_pastes
            .iter()
            .map(|(placeholder, _)| placeholder.as_str())
            .collect::<Vec<_>>();
        let shell_prompt = !self.shutdown_in_progress
            && self.agent_view.is_none()
            && shell_prompt_display_text(&self.input).is_some();
        let agent_composer_placeholder = self.agent_view.as_ref().map(|view| {
            let status = view
                .steer_status
                .as_deref()
                .map(|status| format!(" · {status}"))
                .unwrap_or_default();
            format!(
                "Message {}{status} · Esc returns to parent",
                view.display_name
            )
        });
        let composer_placeholder = if self.shutdown_in_progress {
            "Shutting down..."
        } else if shell_prompt {
            ""
        } else {
            agent_composer_placeholder
                .as_deref()
                .unwrap_or("Ask KCoder to do anything")
        };
        let composer_text = if self.shutdown_in_progress {
            ""
        } else {
            self.composer_display_text()
        };
        let composer_data = widgets::ComposerData::new(
            composer_text,
            composer_placeholder,
            true,
            false,
            "",
            &KCODER_UI_THEME,
            self.input_scroll_row,
        )
        .with_shell_prompt(shell_prompt)
        .with_image_placeholders(image_placeholders)
        .with_paste_placeholders(paste_placeholders)
        .with_remote_images(
            self.remote_image_urls.len(),
            self.selected_remote_image_index,
        );
        if self.picker_overlay.is_some() {
            // Clear the composer band when a centered picker takes focus so compact
            // windows do not retain an old placeholder that suggests two active inputs.
            widgets::clear_area(input_area, frame.buffer_mut(), KCODER_UI_THEME.surface_bg);
        } else {
            ComposerWidget::new(composer_data).render(input_area, frame.buffer_mut());
        }

        // Keep session metadata below the live conversation instead of pinning
        // a top bar.
        let has_draft = self.composer_has_draft();
        let transient_status_label = self.transient_status_label();
        let show_transient_in_footer =
            !transient_status_label.is_empty() && !self.status_indicator_visible();
        let footer_hint = if self.shutdown_in_progress {
            FooterHint::None
        } else if DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED
            && let Some(key) = self.active_quit_shortcut_key()
        {
            FooterHint::QuitReminder(key)
        } else if let Some(search) = &self.history_search {
            FooterHint::HistorySearch {
                query: &search.query,
                has_match: search.status == HistorySearchStatus::Match,
            }
        } else if self.edit_previous_primed {
            FooterHint::EditPreviousPrimed
        } else if self.edit_previous_hint_visible {
            FooterHint::EditPrevious
        } else if show_transient_in_footer {
            FooterHint::TransientStatus {
                text: &transient_status_label,
            }
        } else if fullscreen_status_in_footer && self.has_interruptible_turn() {
            FooterHint::Interrupt
        } else if fullscreen_status_in_footer && self.spinner.is_running() {
            FooterHint::Activity
        } else if self.spinner.is_running() && has_draft {
            FooterHint::QueueMessage
        } else if shell_prompt_display_text(&self.input).is_some() {
            FooterHint::ShellMode
        } else if has_draft {
            FooterHint::None
        } else {
            FooterHint::Shortcuts
        };
        let footer_compact_status = if show_transient_in_footer {
            self.compact_status_label_without_transient()
        } else {
            compact_status.clone()
        };
        let footer_compact_status = fullscreen_footer_status(
            fullscreen_footer_status_detail.as_deref(),
            &footer_compact_status,
        );
        let model_footer_label =
            model_footer_label(&self.model_name, self.reasoning_effort.as_ref());
        let mode_switch_enabled = self.plan_mode.is_some();
        let mode_label = match (self.session_mode.is_orchestrate(), mode_switch_enabled) {
            (true, true) => self
                .orchestrate_progress_label
                .as_deref()
                .map(|progress| format!("Orchestrate · Plan mode · {progress}"))
                .unwrap_or_else(|| "Orchestrate · Plan mode".to_string()),
            (true, false) => self
                .orchestrate_progress_label
                .as_deref()
                .map(|progress| format!("Orchestrate · {progress}"))
                .unwrap_or_else(|| "Orchestrate".to_string()),
            (false, true) => "Plan mode".to_string(),
            (false, false) => String::new(),
        };
        let footer_activity_visible = self.spinner.is_running() && fullscreen_status_in_footer;
        let footer_activity_label = if footer_activity_visible {
            activity.label.as_str()
        } else {
            ""
        };
        let footer_data = FooterData::new(
            footer_hint,
            &self.display_cwd,
            self.session_title.as_deref().unwrap_or(""),
            &model_footer_label,
            &self.provider_name,
            &footer_compact_status,
            footer_activity_visible,
            self.token_count,
            self.token_total,
            &KCODER_UI_THEME,
        )
        .with_mode_label(&mode_label)
        .with_mode_switch_enabled(mode_switch_enabled)
        .with_esc_backtrack_hint(self.edit_previous_primed)
        .with_activity_elapsed(self.status_elapsed())
        .with_activity_status(
            activity.indicator,
            footer_activity_label,
            activity.snapshot.needs_attention,
        );
        let navigation_width = if !self.messages.is_empty() && footer_area.width >= 80 {
            32
        } else {
            0
        };
        let main_footer = Rect {
            width: footer_area.width.saturating_sub(navigation_width),
            ..footer_area
        };
        FooterWidget::new(footer_data).render(main_footer, frame.buffer_mut());
        self.draw_navigation_footer(
            frame,
            Rect {
                x: main_footer.right(),
                width: navigation_width,
                ..footer_area
            },
        );

        if !self.fullscreen_surface
            && self.startup_idle_surface_active()
            && tail_area.height >= 3
            && tail_area.width > 0
        {
            let mut divider_offsets = if tail_area.height >= 8 {
                vec![tail_area.height / 3, tail_area.height.saturating_mul(2) / 3]
            } else {
                vec![tail_area.height / 2]
            };
            divider_offsets.sort_unstable();
            divider_offsets.dedup();
            let divider = "─".repeat(usize::from(tail_area.width));
            for offset in divider_offsets {
                let divider_y = tail_area.y.saturating_add(offset);
                if divider_y >= tail_area.bottom() {
                    continue;
                }
                let divider_area = Rect::new(tail_area.x, divider_y, tail_area.width, 1);
                let divider_widget = Paragraph::new(Line::from(Span::styled(
                    divider.clone(),
                    Style::default().fg(KCODER_UI_THEME.text_dim),
                )))
                .style(Style::default().bg(KCODER_UI_THEME.surface_bg));
                frame.render_widget(divider_widget, divider_area);
            }
        }

        if self.footer_shortcuts_overlay
            && !self.shutdown_in_progress
            && let Some(overlay_area) = bottom_overlay_area
        {
            draw_footer_shortcuts_overlay(frame, self, overlay_area);
        }

        // Paint the transcript rail after bottom panes. Those widgets can
        // touch right-edge cells while wrapping wide text; drawing the rail
        // last keeps its reserved message-area column from inheriting a stale
        // continuation marker or being visually overwritten.
        if let Some((area, content_rows, viewport_rows, top)) = deferred_transcript_scrollbar {
            render_transcript_scrollbar(frame, area, content_rows, viewport_rows, top);
        }

        if !self.centered_overlay_active() {
            if let Some((cursor_x, cursor_y)) = self.history_search_footer_cursor(footer_area) {
                frame.set_cursor_position((cursor_x, cursor_y));
            } else if self.selected_remote_image_index.is_none() {
                // Place cursor inside input box using visual row/column.
                let (cursor_row, cursor_col) =
                    self.composer_display_cursor_visual_position(content_width);
                let visible_cursor_row = cursor_row.saturating_sub(self.input_scroll_row) as u16;
                let cursor_x = inner.x + (cursor_col as u16).min(inner.width.saturating_sub(1));
                let cursor_y = inner.y + visible_cursor_row.min(inner.height.saturating_sub(1));
                frame.set_cursor_position((cursor_x, cursor_y));
            }
        }

        // Slash command picker overlay.
        self.sync_slash_menu();
        if self.slash_menu.is_some()
            && !self.shutdown_in_progress
            && let Some(overlay_area) = bottom_overlay_area
        {
            draw_slash_menu(frame, self, overlay_area);
        }
        if self.mention_menu.is_some()
            && !self.shutdown_in_progress
            && let Some(overlay_area) = bottom_overlay_area
        {
            draw_mention_menu(frame, self, overlay_area);
        }

        // Permission dialog overlay
        if let Some(dialog) = &self.pending_permission {
            draw_permission_dialog(frame, dialog_host_area, dialog, &self.code_theme);
        }

        // User question dialog overlay
        if let Some(dialog) = &self.pending_question {
            draw_question_dialog(frame, dialog_host_area, dialog);
        }

        // Local goal replacement confirmation overlay
        if let Some(dialog) = &self.pending_goal_replacement {
            draw_goal_replacement_dialog(frame, dialog_host_area, dialog);
        }

        if let Some(overlay) = &self.side_question_overlay {
            draw_side_question_overlay(frame, dialog_host_area, overlay, &self.code_theme);
        }

        // Permission input editor overlay
        if let Some(editor) = &self.permission_editor {
            draw_permission_editor(frame, dialog_host_area, editor);
        }

        // Context inspector overlay
        if let Some(inspector) = &self.context_inspector {
            draw_context_inspector(frame, inspector);
        }

        // Settings inspector overlay
        if let Some(inspector) = &self.settings_inspector {
            draw_settings_inspector(frame, inspector);
        }

        // Keyboard shortcuts overlay
        if self.keys_overlay.is_some() {
            draw_keys_overlay(frame, self.plan_mode.is_some());
        }

        // Generic picker overlay
        if let Some(picker) = &self.picker_overlay {
            draw_picker_overlay(frame, picker);
        }

        // Full transcript overlay.
        if self.transcript_overlay.is_some() {
            self.draw_transcript_overlay(frame);
        }
        self.draw_outline(frame);
        if let Some(viewport) = parked_navigation_viewport {
            self.transcript_viewport = viewport;
        }
    }
}

fn goal_status_label(goal: &Goal) -> String {
    let name = goal_display_name(goal);
    let resume = format!("{} resume", goal_command_for_goal(goal));
    match goal.status {
        GoalStatus::Active => format!(
            "{name} running turn {} · Esc pauses · {}",
            goal.turn_count.max(1),
            active_goal_usage(goal)
        ),
        GoalStatus::Paused => format!("{name} paused ({resume})"),
        GoalStatus::Blocked => format!("{name} blocked ({resume})"),
        GoalStatus::UsageLimited => format!("{name} hit usage limits ({resume})"),
        GoalStatus::BudgetLimited => match stopped_goal_budget_usage(goal) {
            Some(usage) => format!("{name} unmet ({usage})"),
            None => format!("{name} abandoned"),
        },
        GoalStatus::Complete => format!("{name} complete ({})", completed_goal_usage(goal)),
    }
}

fn goal_display_name(goal: &Goal) -> &'static str {
    if goal.mode.is_arrangement() {
        "UltGoal"
    } else if goal.mode.is_strict() {
        "Goal Pro"
    } else {
        "Goal"
    }
}

fn goal_command_for_goal(goal: &Goal) -> &'static str {
    if goal.mode.is_arrangement() {
        "/ultgoal"
    } else if goal.mode.is_strict() {
        "/goal-pro"
    } else {
        "/goal"
    }
}

fn active_goal_usage(goal: &Goal) -> String {
    if let Some(budget) = goal.token_budget {
        return format!(
            "{} / {}",
            compact_token_count(goal.tokens_used),
            compact_token_count(budget)
        );
    }
    format_goal_elapsed_seconds(goal.time_used_seconds)
}

fn stopped_goal_budget_usage(goal: &Goal) -> Option<String> {
    goal.token_budget.map(|budget| {
        format!(
            "{} / {} tokens",
            compact_token_count(goal.tokens_used),
            compact_token_count(budget)
        )
    })
}

fn completed_goal_usage(goal: &Goal) -> String {
    if goal.token_budget.is_some() {
        return format!("{} tokens", compact_token_count(goal.tokens_used));
    }
    format_goal_elapsed_seconds(goal.time_used_seconds)
}

fn format_goal_elapsed_seconds(seconds: u64) -> String {
    if seconds < 60 {
        return format!("{seconds}s");
    }

    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }

    let hours = minutes / 60;
    let remaining_minutes = minutes % 60;
    if hours >= 24 {
        let days = hours / 24;
        let remaining_hours = hours % 24;
        return format!("{days}d {remaining_hours}h {remaining_minutes}m");
    }

    if remaining_minutes == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h {remaining_minutes}m")
    }
}

fn compact_token_count(value: u64) -> String {
    if value < 1_000 {
        return value.to_string();
    }

    let value_f64 = value as f64;
    let (scaled, suffix) = if value >= 1_000_000_000_000 {
        (value_f64 / 1_000_000_000_000.0, "T")
    } else if value >= 1_000_000_000 {
        (value_f64 / 1_000_000_000.0, "B")
    } else if value >= 1_000_000 {
        (value_f64 / 1_000_000.0, "M")
    } else {
        (value_f64 / 1_000.0, "K")
    };

    let decimals = if scaled < 10.0 {
        2
    } else if scaled < 100.0 {
        1
    } else {
        0
    };

    let mut formatted = format!("{scaled:.decimals$}");
    if formatted.contains('.') {
        while formatted.ends_with('0') {
            formatted.pop();
        }
        if formatted.ends_with('.') {
            formatted.pop();
        }
    }

    format!("{formatted}{suffix}")
}

fn project_file_index(cwd: &Path, limit: usize) -> Vec<String> {
    let output = std::process::Command::new("rg")
        .args(["--files", "--hidden", "-g", "!.git"])
        .current_dir(cwd)
        .output();
    let bytes = output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| output.stdout)
        .or_else(|| {
            std::process::Command::new("git")
                .args(["ls-files", "--cached", "--others", "--exclude-standard"])
                .current_dir(cwd)
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| output.stdout)
        })
        .unwrap_or_default();
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter(|line| {
            let line = line.trim();
            !line.is_empty()
                && !line.starts_with(".git/")
                && !line.starts_with(".kcoder/")
                && !line.starts_with("target/")
                && !line.starts_with("node_modules/")
        })
        .take(limit)
        .map(str::to_string)
        .collect()
}

fn fuzzy_file_candidates(files: &[String], query: &str, limit: usize) -> Vec<String> {
    let query = query.to_ascii_lowercase();
    let mut scored = files
        .iter()
        .filter_map(|path| fuzzy_file_score(path, &query).map(|score| (score, path)))
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| left.len().cmp(&right.len()))
            .then_with(|| left.cmp(right))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(_, path)| path.clone())
        .collect()
}

fn fuzzy_file_score(path: &str, query: &str) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    let candidate = path.to_ascii_lowercase();
    if let Some(index) = candidate.find(query) {
        let basename = candidate.rsplit('/').next().unwrap_or(&candidate);
        let basename_bonus = basename.find(query).map_or(0, |_| 300);
        return Some(1_000 + basename_bonus - index as i64 - candidate.len() as i64);
    }
    let mut score = 0i64;
    let mut query_chars = query.chars();
    let mut wanted = query_chars.next()?;
    let mut previous_match = None;
    for (index, ch) in candidate.chars().enumerate() {
        if ch != wanted {
            continue;
        }
        score += 20;
        if previous_match.is_some_and(|previous| previous + 1 == index) {
            score += 35;
        }
        if index == 0 || candidate.as_bytes().get(index.wrapping_sub(1)) == Some(&b'/') {
            score += 15;
        }
        previous_match = Some(index);
        let Some(next) = query_chars.next() else {
            return Some(score - candidate.len() as i64);
        };
        wanted = next;
    }
    None
}

fn queued_user_message_preview(message: &Message) -> String {
    let raw = match message {
        Message::User { content } | Message::Assistant { content, .. } => {
            content_blocks_text(content)
        }
    };
    let preview = sanitize_tui_text(&raw.split_whitespace().collect::<Vec<_>>().join(" "));
    if preview.is_empty() {
        "[attachment]".to_string()
    } else {
        preview
    }
}

fn editable_user_message_text(message: &Message) -> String {
    match message {
        Message::User { content } => sanitize_tui_text(&content_blocks_text(content)),
        _ => String::new(),
    }
}

fn local_image_placeholder(index: usize) -> String {
    format!("[Image #{index}]")
}

fn expand_pending_pastes(text: &str, pending_pastes: &[(String, String)]) -> String {
    if pending_pastes.is_empty() {
        return text.to_string();
    }

    let mut replacements: Vec<_> = pending_pastes.iter().enumerate().collect();
    replacements.sort_by_key(|(_, (text, _))| std::cmp::Reverse(text.len()));

    let mut expanded = text.to_string();
    let mut staged = Vec::new();
    for (index, (placeholder, actual)) in replacements {
        if !expanded.contains(placeholder) {
            continue;
        }
        let token = format!("\x1fkcoder-paste-expand-{index}\x1f");
        expanded = expanded.replace(placeholder, &token);
        staged.push((token, actual.clone()));
    }

    for (token, actual) in staged {
        expanded = expanded.replace(&token, &actual);
    }
    expanded
}

/// Draw the slash-command picker in the transient bottom overlay band.
#[derive(Debug)]
enum UserAction {
    Quit,
    Suspend,
    Submit(SubmittedMessage),
    RunShellCommand {
        command: String,
        history_text: String,
    },
    SlashCommand(String),
    CompactConversation,
    StartSideQuestion(String),
    StartMoaPlan(String),
    ResumeSession(PathBuf),
    ConfirmGoalReplacement {
        objective: String,
        token_budget: Option<u64>,
        mode: GoalMode,
        verification_kind: GoalVerificationKind,
    },
    ClearUi,
    CopyLastResponse,
    PasteClipboardImage,
    OpenExternalEditor,
    EditPreviousMessage,
    ToggleRawOutput,
    AdjustReasoning(ReasoningShortcutDirection),
    CompleteDeferredTurn,
    Interrupt,
    ShortenToolWait,
    TryStartTurn,
}

fn is_clipboard_image_paste_key(key: &KeyEvent) -> bool {
    if key.kind != KeyEventKind::Press
        || !matches!(key.code, KeyCode::Char(c) if c.eq_ignore_ascii_case(&'v'))
    {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        key.modifiers == KeyModifiers::ALT
    }
    #[cfg(not(target_os = "windows"))]
    {
        (key.modifiers == KeyModifiers::CONTROL
            || key.modifiers == (KeyModifiers::CONTROL | KeyModifiers::ALT))
            && !key_hint::is_altgr(key.modifiers)
    }
}

struct HandledAppEvent {
    action: Option<UserAction>,
    redraw: bool,
    flush_frame: bool,
}

impl HandledAppEvent {
    fn redraw() -> Self {
        Self {
            action: None,
            redraw: true,
            flush_frame: false,
        }
    }

    fn redraw_and_flush() -> Self {
        Self {
            action: None,
            redraw: true,
            flush_frame: true,
        }
    }

    fn quiet() -> Self {
        Self {
            action: None,
            redraw: false,
            flush_frame: false,
        }
    }

    fn action(action: UserAction) -> Self {
        Self {
            action: Some(action),
            redraw: true,
            flush_frame: false,
        }
    }

    fn merge(&mut self, next: Self) {
        self.redraw |= next.redraw;
        self.flush_frame |= next.flush_frame;
        if self.action.is_none() {
            self.action = next.action;
        }
    }
}

fn seed_startup_messages(app: &mut ReplApp, startup_notice: Option<String>) {
    app.render_welcome_component();
    if let Some(notice) = startup_notice {
        app.push_message(MessageRole::System, notice);
    }
    if let Some(message) = debug_startup_a_lines_message_from_env() {
        app.push_message(MessageRole::System, message);
    }
}

fn debug_startup_a_lines_message_from_env() -> Option<String> {
    let raw = std::env::var(DEBUG_STARTUP_A_LINES_ENV).ok()?;
    debug_startup_a_lines_message(&raw)
}

fn debug_startup_a_lines_message(raw: &str) -> Option<String> {
    let count = raw.trim().parse::<usize>().ok()?;
    if count == 0 {
        return None;
    }
    Some(vec!["a"; count.min(DEBUG_STARTUP_A_LINES_MAX)].join("\n"))
}

fn background_watcher_error_event(
    error: tokio::sync::broadcast::error::RecvError,
) -> Option<AppEvent> {
    match error {
        tokio::sync::broadcast::error::RecvError::Lagged(skipped) => {
            warn!(skipped, "background job watcher lagged; continuing");
            Some(AppEvent::SystemNotice(format!(
                "[background] UI skipped {skipped} stale status event(s); continuing."
            )))
        }
        tokio::sync::broadcast::error::RecvError::Closed => None,
    }
}

fn reconciled_subagent_task_events(engine: &QueryEngine) -> Vec<AppEvent> {
    let tasks = engine.state.tasks().into_values().collect::<Vec<_>>();
    reconciled_subagent_task_events_from_tasks(tasks)
}

fn reconciled_subagent_task_events_from_tasks(mut tasks: Vec<kcoder_state::Task>) -> Vec<AppEvent> {
    tasks.retain(|task| task.managed && task.kind == TaskKind::Subagent);
    tasks.sort_by_key(|task| task.created_at_ms);
    let mut events = Vec::new();
    for task in tasks {
        let Some(tool_call_id) = task.parent_tool_call_id.clone() else {
            continue;
        };
        events.push(AppEvent::BackgroundJobAssociated {
            id: task.id.clone(),
            tool_call_id,
            run_in_background: task.delivery == TaskDelivery::Background,
        });
        match task.status {
            TaskStatus::Pending | TaskStatus::Running
                if task.delivery == TaskDelivery::Background =>
            {
                events.push(AppEvent::BackgroundJobPromoted {
                    id: task.id.clone(),
                });
                events.push(AppEvent::BackgroundJobReconciledRunning {
                    detail: Some(orchestrate_agent_status_detail(&task)),
                    id: task.id,
                    current: Some(1),
                    total: task.max_turns,
                });
            }
            TaskStatus::Pending | TaskStatus::Running => {
                events.push(AppEvent::BackgroundJobReconciledRunning {
                    detail: Some(orchestrate_agent_status_detail(&task)),
                    id: task.id,
                    current: Some(1),
                    total: task.max_turns,
                });
            }
            TaskStatus::Paused => {
                events.push(AppEvent::BackgroundJobPaused {
                    id: task.id.clone(),
                    reason: orchestrate_agent_status_detail(&task),
                });
            }
            TaskStatus::Halted => {
                events.push(AppEvent::BackgroundJobHalted {
                    id: task.id.clone(),
                    reason: orchestrate_agent_status_detail(&task),
                });
            }
            TaskStatus::Completed => {
                events.push(AppEvent::BackgroundJobCompleted {
                    id: task.id,
                    summary: task.output.map(|text| truncate_display_text(&text, 2_000)),
                });
            }
            TaskStatus::Failed => events.push(AppEvent::BackgroundJobFailed {
                id: task.id,
                error: task
                    .output
                    .unwrap_or_else(|| "Sub-agent failed".to_string()),
            }),
            TaskStatus::Cancelled => {
                events.push(AppEvent::BackgroundJobCancelled { id: task.id });
            }
        }
    }
    events
}

fn orchestrate_agent_status_detail(task: &kcoder_state::Task) -> String {
    let age_seconds = current_timestamp_ms()
        .saturating_sub(task.updated_at_ms)
        .saturating_div(1_000);
    let blocked = task
        .message_queue
        .first()
        .is_some_and(|message| message.status == kcoder_state::AgentMessageStatus::Blocked);
    let mut fields = vec![
        format!("queue {}", task.message_queue.len()),
        format!(
            "breaker {}",
            format!("{:?}", task.breaker.stage).to_ascii_lowercase()
        ),
        format!("last activity {age_seconds}s ago"),
    ];
    if blocked {
        fields.push("delivery blocked: use ControlAgent retry_message or discard_message".into());
    }
    if let Some(reason) = task.control.reason.as_ref() {
        fields.push(format!("reason: {}", reason.message));
    }
    fields.join(" · ")
}

fn orchestrate_agent_terminal_control_detail(
    engine: &QueryEngine,
    agent_id: &str,
    reason: &str,
) -> String {
    let Some(task) = engine.state.task(agent_id) else {
        return reason.to_string();
    };
    let status = orchestrate_agent_status_detail(&task);
    if reason.trim().is_empty() || status.contains(reason.trim()) {
        status
    } else {
        format!("{status} · {reason}")
    }
}

fn current_timestamp_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn append_repl_exit_diagnostic(engine: &QueryEngine, event: &str, reason: &str) {
    let Some(history_path) = engine.state.history_path() else {
        return;
    };
    let path = history_path.with_extension("exit.jsonl");
    let settings = recover_read_lock(&engine.settings, "engine.settings");
    let active_tasks = engine
        .state
        .tasks()
        .into_values()
        .filter(|task| matches!(task.status, TaskStatus::Pending | TaskStatus::Running))
        .map(|task| {
            serde_json::json!({
                "id": task.id,
                "description": task.description,
                "status": task.status,
                "updated_at_ms": task.updated_at_ms,
            })
        })
        .collect::<Vec<_>>();
    let entry = serde_json::json!({
        "session_id": engine.session_id(),
        "timestamp_ms": current_timestamp_ms(),
        "pid": std::process::id(),
        "cwd": engine.state.cwd(),
        "history_path": history_path,
        "model": settings.model.clone(),
        "provider": settings.provider.clone(),
        "event": event,
        "reason": reason,
        "active_tasks": active_tasks,
    });

    let result = (|| -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        writeln!(file, "{}", serde_json::to_string(&entry)?)?;
        Ok(())
    })();
    if let Err(error) = result {
        warn!(
            "failed to append REPL exit diagnostic {:?}: {}",
            path, error
        );
    }
}

fn append_repl_engine_event_diagnostic(engine: &QueryEngine, event: &EngineEvent) {
    match event {
        EngineEvent::Error(error) => append_repl_exit_diagnostic(engine, "engine_error", error),
        EngineEvent::ProviderFailed { message, details } => {
            append_repl_exit_diagnostic(engine, details.category.as_str(), message)
        }
        EngineEvent::StreamAborted { reason } => {
            append_repl_exit_diagnostic(engine, "stream_aborted", reason)
        }
        EngineEvent::CompactionFailed { error, .. } => {
            append_repl_exit_diagnostic(engine, "compaction_failed", error)
        }
        EngineEvent::BackgroundJobFailed { id, error } => {
            append_repl_exit_diagnostic(engine, "background_job_failed", &format!("{id}: {error}"));
        }
        _ => {}
    }
}

fn spawn_signal_listener(tx: AppEventSender) {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut sigterm) => {
                    tokio::select! {
                        result = tokio::signal::ctrl_c() => {
                            let reason = result
                                .map(|_| "Ctrl+C".to_string())
                                .unwrap_or_else(|error| format!("Ctrl+C listener failed: {error}"));
                            warn!(%reason, "signal listener requested exit");
                            let _ = tx.send_ordered(AppEvent::Fatal(format!("exit requested by {reason}"))).await;
                        }
                        _ = sigterm.recv() => {
                            warn!("signal listener requested exit by SIGTERM");
                            let _ = tx.send_ordered(AppEvent::Fatal("exit requested by SIGTERM".to_string())).await;
                        }
                    }
                }
                Err(error) => {
                    warn!(%error, "failed to install SIGTERM listener");
                    let reason = tokio::signal::ctrl_c()
                        .await
                        .map(|_| "Ctrl+C".to_string())
                        .unwrap_or_else(|error| format!("Ctrl+C listener failed: {error}"));
                    warn!(%reason, "signal listener requested exit");
                    let _ = tx
                        .send_ordered(AppEvent::Fatal(format!("exit requested by {reason}")))
                        .await;
                }
            }
        }

        #[cfg(not(unix))]
        {
            let reason = tokio::signal::ctrl_c()
                .await
                .map(|_| "Ctrl+C".to_string())
                .unwrap_or_else(|error| format!("Ctrl+C listener failed: {error}"));
            warn!(%reason, "signal listener requested exit");
            let _ = tx
                .send_ordered(AppEvent::Fatal(format!("exit requested by {reason}")))
                .await;
        }
    });
}

struct PreparedScrollbackFlush {
    target: usize,
    lines: Vec<HyperlinkLine>,
    height: usize,
    wrap_policy: insert_history::HistoryLineWrapPolicy,
    commit_welcome: bool,
}

fn append_initial_welcome_to_terminal_scrollback<B>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    width: u16,
) -> Result<bool>
where
    B: Backend + Write,
{
    if terminal.viewport_area.height > 0 || !app.should_render_startup_welcome(0) {
        return Ok(false);
    }

    let width = width.max(1);
    let mut lines = render_startup_welcome(startup_welcome_info(app), Some(width))
        .into_iter()
        .map(HyperlinkLine::new)
        .collect::<Vec<_>>();
    let commit_startup_notices = app
        .messages
        .iter()
        .all(|message| message.role == MessageRole::System);
    let startup_notice_target = if commit_startup_notices {
        app.messages.len()
    } else {
        0
    };
    if startup_notice_target > 0 {
        let mut notice_lines =
            app.render_transcript_range_hyperlink(0, startup_notice_target, width);
        if !notice_lines.is_empty() {
            lines.push(HyperlinkLine::new(Line::from("")));
            lines.append(&mut notice_lines);
        }
    }
    if lines.is_empty() {
        app.welcome_scrollback_committed = true;
        app.scrollback_committed_until = startup_notice_target;
        return Ok(true);
    }

    let wrap_policy = if app.raw_output_mode() {
        insert_history::HistoryLineWrapPolicy::Terminal
    } else {
        insert_history::HistoryLineWrapPolicy::PreWrap
    };
    let height =
        insert_history::history_lines_display_rows(&lines, usize::from(width), wrap_policy);
    if height > usize::from(u16::MAX) {
        warn!(
            height,
            "skipping oversized startup welcome append to terminal scrollback"
        );
        return Ok(false);
    }

    let mut start_y = terminal.viewport_area.top();
    let screen_height = terminal
        .size()
        .context("failed to read terminal size before startup welcome append")?
        .height
        .max(1);
    let rows_written = height as u16;
    let min_live_rows_after_welcome = 4u16.min(screen_height.saturating_sub(1));
    let required_rows = rows_written.saturating_add(min_live_rows_after_welcome);
    let overflow = start_y
        .saturating_add(required_rows)
        .saturating_sub(screen_height);
    if overflow > 0 && start_y > 0 {
        let scroll = overflow.min(start_y);
        terminal
            .backend_mut()
            .scroll_region_up(0..start_y, scroll)
            .context("failed to make room for startup welcome")?;
        start_y = start_y.saturating_sub(scroll);
        terminal.last_known_cursor_pos.y = terminal.last_known_cursor_pos.y.saturating_sub(scroll);
    }
    let wrap_width = usize::from(width);
    let writer = terminal.backend_mut();
    let mut write_y = start_y;
    for line in &lines {
        crossterm::queue!(writer, MoveTo(0, write_y))
            .context("failed to position cursor for startup welcome append")?;
        insert_history::write_history_line(writer, line, wrap_width)
            .context("failed to write startup welcome append line")?;
        let physical_rows = line.width().max(1).div_ceil(wrap_width.max(1));
        write_y = write_y
            .saturating_add(physical_rows.min(usize::from(u16::MAX)) as u16)
            .min(screen_height.saturating_sub(1));
    }
    crossterm::queue!(writer, MoveTo(0, write_y))
        .context("failed to move cursor after startup welcome append")?;

    let new_y = start_y
        .saturating_add(rows_written)
        .min(screen_height.saturating_sub(1));
    let mut area = terminal.viewport_area;
    area.y = new_y;
    area.width = width;
    terminal.set_viewport_area(area);
    terminal.last_known_cursor_pos = Position::new(0, new_y);
    terminal.note_history_rows_inserted(rows_written);
    terminal.invalidate_viewport();
    app.welcome_scrollback_committed = true;
    app.scrollback_committed_until = startup_notice_target;
    app.startup_live_viewport_top_limit =
        Some(new_y.saturating_add(startup_live_viewport_top_offset()));
    Ok(true)
}

fn prepare_committed_history_for_scrollback(
    app: &mut ReplApp,
    width: u16,
    _viewport_area: Rect,
    _screen_height: u16,
) -> Option<PreparedScrollbackFlush> {
    if app.copy_view.is_some() || app.outline_open || app.navigation.inline {
        return None;
    }
    let committed_until = app.scrollback_committed_until.min(app.messages.len());
    app.scrollback_committed_until = committed_until;
    let live_transcript_rows = app.transcript_viewport.viewport_rows().max(1);
    let target =
        app.scrollback_commit_target_for_viewport(committed_until, width, live_transcript_rows);
    let commit_welcome = app.should_render_startup_welcome(committed_until);
    if target <= committed_until && !commit_welcome {
        return None;
    }

    let mut lines = if target > committed_until {
        app.render_transcript_range_hyperlink(committed_until, target, width)
    } else {
        Vec::new()
    };
    let has_following_content = !lines.is_empty();
    app.prepend_startup_welcome_hyperlink_lines(
        &mut lines,
        width,
        committed_until,
        has_following_content,
    );
    let wrap_policy = if app.raw_output_mode() {
        insert_history::HistoryLineWrapPolicy::Terminal
    } else {
        insert_history::HistoryLineWrapPolicy::PreWrap
    };
    let height =
        insert_history::history_lines_display_rows(&lines, usize::from(width.max(1)), wrap_policy);
    Some(PreparedScrollbackFlush {
        target,
        lines,
        height,
        wrap_policy,
        commit_welcome,
    })
}

fn flush_prepared_history_to_scrollback<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    prepared: PreparedScrollbackFlush,
) -> Result<bool> {
    let size = terminal
        .size()
        .context("failed to read terminal size before scrollback flush")?;
    if terminal.viewport_area.top() == 0 && terminal.viewport_area.bottom() >= size.height.max(1) {
        return Ok(false);
    }
    let mark_committed = |app: &mut ReplApp, target: usize, commit_welcome: bool| {
        app.scrollback_committed_until = target;
        if commit_welcome {
            app.welcome_scrollback_committed = true;
        }
        // The current frame computed its viewport height from the pre-flush
        // transcript window. Once rows move into terminal scrollback, the live
        // window can be much shorter; force a follow-up frame to recompute
        // desired_height from source instead of leaving a stale blank band.
        app.transcript_viewport.invalidate_content_layout();
        if app.transcript_viewport.is_at_tail() {
            app.snap_to_bottom();
        }
        app.force_next_viewport_redraw();
    };
    if prepared.height == 0 {
        mark_committed(app, prepared.target, prepared.commit_welcome);
        return Ok(true);
    }
    if prepared.height > u16::MAX as usize {
        warn!(
            height = prepared.height,
            target = prepared.target,
            "skipping oversized transcript scrollback insert"
        );
        return Ok(false);
    }

    // ConPTY owns only a fixed-size console buffer and does not forward the
    // scroll-region operations used by the standard inline history path to
    // the host terminal. Emit physical lines there so Windows Terminal (and
    // other ConPTY clients) can retain the same native scrollback as a Unix
    // PTY. Zellij raw-output mode needs the same strategy for a different
    // transport limitation.
    let insert_mode = if cfg!(windows)
        || (zellij_multiplexer_detected()
            && prepared.wrap_policy == insert_history::HistoryLineWrapPolicy::Terminal)
    {
        insert_history::InsertHistoryMode::ZellijRaw
    } else {
        insert_history::InsertHistoryMode::Standard
    };
    insert_history::insert_history_hyperlink_lines_with_mode_and_wrap_policy(
        terminal,
        prepared.lines,
        insert_mode,
        prepared.wrap_policy,
    )
    .context("failed to insert transcript history into terminal scrollback")?;
    mark_committed(app, prepared.target, prepared.commit_welcome);
    Ok(true)
}

fn repaint_visible_scrollback_tail_after_resize<B>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    width: u16,
) -> Result<()>
where
    B: Backend + Write,
{
    let rows_above_live_viewport = terminal.viewport_area.top();
    if rows_above_live_viewport == 0 || app.scrollback_committed_until == 0 {
        return Ok(());
    }

    let target = app.scrollback_committed_until.min(app.messages.len());
    let lines = app.render_transcript_range_hyperlink(0, target, width.max(1));
    if lines.is_empty() {
        return Ok(());
    }

    let wrap_width = usize::from(width.max(1));
    let row_budget = usize::from(rows_above_live_viewport);
    let mut selected = Vec::new();
    let mut selected_rows = 0usize;
    for line in lines.into_iter().rev() {
        let rows = line.width().max(1).div_ceil(wrap_width.max(1));
        if rows > row_budget {
            continue;
        }
        if selected_rows.saturating_add(rows) > row_budget {
            break;
        }
        selected_rows = selected_rows.saturating_add(rows);
        selected.push((line, rows));
    }
    if selected.is_empty() {
        return Ok(());
    }

    let mut write_y = rows_above_live_viewport.saturating_sub(selected_rows as u16);
    let writer = terminal.backend_mut();
    for (line, rows) in selected.into_iter().rev() {
        crossterm::queue!(writer, MoveTo(0, write_y))
            .context("failed to position cursor for resize scrollback tail repaint")?;
        insert_history::write_history_line(writer, &line, wrap_width)
            .context("failed to repaint resize scrollback tail line")?;
        write_y = write_y
            .saturating_add(rows.min(usize::from(u16::MAX)) as u16)
            .min(rows_above_live_viewport);
    }

    Ok(())
}

/// Run the REPL backed by a QueryEngine.
pub async fn run_repl_with_engine(
    mut engine: QueryEngine,
    startup_notice: Option<String>,
) -> Result<()> {
    let tui_settings = recover_read_lock(&engine.settings, "engine.settings")
        .tui
        .clone();
    configure_tui_alternate_screen(tui_settings.no_alt_screen, tui_settings.alternate_screen);
    engine = engine.with_tool_path_previews(tui_settings.path_preview.enabled);

    let mut app = ReplApp::default();
    app.refresh_engine_metadata(&engine);
    let restored_messages = engine.state.messages();
    if !restored_messages.is_empty() {
        app.replace_transcript_from_history(&restored_messages);
        app.reconcile_subagent_panels_from_engine(&engine);
    }
    seed_startup_messages(&mut app, startup_notice);
    if !restored_messages.is_empty() && engine.state.session_mode().is_orchestrate() {
        let store = kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd());
        if let Ok(snapshot) = store.read_active_work()
            && snapshot.work.progress.completed < snapshot.work.progress.total
        {
            app.push_message(
                MessageRole::System,
                format!(
                    "Detected unfinished Orchestrate work `{}` ({}, revision {}, progress {}/{}). The active plan and bounded notepad context were restored; child-agent transcripts are not resurrected automatically. Use `/work status` to inspect it or `/work select <work_id>` to choose another work.",
                    snapshot.work.display_slug,
                    snapshot.work.work_id,
                    snapshot.work.revision,
                    snapshot.work.progress.completed,
                    snapshot.work.progress.total,
                ),
            );
        } else if let Ok(works) = store.list_works() {
            let candidates = works
                .into_iter()
                .filter(|snapshot| snapshot.work.progress.completed < snapshot.work.progress.total)
                .collect::<Vec<_>>();
            if !candidates.is_empty() {
                let choices = candidates
                    .iter()
                    .map(|snapshot| {
                        format!("{} ({})", snapshot.work.display_slug, snapshot.work.work_id)
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                app.push_message(
                    MessageRole::System,
                    format!(
                        "Detected unfinished Orchestrate work without an active pointer: {choices}. Use `/work select <work_id>` explicitly before continuing; child-agent transcripts are not resurrected."
                    ),
                );
            }
        }
    }
    if let Ok(settings) = Settings::load()
        && let Ok(dir) = settings.history_dir()
    {
        let path = dir.join("input_history.jsonl");
        let legacy_path = dir.join("input_history.txt");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            warn!("failed to create history directory {:?}: {}", dir, e);
        }
        app.set_input_history_path(path);
        if app
            .input_history_path
            .as_ref()
            .is_some_and(|current| current.exists())
        {
            app.load_input_history();
        } else if legacy_path.exists() {
            match load_input_history_file(&legacy_path) {
                Ok(history) => {
                    app.input_history = history;
                    if let Some(current) = app.input_history_path.as_ref()
                        && let Err(error) = save_input_history_file(current, &app.input_history)
                    {
                        warn!("failed to migrate input history: {}", error);
                    }
                }
                Err(error) => warn!("failed to load legacy input history: {}", error),
            }
        }
    }

    // Complete the sole terminal probe before automatic theme warmup and cache failures so repeated color replies cannot enter the composer.
    let startup_probe = terminal_modes::startup_probe();
    terminal_palette::set_default_colors_from_startup_probe(startup_probe.default_colors);

    // Pre-load Markdown/syntax-highlighting resources off the UI thread so the
    // first terminal draw does not stutter on syntect asset initialization.
    let code_theme = recover_read_lock(&engine.settings, "engine.settings")
        .code_theme
        .clone();
    let _ = tokio::task::spawn_blocking(move || crate::markdown::warm_up(&code_theme)).await;

    let (raw_tx, mut rx) = mpsc::channel::<AppEvent>(APP_EVENT_CHANNEL_CAPACITY);
    let tx = AppEventSender::new(raw_tx);

    // Run the terminal startup probe BEFORE spawning the crossterm event
    // reader. crossterm 0.28's input parser has no OSC state machine: when it
    // sees the OSC 10/11 query replies (e.g. `\x1B]10;rgb:cccc/cccc/cccc\x1B\\`)
    // it falls back to per-byte parsing and converts the payload into a
    // stream of `KeyCode::Char` events. If the crossterm reader is already
    // polling on stdin when the probe fires, it can race the probe for those
    // response bytes and leak them straight into the prompt buffer.
    // Drain anything that arrived on stdin during the probe window (including
    // any OSC bytes that crossterm may have read concurrently) so the
    // EventStream starts on a clean buffer.
    flush_terminal_input_buffer();

    // Spawn a terminal event reader. It can be paused while an external
    // interactive program owns stdin.
    let terminal_events = spawn_terminal_event_reader(tx.clone());

    spawn_signal_listener(tx.clone());
    let frame_requester = FrameRequester::new(tx.clone());

    let prompt = TuiPermissionPrompt::new(tx.clone());
    engine.set_user_questioner(Arc::new(TuiUserQuestioner::new(tx.clone())));

    // Two cooperating watchers sit on the engine's background-job broadcast:
    //
    // 1. The "injection" watcher is the only one that drains the engine's
    //    own `background_job_rx`. It calls
    //    `QueryEngine::flush_background_jobs` so the corresponding
    //    `<subagent_notification .../>` lands in the main conversation. It
    //    asks the TUI event loop to schedule follow-up work, but never
    //    touches the user prompt queue or starts turns directly.
    //
    // 2. The "tui" watcher subscribes to a *separate* broadcast receiver
    //    (via `subscribe_background_jobs`) and only feeds the TUI a tiny
    //    status hint. The hint is not written to the transcript; it only
    //    updates compact status surfaces, so the user sees delegated work
    //    state without it appearing in the transcript or being confused for
    //    assistant output.
    {
        let injection_engine = engine.clone();
        let followup_tx = tx.clone();
        tokio::spawn(async move {
            let mut last_goal_wake: Option<String> = None;
            // The injection watcher owns the engine's primary receiver. We
            // can subscribe to a fresh broadcast receiver for the TUI
            // watcher; they coexist without starving each other as long as
            // only the injection one drains engine state.
            //
            // To avoid double-broadcasting, we re-implement the polling
            // loop here using `try_recv` semantics: every 100 ms we ask the
            // engine to flush whatever it has buffered and then act on it.
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                // While a turn stream is alive the engine turn loop owns
                // background event delivery: it defers events and injects them
                // at the next protocol boundary. Flushing here would race that
                // claim and turn a same-turn continuation into a spurious extra
                // follow-up turn. The next 100 ms tick after the turn ends
                // picks the event up instead (nothing else drains the receiver
                // in that gap, so no event can be lost).
                if injection_engine.turn_driver_active() {
                    continue;
                }
                let drained = injection_engine.flush_background_jobs_with_hooks().await;
                for event in &drained {
                    if let EngineEvent::HookMessage { text, is_error } = event {
                        let _ = followup_tx
                            .send_ordered(AppEvent::SystemNotice(if *is_error {
                                format!("[hook error] {}", text)
                            } else {
                                text.clone()
                            }))
                            .await;
                    }
                }
                // `flush_background_jobs` also reports explicit
                // background shell tasks and internal maintenance jobs.
                // Only sub-agent completions should wake the main model;
                // tool background tasks are consumed by TaskOutput.
                let followup_events: Vec<EngineEvent> = drained
                    .iter()
                    .filter(|event| injection_engine.background_event_triggers_followup(event))
                    .cloned()
                    .collect();
                let active_goal_id =
                    active_goal_for_continuation(&injection_engine).map(|goal| goal.goal_id);
                if !followup_events.is_empty() {
                    // Mirror `events` one-to-one: an id-less event becomes an
                    // empty id (which always survives validation) instead of
                    // being dropped, so `ids` and `events` can never
                    // desynchronize under `zip` in the enqueue/merge paths.
                    let ids = followup_events
                        .iter()
                        .map(|event| {
                            event
                                .background_identity()
                                .map(|identity| {
                                    serde_json::to_string(&identity.run)
                                        .expect("serializable run key")
                                })
                                .unwrap_or_else(|| {
                                    background_event_id(event).unwrap_or_default().to_string()
                                })
                        })
                        .collect::<Vec<_>>();
                    let events = followup_events
                        .iter()
                        .map(format_background_event)
                        .collect::<Vec<_>>();
                    let summary = events.join(" ");
                    let _ = followup_tx
                        .send_ordered(AppEvent::BackgroundFollowupRequested {
                            ids,
                            events,
                            summary,
                        })
                        .await;
                    if active_goal_id.is_none() {
                        last_goal_wake = None;
                    }
                } else if let Some(goal_id) = active_goal_id {
                    if last_goal_wake.as_deref() != Some(goal_id.as_str())
                        && followup_tx.send_ordered(AppEvent::TurnWakeRequested).await
                    {
                        last_goal_wake = Some(goal_id);
                    }
                } else {
                    last_goal_wake = None;
                }
            }
        });
    }
    {
        let bg_tx = tx.clone();
        let mut bg_rx = engine.subscribe_background_jobs();
        let bg_diagnostic_engine = engine.clone();
        tokio::spawn(async move {
            // Broadcasts cover only the current process. Rebuild panels from persisted task
            // sidecars at startup so normal restarts show paused, stopped, and running sub-agents.
            for event in reconciled_subagent_task_events(&bg_diagnostic_engine) {
                if !bg_tx.send_ordered(event).await {
                    return;
                }
            }
            let mut seen_background_events = std::collections::HashSet::new();
            let mut background_event_order = std::collections::VecDeque::new();
            'watcher: loop {
                let event = match bg_rx.recv().await {
                    Ok(event) => event,
                    Err(error) => {
                        if let Some(app_event) = background_watcher_error_event(error) {
                            if !bg_tx.send_ordered(app_event).await {
                                break;
                            }
                            for event in reconciled_subagent_task_events(&bg_diagnostic_engine) {
                                if !bg_tx.send_ordered(event).await {
                                    break 'watcher;
                                }
                            }
                            continue;
                        }
                        break;
                    }
                };
                if let Some(identity) = event.identity() {
                    if !seen_background_events.insert(identity.event_id.clone()) {
                        continue;
                    }
                    background_event_order.push_back(identity.event_id.clone());
                    if background_event_order.len() > 4096
                        && let Some(oldest) = background_event_order.pop_front()
                    {
                        seen_background_events.remove(&oldest);
                    }
                    if !bg_diagnostic_engine
                        .state
                        .task(&identity.run.agent_id)
                        .is_some_and(|task| task.background_run.as_ref() == Some(&identity.run))
                    {
                        // A deleted or superseded run must not recreate the current status panel.
                        continue;
                    }
                }
                let app_event = match event.into_payload() {
                    BackgroundJobEvent::Scoped { .. } => {
                        unreachable!("into_payload unwraps scoped events")
                    }
                    BackgroundJobEvent::Started {
                        id,
                        description,
                        continuation,
                    } => AppEvent::BackgroundJobStarted {
                        id,
                        description,
                        continuation,
                    },
                    BackgroundJobEvent::Associated {
                        id,
                        tool_call_id,
                        run_in_background,
                    } => AppEvent::BackgroundJobAssociated {
                        id,
                        tool_call_id,
                        run_in_background,
                    },
                    BackgroundJobEvent::Promoted { id } => AppEvent::BackgroundJobPromoted { id },
                    BackgroundJobEvent::Progress {
                        id,
                        message,
                        detail,
                        current,
                        total,
                    } => AppEvent::BackgroundJobProgress {
                        id,
                        message,
                        detail,
                        current,
                        total,
                    },
                    BackgroundJobEvent::SubagentSteerApplied {
                        id,
                        message_id,
                        queue_depth,
                    } => AppEvent::SubagentSteerApplied {
                        id,
                        message_id,
                        queue_depth,
                    },
                    BackgroundJobEvent::Completed { id, output } => {
                        // Status indicator only — the engine already has the
                        // actual result, the model has been (or will be)
                        // nudged via `<subagent_notification .../>`, and the
                        // transcript stays clean.
                        let text = content_blocks_text(&output.content);
                        AppEvent::BackgroundJobCompleted {
                            id,
                            summary: (!text.trim().is_empty())
                                .then(|| truncate_display_text(text.trim(), 2_000)),
                        }
                    }
                    BackgroundJobEvent::Failed { id, error } => {
                        append_repl_exit_diagnostic(
                            &bg_diagnostic_engine,
                            "background_job_failed",
                            &format!("{id}: {error}"),
                        );
                        AppEvent::BackgroundJobFailed { id, error }
                    }
                    BackgroundJobEvent::Paused { id, reason } => {
                        let reason = orchestrate_agent_terminal_control_detail(
                            &bg_diagnostic_engine,
                            &id,
                            &reason,
                        );
                        AppEvent::BackgroundJobPaused { id, reason }
                    }
                    BackgroundJobEvent::Halted { id, reason } => {
                        let reason = orchestrate_agent_terminal_control_detail(
                            &bg_diagnostic_engine,
                            &id,
                            &reason,
                        );
                        AppEvent::BackgroundJobHalted { id, reason }
                    }
                    BackgroundJobEvent::Cancelled { id, .. } => {
                        AppEvent::BackgroundJobCancelled { id }
                    }
                };
                if !bg_tx.send_ordered(app_event).await {
                    break;
                }
            }
        });
    }
    {
        let cron_tx = tx.clone();
        let cron_scheduler = engine.cron_scheduler();
        let mut cron_rx = engine.subscribe_cron();
        tokio::spawn(async move {
            while let Ok(fire) = cron_rx.recv().await {
                let folded = if fire.coalesced == 0 {
                    String::new()
                } else {
                    format!(
                        " {} additional missed trigger(s) were coalesced.",
                        fire.coalesced
                    )
                };
                let event = format!(
                    "[scheduled task {} due at {}] {}{}",
                    fire.id, fire.scheduled_at, fire.prompt, folded
                );
                if !cron_tx
                    .send_ordered(AppEvent::BackgroundFollowupRequested {
                        ids: vec![String::new()],
                        events: vec![event.clone()],
                        summary: event,
                    })
                    .await
                {
                    break;
                }
                // Acknowledge only queue delivery, never model/tool execution.
                // Failure leaves the durable receipt uncertain; do not resend.
                if cron_scheduler.acknowledge_delivery(&fire).is_err() {
                    let _ = cron_tx.send_ordered(AppEvent::SystemNotice(
                        format!("Scheduled task {} was queued, but its delivery record could not be saved. Inspect cron delivery diagnostics before retrying.", fire.id),
                    )).await;
                }
            }
        });
    }

    let (mut terminal, mut terminal_guard) = init_kcoder_terminal(startup_probe)?;
    let result = repl_loop(
        &mut terminal,
        &engine,
        &mut app,
        &mut rx,
        tx,
        &mut terminal_guard,
        terminal_events,
        frame_requester,
        prompt,
    )
    .await;
    match &result {
        Ok(()) => append_repl_exit_diagnostic(&engine, "exit", "success"),
        Err(error) => append_repl_exit_diagnostic(&engine, "exit", &format!("error: {error:#}")),
    }
    let exit_reason = if result.is_ok() { "success" } else { "error" };
    let title_cleanup_result = app.clear_managed_terminal_title(terminal.backend_mut());
    let cleanup_result = if terminal_guard.uses_alternate_screen() {
        let cleanup_result = cleanup_alternate_screen_for_exit(&mut terminal);
        terminal_guard.restore();
        cleanup_result
    } else {
        // Restoring terminal modes resets the scroll region (`ESC[r`), and many
        // terminals move the cursor to home as part of that reset. Do it before
        // the final inline cleanup so the shell prompt lands after the emitted
        // transcript instead of overwriting the top of the old viewport.
        terminal_guard.restore();
        cleanup_inline_viewport_for_exit(&mut terminal, &mut app)
    };
    let _ = engine.run_session_end_hooks(exit_reason).await;
    result.and(title_cleanup_result).and(cleanup_result)
}

fn cleanup_alternate_screen_for_exit<B: Backend + Write>(terminal: &mut Terminal<B>) -> Result<()> {
    terminal
        .reset_cursor_style()
        .context("failed to reset cursor style before terminal restore")?;
    std::io::Write::flush(terminal.backend_mut())
        .context("failed to flush alternate screen cleanup")?;
    Ok(())
}

struct ExitScrollbackFlush {
    target: usize,
    lines: Vec<HyperlinkLine>,
    commit_welcome: bool,
}

fn prepare_remaining_history_for_exit(
    app: &mut ReplApp,
    width: u16,
) -> Option<ExitScrollbackFlush> {
    app.flush_active_turn();
    let committed_until = app.scrollback_committed_until.min(app.messages.len());
    app.scrollback_committed_until = committed_until;

    let target = app.messages.len();
    let mut lines = if target > committed_until {
        app.render_transcript_range_hyperlink(committed_until, target, width)
    } else {
        Vec::new()
    };
    let has_following_content = !lines.is_empty();
    let commit_welcome = app.should_render_startup_welcome(committed_until);
    app.prepend_startup_welcome_hyperlink_lines(
        &mut lines,
        width,
        committed_until,
        has_following_content,
    );

    if lines.is_empty() {
        return None;
    }

    Some(ExitScrollbackFlush {
        target,
        lines,
        commit_welcome,
    })
}

fn write_remaining_history_for_exit<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<bool> {
    let size = terminal
        .size()
        .context("failed to read terminal size before inline exit cleanup")?;
    let width = size.width.max(1);
    let Some(prepared) = prepare_remaining_history_for_exit(app, width) else {
        return Ok(false);
    };

    let viewport_top = terminal.viewport_area.top();
    terminal
        .clear_after_position(Position::new(0, viewport_top))
        .context("failed to clear inline viewport before exit scrollback flush")?;

    let wrap_width = usize::from(width.max(1));
    let writer = terminal.backend_mut();
    crossterm::queue!(writer, MoveTo(0, viewport_top))
        .context("failed to position cursor for inline exit scrollback flush")?;
    for (index, line) in prepared.lines.iter().enumerate() {
        if index > 0 {
            crossterm::queue!(writer, Print("\r\n"))
                .context("failed to advance inline exit scrollback line")?;
        }
        insert_history::write_history_line(writer, line, wrap_width)
            .context("failed to write inline exit scrollback line")?;
    }
    crossterm::queue!(writer, Print("\r\n"))
        .context("failed to move cursor after inline exit scrollback flush")?;

    app.scrollback_committed_until = prepared.target;
    if prepared.commit_welcome {
        app.welcome_scrollback_committed = true;
    }
    terminal.invalidate_viewport();
    Ok(true)
}

fn cleanup_inline_viewport_for_exit<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<()> {
    if terminal.viewport_area.is_empty() {
        return Ok(());
    }
    let wrote_history = write_remaining_history_for_exit(terminal, app)?;
    if !wrote_history {
        let prompt_position = Position::new(0, terminal.viewport_area.y);
        terminal
            .clear_after_position(prompt_position)
            .context("failed to clear inline viewport before terminal restore")?;
        let bottom_position = Position::new(0, terminal.viewport_area.bottom().saturating_sub(1));
        terminal
            .set_cursor_position(bottom_position)
            .context("failed to move cursor after clearing inline viewport")?;
    }
    terminal
        .reset_cursor_style()
        .context("failed to reset cursor style before terminal restore")?;
    std::io::Write::flush(terminal.backend_mut())
        .context("failed to flush inline viewport cleanup")?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InlineViewportHeights {
    base: u16,
    expanded: u16,
    reserved_bottom_slack: u16,
    max_top: Option<u16>,
}

const STARTUP_MAX_BLANK_GAP_BEFORE_LIVE_VIEWPORT: u16 = 8;

fn startup_live_viewport_top_offset() -> u16 {
    STARTUP_MAX_BLANK_GAP_BEFORE_LIVE_VIEWPORT / 2
}

#[cfg(test)]
fn update_inline_viewport<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    height: u16,
) -> Result<bool> {
    update_inline_viewport_for_draw(
        terminal,
        InlineViewportHeights {
            base: height,
            expanded: height,
            reserved_bottom_slack: 0,
            max_top: None,
        },
    )
}

fn scroll_rows_above_inline_viewport<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    viewport_top: u16,
    rows: u16,
    allow_shell_history: bool,
    context: &'static str,
) -> Result<u16> {
    let rows = rows.min(viewport_top);
    if rows == 0 {
        return Ok(0);
    }

    let visible_history_rows = terminal.visible_history_rows().min(viewport_top);
    let mut scrolled = 0u16;
    if visible_history_rows > 0 {
        let visible_scroll = rows.min(visible_history_rows);
        let history_start = viewport_top.saturating_sub(visible_history_rows);
        terminal
            .backend_mut()
            .scroll_region_up(history_start..viewport_top, visible_scroll)
            .context(context)?;
        terminal.note_visible_history_rows_scrolled_out(visible_scroll);
        scrolled = scrolled.saturating_add(visible_scroll);
    }

    let remaining = rows.saturating_sub(scrolled);
    if remaining == 0 || !allow_shell_history {
        return Ok(scrolled);
    }

    let shell_region_end = viewport_top.saturating_sub(scrolled);
    let shell_scroll = remaining.min(shell_region_end);
    if shell_scroll == 0 {
        return Ok(scrolled);
    }
    terminal
        .backend_mut()
        .scroll_region_up(0..shell_region_end, shell_scroll)
        .context(context)?;
    Ok(scrolled.saturating_add(shell_scroll))
}

fn update_inline_viewport_for_draw<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    heights: InlineViewportHeights,
) -> Result<bool> {
    let size = terminal.size().context("failed to read terminal size")?;
    let screen_height = size.height.max(1);
    let screen_width = size.width.max(1);
    let terminal_height_shrank = screen_height < terminal.last_known_screen_size.height.max(1);
    let previous_area = terminal.viewport_area;
    let first_live_viewport_draw = previous_area.height == 0;
    let mut area = terminal.viewport_area;
    area.width = screen_width;
    area.y = area.y.min(screen_height.saturating_sub(1));

    area.height = heights.base.min(screen_height).max(1);
    if area.bottom() > screen_height {
        let scroll_by = area.bottom() - screen_height;
        let mut scrolled = 0;
        if !terminal_height_shrank {
            if first_live_viewport_draw && terminal.visible_history_rows() > 0 {
                let scroll = scroll_by.min(area.top());
                if scroll > 0 {
                    let visible_history_rows = terminal.visible_history_rows().min(area.top());
                    let visible_history_top = area.top().saturating_sub(visible_history_rows);
                    terminal
                        .backend_mut()
                        .scroll_region_up(0..area.top(), scroll)
                        .context("failed to scroll prior terminal rows above startup viewport")?;
                    let visible_rows_scrolled = scroll.saturating_sub(visible_history_top);
                    if visible_rows_scrolled > 0 {
                        terminal.note_visible_history_rows_scrolled_out(visible_rows_scrolled);
                    }
                    scrolled = scroll;
                }
            } else {
                scrolled = scroll_rows_above_inline_viewport(
                    terminal,
                    area.top(),
                    scroll_by,
                    true,
                    "failed to scroll prior terminal history above inline viewport",
                )?;
            }
        }
        area.y = area.y.saturating_sub(scrolled);
        if area.bottom() > screen_height {
            area.y = screen_height.saturating_sub(area.height);
        }
    }

    let mut current_bottom_slack = screen_height.saturating_sub(area.bottom());
    let max_bottom_slack = screen_height.saturating_sub(area.height);
    let target_bottom_slack = if first_live_viewport_draw {
        current_bottom_slack.min(heights.reserved_bottom_slack.min(max_bottom_slack))
    } else {
        heights.reserved_bottom_slack.min(max_bottom_slack)
    };
    let consume_rows = current_bottom_slack
        .saturating_sub(target_bottom_slack)
        .min(max_bottom_slack);
    if consume_rows > 0 {
        area.y = area
            .y
            .saturating_add(consume_rows)
            .min(screen_height.saturating_sub(area.height));
        current_bottom_slack = screen_height.saturating_sub(area.bottom());
    }
    let max_top = heights.max_top.or_else(|| {
        (first_live_viewport_draw && terminal.visible_history_rows() > 0).then(|| {
            previous_area
                .y
                .saturating_add(startup_live_viewport_top_offset())
        })
    });
    if let Some(max_top) = max_top {
        let max_startup_top = max_top.min(screen_height.saturating_sub(area.height));
        if area.y > max_startup_top {
            area.y = max_startup_top;
            current_bottom_slack = screen_height.saturating_sub(area.bottom());
        }
    }
    let visible_history_rows = terminal.visible_history_rows().min(area.y);
    let reserve_rows = target_bottom_slack
        .saturating_sub(current_bottom_slack)
        .min(visible_history_rows)
        .min(area.y);
    if reserve_rows > 0 && !terminal_height_shrank {
        let scrolled = scroll_rows_above_inline_viewport(
            terminal,
            area.top(),
            reserve_rows,
            false,
            "failed to reserve bottom slack above inline viewport",
        )?;
        area.y = area.y.saturating_sub(scrolled);
    }

    let available_below_top = screen_height.saturating_sub(area.y).max(1);
    area.height = heights
        .expanded
        .max(heights.base)
        .min(available_below_top)
        .max(1);

    let mut needs_full_repaint = false;
    if area != terminal.viewport_area {
        // A shorter terminal clips the abandoned part of the old live surface, so
        // preserve committed rows above the new one. On growth, those old composer
        // rows remain visible and must be cleared before repainting at the new top.
        let clear_top = if terminal_height_shrank {
            area.y
        } else {
            previous_area.y.min(area.y)
        };
        let clear_position = Position::new(0, clear_top);
        terminal.set_viewport_area(area);
        terminal
            .clear_after_position(clear_position)
            .context("failed to clear viewport transition")?;
        needs_full_repaint = true;
    }
    Ok(needs_full_repaint)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalSurfaceMode {
    Inline,
    Fullscreen,
}

#[cfg(test)]
fn draw_kcoder_frame<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<bool> {
    draw_kcoder_frame_with_mode(terminal, app, TerminalSurfaceMode::Inline)
}

fn draw_kcoder_frame_with_mode<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    mode: TerminalSurfaceMode,
) -> Result<bool> {
    match mode {
        TerminalSurfaceMode::Inline => draw_kcoder_inline_frame(terminal, app),
        TerminalSurfaceMode::Fullscreen => draw_kcoder_fullscreen_frame(terminal, app),
    }
}

fn draw_kcoder_fullscreen_frame<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<bool> {
    terminal
        .synchronized_update(|terminal| -> Result<bool> {
            let size = terminal.size().context("failed to read terminal size")?;
            let area = Rect::new(0, 0, size.width.max(1), size.height.max(1));
            app.observe_terminal_size(size);
            app.scrollback_committed_until = 0;
            app.welcome_scrollback_committed = false;
            app.fullscreen_surface = true;
            app.sync_slash_menu();

            let resize_viewport_reset = app.take_resize_viewport_reset_pending();
            let force_viewport_redraw = app.take_force_viewport_redraw();
            let viewport_changed = terminal.viewport_area != area;
            if viewport_changed {
                terminal.set_viewport_area(area);
            }
            if cfg!(windows) && (viewport_changed || resize_viewport_reset) {
                // The native Windows console host can retain stale cells after
                // its visible window and screen buffer are resized. Row-level
                // Erase in Line repainting is insufficient there and produces
                // blank surfaces or old rectangles until another full redraw.
                // Clear the owned alternate-screen surface inside the same
                // synchronized update, then rebuild the frame from an empty
                // comparison buffer.
                terminal
                    .clear_visible_screen()
                    .context("failed to clear resized Windows fullscreen surface")?;
                terminal.reset_current_viewport_buffer();
            } else if viewport_changed || resize_viewport_reset || force_viewport_redraw {
                // In fullscreen mode the whole terminal surface is owned by
                // ratatui. Mark the previous buffer dirty so the next draw
                // emits row-level clears plus the new content in the same
                // synchronized update. A plain buffer reset would make the
                // diff think the screen was already blank, leaving stale
                // xterm.js canvas pixels behind; a physical full-screen clear
                // can be captured as a black flash between clear and repaint.
                terminal.reset_current_viewport_buffer();
                terminal.invalidate_viewport_for_repaint();
            }

            app.sync_terminal_title(terminal.backend_mut())?;
            terminal
                .draw(|f| app.draw(f))
                .context("failed to draw KCoder fullscreen TUI frame")?;
            Ok(false)
        })
        .context("failed to run synchronized fullscreen terminal update")?
}

fn draw_kcoder_inline_frame<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
) -> Result<bool> {
    app.fullscreen_surface = false;
    terminal
        .synchronized_update(|terminal| -> Result<bool> {
            let size = terminal.size().context("failed to read terminal size")?;
            app.observe_terminal_size(size);
            let resize_viewport_reset = app.take_resize_viewport_reset_pending();
            if resize_viewport_reset {
                terminal.invalidate_viewport();
            }
            append_initial_welcome_to_terminal_scrollback(terminal, app, size.width.max(1))?;
            let mut prepared_scrollback = prepare_committed_history_for_scrollback(
                app,
                size.width.max(1),
                terminal.viewport_area,
                size.height.max(1),
            );
            let reflow_ran = false;
            let height_budget = size.height.max(1);
            app.sync_slash_menu();
            let pending_scrollback_target = prepared_scrollback
                .as_ref()
                .map(|prepared| prepared.target)
                .filter(|target| *target > app.scrollback_committed_until);
            let original_scrollback_committed_until = app.scrollback_committed_until;
            if let Some(target) = pending_scrollback_target {
                app.scrollback_committed_until = target.min(app.messages.len());
            }
            let mut viewport_heights =
                app.inline_viewport_heights(size.width.max(1), height_budget);
            viewport_heights.base = viewport_heights
                .base
                .min(max_inline_viewport_height(height_budget));
            viewport_heights.expanded = viewport_heights
                .expanded
                .min(max_inline_viewport_height(height_budget));
            app.scrollback_committed_until = original_scrollback_committed_until;
            let viewport_needs_full_repaint =
                update_inline_viewport_for_draw(terminal, viewport_heights)?;
            let mut more_scrollback_to_flush =
                if !reflow_ran && let Some(prepared) = prepared_scrollback.take() {
                    flush_prepared_history_to_scrollback(terminal, app, prepared)?
                } else {
                    false
                };
            if !reflow_ran
                && !more_scrollback_to_flush
                && viewport_needs_full_repaint
                && let Some(prepared) = prepare_committed_history_for_scrollback(
                    app,
                    size.width.max(1),
                    terminal.viewport_area,
                    size.height.max(1),
                )
            {
                more_scrollback_to_flush =
                    flush_prepared_history_to_scrollback(terminal, app, prepared)?;
            }
            let force_viewport_redraw = app.take_force_viewport_redraw();
            if viewport_needs_full_repaint || resize_viewport_reset {
                terminal.invalidate_viewport();
            }
            if viewport_needs_full_repaint || force_viewport_redraw || resize_viewport_reset {
                // Physically clear the stale live surface and reset the
                // previous buffer. Ordinary forced redraws only need the
                // current viewport. A terminal resize invalidates the screen
                // coordinate system, but clearing from the top would erase the
                // transcript rows the terminal is still visibly showing above
                // the live composer. Clear only the live surface so resize
                // redraws remove stale composer/footer cells without turning
                // the readable scrollback area into a blank pane.
                //
                // A pure buffer-reset
                // (`invalidate_viewport`) makes the diff repaint every cell the
                // paragraph renders, but wide-char (CJK) tail columns left by a
                // previous frame's wider glyph are not always overwritten by a
                // Put at the same coordinate — the terminal keeps the stale
                // second column until it is explicitly cleared. Clearing the
                // physical region first guarantees those orphaned cells are
                // gone. The cost is a brief blank frame on terminals that do
                // not hide synchronized updates, but stale duplicate text is
                // the worse user-visible failure.
                let clear_top = terminal.viewport_area.top();
                terminal
                    .clear_after_position(Position::new(0, clear_top))
                    .context("failed to clear viewport before forced redraw")?;
            }
            if resize_viewport_reset {
                repaint_visible_scrollback_tail_after_resize(terminal, app, size.width.max(1))?;
            }
            app.sync_terminal_title(terminal.backend_mut())?;
            terminal
                .draw(|f| app.draw(f))
                .context("failed to draw KCoder TUI frame")?;
            Ok(reflow_ran || more_scrollback_to_flush || viewport_needs_full_repaint)
        })
        .context("failed to run synchronized terminal update")?
}

#[allow(clippy::too_many_arguments)]
async fn repl_loop(
    terminal: &mut Terminal<impl Backend + Write>,
    engine: &QueryEngine,
    app: &mut ReplApp,
    rx: &mut mpsc::Receiver<AppEvent>,
    tx: AppEventSender,
    terminal_guard: &mut TerminalGuard,
    terminal_events: TerminalEventController,
    frame_requester: FrameRequester,
    prompt: TuiPermissionPrompt,
) -> Result<()> {
    let mut redraw = true;
    loop {
        // Coalesce streaming output at 15 FPS and temporarily raise direct scrolling to
        // 30 FPS. Both paths remain throttled so high-frequency events cannot saturate the terminal queue.
        if redraw {
            if let Some(wait) = app.time_until_next_viewport_draw(Instant::now()) {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    event = rx.recv() => {
                        let event = event.context("event channel closed unexpectedly")?;
                        let handled =
                            handle_event_batch(event, app, engine, &tx, &prompt, rx).await;
                        redraw |= handled.redraw;
                        if handled.flush_frame {
                            app.frame_rate_limiter.reset();
                        }
                        if let Some(action) = handled.action {
                            if handle_user_action_with_terminal(
                                action,
                                engine,
                                app,
                                &tx,
                                &prompt,
                                terminal,
                                terminal_guard,
                                &terminal_events,
                                &frame_requester,
                            )
                            .await?
                            {
                                return Ok(());
                            }
                            redraw = true;
                        }
                        if app.time_until_next_viewport_draw(Instant::now()).is_some() {
                            continue;
                        }
                    }
                }
            }
            // Apply any accumulated mouse-wheel deltas before drawing so the
            // viewport reflects the latest scroll input.
            app.apply_pending_scroll();
            terminal_guard.sync_navigation_mouse(
                app.copy_view.is_some() || app.outline_open || app.navigation.inline,
            )?;
            let surface_mode = if terminal_guard.uses_alternate_screen() {
                TerminalSurfaceMode::Fullscreen
            } else {
                TerminalSurfaceMode::Inline
            };
            let more_scrollback_to_flush =
                draw_kcoder_frame_with_mode(terminal, app, surface_mode)?;
            app.frame_rate_limiter.mark_emitted(Instant::now());
            if app.needs_scheduled_frame_tick() {
                let delay = app.next_frame_tick_delay();
                if delay.is_zero() {
                    frame_requester.schedule_frame();
                } else {
                    frame_requester.schedule_frame_in(delay);
                }
            }
            redraw = more_scrollback_to_flush;
        }

        let event = rx
            .recv()
            .await
            .context("event channel closed unexpectedly")?;
        let handled = handle_event_batch(event, app, engine, &tx, &prompt, rx).await;
        redraw |= handled.redraw;
        if handled.flush_frame {
            app.frame_rate_limiter.reset();
        }

        if let Some(action) = handled.action {
            if handle_user_action_with_terminal(
                action,
                engine,
                app,
                &tx,
                &prompt,
                terminal,
                terminal_guard,
                &terminal_events,
                &frame_requester,
            )
            .await?
            {
                return Ok(());
            }
            redraw = true;
        }
    }
}

async fn handle_event_batch(
    event: AppEvent,
    app: &mut ReplApp,
    engine: &QueryEngine,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
    rx: &mut mpsc::Receiver<AppEvent>,
) -> HandledAppEvent {
    let started_at = Instant::now();
    let mut processed_events = 1usize;
    let mut handled = handle_app_event(event, app, engine, tx, prompt).await;

    // Coalesce rapid events into a single render pass. This keeps the UI
    // responsive during high-frequency streaming while still processing all
    // state updates. Stop as soon as a user action appears so command
    // execution and submissions keep their original ordering. Also stop after
    // a small event/time budget so an always-nonempty stream cannot starve the
    // renderer until the user resizes the terminal.
    while handled.action.is_none() && !handled.flush_frame {
        if event_batch_budget_exhausted(processed_events, started_at, Instant::now()) {
            break;
        }
        match rx.try_recv() {
            Ok(event) => {
                let next = handle_app_event(event, app, engine, tx, prompt).await;
                handled.merge(next);
                processed_events = processed_events.saturating_add(1);
            }
            Err(_) => break,
        }
    }

    handled
}

fn event_batch_budget_exhausted(
    processed_events: usize,
    started_at: Instant,
    now: Instant,
) -> bool {
    processed_events >= EVENT_BATCH_MAX_EVENTS
        || now.saturating_duration_since(started_at) >= EVENT_BATCH_MAX_DURATION
}

fn schedule_deferred_turn_wake(tx: &AppEventSender, delay: Duration) {
    let tx = tx.clone();
    tokio::spawn(async move {
        if delay.is_zero() {
            tokio::task::yield_now().await;
        } else {
            tokio::time::sleep(delay).await;
        }
        let _ = tx.send_ordered(AppEvent::TurnWakeRequested).await;
    });
}

fn turn_wake_delay_after_finish(engine: &QueryEngine, app: &ReplApp) -> Duration {
    if active_goal_for_continuation(engine)
        .is_some_and(|goal| !tui_goal_auto_continuation_limit_reached(engine, app, &goal))
        && app.queued_user_message_count() == 0
        && app.pending_background_followups.is_empty()
    {
        if engine.state.session_mode().is_orchestrate() {
            GOAL_CONTINUATION_COOLDOWN.max(Duration::from_secs(
                engine
                    .settings
                    .read()
                    .unwrap()
                    .orchestrate
                    .continuation
                    .cooldown_seconds,
            ))
        } else {
            GOAL_CONTINUATION_COOLDOWN
        }
    } else if engine.state.session_mode().is_orchestrate()
        && app.queued_user_message_count() == 0
        && app.pending_background_followups.is_empty()
        && kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd())
            .read_active_work()
            .is_ok_and(|snapshot| {
                let continuation =
                    kcoder_state::orchestrate_store::PlanStore::for_workspace(&engine.state.cwd())
                        .read_continuation_state(&snapshot.work.work_id)
                        .unwrap_or_default();
                snapshot.work.progress.completed < snapshot.work.progress.total
                    && !continuation.manual_intervention_required
            })
    {
        Duration::from_secs(
            engine
                .settings
                .read()
                .unwrap()
                .orchestrate
                .continuation
                .cooldown_seconds,
        )
    } else {
        Duration::ZERO
    }
}

fn has_nonterminal_background_subagents(engine: &QueryEngine) -> bool {
    engine.state.tasks().values().any(|task| {
        matches!(task.kind, kcoder_state::TaskKind::Subagent)
            && task.notify_parent_on_completion
            // `Paused` is deliberately excluded: a paused agent emits no
            // notification and is not recovered, so counting it would gate the
            // aggregate turn forever. When it later resumes and finishes, its
            // own completion notification wakes the parent. This matches the
            // app-server and headless gates.
            && matches!(task.status, TaskStatus::Pending | TaskStatus::Running)
    })
}

fn take_merged_background_followup(app: &mut ReplApp) -> Option<PendingBackgroundFollowup> {
    let mut ids = Vec::new();
    let mut events = Vec::new();
    while let Some(followup) = app.pending_background_followups.pop_front() {
        for (id, event) in followup.ids.into_iter().zip(followup.events) {
            if !ids.contains(&id) || id.is_empty() && !events.contains(&event) {
                ids.push(id);
                events.push(event);
            }
        }
    }
    if events.is_empty() {
        None
    } else {
        let summary = events.join(" ");
        Some(PendingBackgroundFollowup {
            ids,
            events,
            summary,
        })
    }
}

fn enqueue_background_followup(
    app: &mut ReplApp,
    ids: Vec<String>,
    events: Vec<String>,
    summary: String,
) {
    debug_assert_eq!(ids.len(), events.len());
    if let Some(pending) = app.pending_background_followups.back_mut() {
        for (id, event) in ids.into_iter().zip(events) {
            if !pending.ids.contains(&id) || id.is_empty() && !pending.events.contains(&event) {
                pending.ids.push(id);
                pending.events.push(event);
            }
        }
        pending.summary = pending.events.join(" ");
    } else {
        app.pending_background_followups
            .push_back(PendingBackgroundFollowup {
                ids,
                events,
                summary,
            });
    }
}

/// Outcome of attempting to start the next queued or follow-up turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartTurnOutcome {
    /// A new turn (or follow-up) was started.
    Started,
    /// Nothing to start; the REPL stays idle.
    Idle,
    /// A queued slash command requested shutdown (e.g. `/quit`).
    Quit,
}

impl StartTurnOutcome {
    #[cfg(test)]
    fn started(self) -> bool {
        matches!(self, StartTurnOutcome::Started)
    }
}

fn select_background_followup_batch(
    engine: &QueryEngine,
    app: &mut ReplApp,
    followup: PendingBackgroundFollowup,
) -> PendingBackgroundFollowup {
    let batch_for = |id: &str| {
        serde_json::from_str::<kcoder_types::BackgroundRunKey>(id)
            .ok()
            .and_then(|run| engine.state.background_run_record(&run))
            .and_then(|record| record.followup_turn_id)
    };
    let selected_batch = followup.ids.iter().find_map(|id| batch_for(id));
    let mut selected = PendingBackgroundFollowup {
        ids: Vec::new(),
        events: Vec::new(),
        summary: String::new(),
    };
    let mut remaining = PendingBackgroundFollowup {
        ids: Vec::new(),
        events: Vec::new(),
        summary: String::new(),
    };
    for (id, event) in followup.ids.into_iter().zip(followup.events) {
        let batch = if batch_for(&id) == selected_batch {
            &mut selected
        } else {
            &mut remaining
        };
        batch.ids.push(id);
        batch.events.push(event);
    }
    selected.summary = selected.events.join(" ");
    if !remaining.events.is_empty() {
        remaining.summary = remaining.events.join(" ");
        app.pending_background_followups.push_front(remaining);
    }
    selected
}

async fn prepare_background_followup(
    engine: &QueryEngine,
    ids: impl IntoIterator<Item = String>,
    nudge: String,
) -> Result<Option<(Vec<kcoder_types::BackgroundRunKey>, String)>> {
    let keys: Vec<kcoder_types::BackgroundRunKey> = ids
        .into_iter()
        .filter_map(|id| serde_json::from_str(&id).ok())
        .collect();
    if keys.is_empty() {
        engine.state.add_message(Message::user_text(nudge));
        return Ok(Some((keys, String::new())));
    }
    let records: Vec<_> = keys
        .iter()
        .filter_map(|key| engine.state.background_run_record(key))
        .collect();
    if records
        .iter()
        .any(|record| record.followup_started || record.followup_handled)
    {
        tracing::warn!("background follow-up was already started; automatic replay suppressed");
        return Ok(None);
    }
    let turn_id = records
        .iter()
        .find_map(|record| record.followup_turn_id.clone())
        .unwrap_or_else(|| format!("{}:followup", keys[0].run_id));
    if !engine.state.reserve_background_followup(&keys, &turn_id)? {
        return Ok(None);
    }
    engine
        .state
        .commit_message_with_uuid(Message::user_text(nudge), &turn_id)
        .await?;
    if !engine
        .state
        .mark_background_followup_started(&keys, &turn_id)?
    {
        return Ok(None);
    }
    Ok(Some((keys, turn_id)))
}

async fn try_start_next_turn(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<StartTurnOutcome> {
    if app.turn_lifecycle_in_progress() {
        return Ok(StartTurnOutcome::Idle);
    }

    loop {
        let next = app.rejected_turn_steers.front().or_else(|| app.user_message_queue.front());
        if next.is_some_and(|queued| queued.action == QueuedInputAction::Plain) {
            if let Err(error) = engine.prepare_client_model_for_turn(None, false) {
                let message = format!("Cannot prepare selected model; queued input was kept: {error}");
                if app.queued_model_error.as_deref() != Some(&message) {
                    app.queued_model_error = Some(message.clone());
                    let _ = tx.send(AppEvent::SystemNotice(message));
                }
                return Ok(StartTurnOutcome::Idle);
            }
        }
        app.queued_model_error = None;
        let Some(queued_input) = app.pop_user_message_for_turn() else { break; };
        match queued_input {
            QueuedTurnInput::User {
                model_message,
                display_message,
            } => {
                if let Err(error) = engine.acknowledge_orchestrate_user_input() {
                    let _ = tx.send(AppEvent::SystemNotice(format!(
                        "Orchestrate work could not acknowledge user input: {error:#}"
                    )));
                    return Ok(StartTurnOutcome::Idle);
                }
                let transcript_start = app.push_scheduled_user_message(&display_message);
                engine.state.add_message(model_message);
                app.frame_rate_limiter.reset();
                start_turn_with_transcript_start(engine, app, tx, prompt, Some(transcript_start));
                return Ok(StartTurnOutcome::Started);
            }
            QueuedTurnInput::Slash { command } => {
                if let Some(action) = handle_slash_command(&command, app, engine).await {
                    let should_quit =
                        Box::pin(handle_user_action(action, engine, app, tx, prompt)).await?;
                    if should_quit {
                        // Propagate the quit request (e.g. `/quit` typed while a
                        // turn was running) instead of swallowing it.
                        return Ok(StartTurnOutcome::Quit);
                    }
                }
                app.refresh_engine_metadata(engine);
                if app.turn_state.is_active() {
                    return Ok(StartTurnOutcome::Started);
                }
                continue;
            }
            QueuedTurnInput::Shell { command } => {
                if command.is_empty() {
                    app.push_user_shell_help();
                    continue;
                }
                start_user_shell_command(engine, app, tx, prompt, command);
                return Ok(StartTurnOutcome::Started);
            }
        }
    }

    // Completion notifications may arrive a few milliseconds apart. Keep
    // them queued while any parent-notifying background sub-agent is still
    // active, then start one aggregate turn with all terminal events.
    if !app.pending_background_followups.is_empty() && has_nonterminal_background_subagents(engine)
    {
        return Ok(StartTurnOutcome::Idle);
    }

    // Aggregating sub-agent results also starts an automatic goal turn and must
    // share the process allowance with regular goal continuations. A background
    // wakeup cannot bypass the limit.
    if !app.pending_background_followups.is_empty()
        && let Some(goal) = active_goal_for_automatic_turn(engine)
        && tui_goal_auto_continuation_limit_reached(engine, app, &goal)
    {
        emit_tui_goal_auto_continuation_limit_notice(engine, app, tx, &goal);
        return Ok(StartTurnOutcome::Idle);
    }

    if let Some(mut followup) = take_merged_background_followup(app) {
        followup.retain_followup_tasks(engine);
        let followup = select_background_followup_batch(engine, app, followup);
        // Every queued event may be invalidated (typically `close_agent`);
        // in that case skip the aggregate turn below and fall through to the
        // goal/orchestrate continuations instead of starting an empty turn.
        if !followup.events.is_empty() {
            let events = followup.events.clone();
            let summary = followup.summary.clone();
            let (idle_hook_events, stop_followup) = engine
                .run_teammate_idle_hooks(
                    "subagent_followup",
                    serde_json::json!({
                        "reason": "subagent_followup",
                        "events": events,
                        "summary": summary,
                        "cwd": engine.state.cwd(),
                    }),
                )
                .await;
            for event in idle_hook_events {
                if let EngineEvent::HookMessage { text, is_error } = event {
                    let _ = tx.send(AppEvent::SystemNotice(if is_error {
                        format!("[hook error] {}", text)
                    } else {
                        text
                    }));
                }
            }
            if stop_followup {
                return Ok(StartTurnOutcome::Idle);
            }

            let nudge = format!(
                "[system] All tracked background sub-agents have finished. Aggregate \
             their results now using the available `<subagent_notification .../>` \
             entries and output files. Events: {}. Continue the original task, \
             do not repeat work already delegated to a sub-agent, and do not give \
             a final conclusion until the relevant results have been inspected.",
                summary
            );
            let Some(batch) = prepare_background_followup(engine, followup.ids, nudge).await?
            else {
                return Ok(StartTurnOutcome::Idle);
            };
            app.active_background_followup = Some(batch);
            if let Some(goal) = active_goal_for_automatic_turn(engine) {
                record_tui_goal_auto_continuation_start(engine, app, &goal);
            }
            start_turn(engine, app, tx, prompt);
            return Ok(StartTurnOutcome::Started);
        }
    }

    if try_start_goal_continuation(engine, app, tx, prompt) {
        return Ok(StartTurnOutcome::Started);
    }

    match engine.claim_orchestrate_idle_continuation(
        kcoder_engine::orchestrate::continuation::IdleRequest {
            pending_question: app.pending_question.is_some(),
            cooldown_elapsed: true,
            goal_limit_reached: active_goal_for_automatic_turn(engine)
                .is_some_and(|goal| tui_goal_auto_continuation_limit_reached(engine, app, &goal)),
            ..Default::default()
        },
    ) {
        Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::Enqueued {
            prompt: nudge,
        }) => {
            engine.state.add_message(Message::user_text(nudge));
            start_turn(engine, app, tx, prompt);
            return Ok(StartTurnOutcome::Started);
        }
        Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
            reason,
            notify_once: true,
        }) => {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Orchestrate automatic continuation stopped ({reason}); the work remains active and requires user review."
            )));
        }
        Ok(_) => {}
        Err(error) => {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Orchestrate continuation could not be prepared: {error:#}"
            )));
        }
    }

    Ok(StartTurnOutcome::Idle)
}

fn active_goal_for_continuation(engine: &QueryEngine) -> Option<Goal> {
    let goal = engine.state.goal()?;
    let final_text =
        kcoder_engine::goal_continuation::latest_assistant_text(&engine.state.messages());
    kcoder_engine::goal_continuation::plan_goal_continuation(
        engine.settings.read().unwrap().goal_enabled,
        &goal,
        final_text.as_deref(),
    )
    .map(|_| goal)
}

fn active_goal_for_automatic_turn(engine: &QueryEngine) -> Option<Goal> {
    engine.state.goal().filter(|goal| goal.status.is_active())
}

fn tui_goal_auto_continuation_limit_reached(
    engine: &QueryEngine,
    app: &ReplApp,
    goal: &Goal,
) -> bool {
    let limit = engine.settings.read().unwrap().goal_max_auto_continuations;
    let started = app
        .goal_auto_continuations_started
        .get(&goal.goal_id)
        .copied()
        .unwrap_or(0);
    kcoder_engine::goal_continuation::auto_continuation_limit_reached(limit, started)
}

#[cfg(unix)]
const GOAL_AUTO_CONTINUATION_MARKER_FD_ENV: &str = "KCODER_GOAL_AUTO_CONTINUATION_MARKER_FD";

fn goal_auto_continuation_notice_marker() -> String {
    #[cfg(unix)]
    {
        let descriptor = std::env::var(GOAL_AUTO_CONTINUATION_MARKER_FD_ENV)
            .ok()
            .and_then(|value| value.parse::<i32>().ok())
            .filter(|descriptor| *descriptor > libc::STDERR_FILENO);
        if let Some(descriptor) = descriptor {
            return goal_auto_continuation_notice_marker_from_fd(descriptor);
        }
    }
    format_goal_auto_continuation_notice_marker(None)
}

#[cfg(unix)]
fn goal_auto_continuation_notice_marker_from_fd(descriptor: i32) -> String {
    use std::os::fd::FromRawFd;

    // The harness explicitly inherits the descriptor through pass_fds. Take ownership
    // during TUI construction and close it immediately. Nonblocking reads ensure a forged
    // or damaged environment value cannot stall startup.
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(descriptor, metadata.as_mut_ptr()) } < 0 {
        return format_goal_auto_continuation_notice_marker(None);
    }
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return format_goal_auto_continuation_notice_marker(None);
    }
    // Duplicate before constructing File so this function exclusively owns a valid value passed to FromRawFd.
    let owned_descriptor = unsafe { libc::fcntl(descriptor, libc::F_DUPFD_CLOEXEC, 3) };
    if owned_descriptor < 0 {
        return format_goal_auto_continuation_notice_marker(None);
    }
    let _ = unsafe { libc::close(descriptor) };
    let mut file = unsafe { std::fs::File::from_raw_fd(owned_descriptor) };
    let flags = unsafe { libc::fcntl(owned_descriptor, libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(owned_descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return format_goal_auto_continuation_notice_marker(None);
    }
    let mut token = Vec::with_capacity(65);
    while token.len() < 65 {
        let mut chunk = [0_u8; 65];
        match file.read(&mut chunk[..65 - token.len()]) {
            Ok(0) => break,
            Ok(read) => token.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(_) => return format_goal_auto_continuation_notice_marker(None),
        }
    }
    let token = String::from_utf8(token).ok();
    format_goal_auto_continuation_notice_marker(token.as_deref())
}

fn format_goal_auto_continuation_notice_marker(token: Option<&str>) -> String {
    let token = token.filter(|token| {
        !token.is_empty()
            && token.len() <= 64
            && token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    });
    match token {
        Some(token) => format!("[goal_auto_continuation_limit:{token}]"),
        None => "[goal_auto_continuation_limit]".to_string(),
    }
}

fn emit_tui_goal_auto_continuation_limit_notice(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    goal: &Goal,
) {
    if app
        .goal_auto_continuation_limit_notices
        .contains(&goal.goal_id)
    {
        return;
    }
    let limit = engine.settings.read().unwrap().goal_max_auto_continuations;
    let marker = &app.goal_auto_continuation_notice_marker;
    if tx.send(AppEvent::SystemNotice(format!(
        "{marker} Goal auto-continuation limit reached ({limit}); goal remains active. Send a new instruction, clear the goal, or restart the process after reviewing its current state."
    ))) {
        app.goal_auto_continuation_limit_notices
            .insert(goal.goal_id.clone());
    }
}

fn record_tui_goal_auto_continuation_start(
    engine: &QueryEngine,
    app: &mut ReplApp,
    goal: &Goal,
) -> Goal {
    let goal = engine
        .state
        .record_goal_turn_start(&goal.goal_id)
        .unwrap_or_else(|| goal.clone());
    *app.goal_auto_continuations_started
        .entry(goal.goal_id.clone())
        .or_default() += 1;
    app.goal_auto_continuation_limit_notices
        .remove(&goal.goal_id);
    goal
}

fn try_start_goal_continuation(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> bool {
    let Some(goal) = active_goal_for_continuation(engine) else {
        return false;
    };
    if tui_goal_auto_continuation_limit_reached(engine, app, &goal) {
        emit_tui_goal_auto_continuation_limit_notice(engine, app, tx, &goal);
        return false;
    }
    let final_text =
        kcoder_engine::goal_continuation::latest_assistant_text(&engine.state.messages());
    let Some(decision) = kcoder_engine::goal_continuation::plan_goal_continuation(
        true,
        &goal,
        final_text.as_deref(),
    ) else {
        return false;
    };
    if engine.state.session_mode().is_orchestrate() {
        match engine.claim_orchestrate_idle_continuation(
            kcoder_engine::orchestrate::continuation::IdleRequest {
                pending_question: app.pending_question.is_some(),
                cooldown_elapsed: true,
                ..Default::default()
            },
        ) {
            Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::Enqueued {
                ..
            })
            | Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::NotApplicable)
            | Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
                reason: "no_incomplete_active_work",
                ..
            }) => {}
            Ok(kcoder_engine::orchestrate::continuation::ClaimedContinuation::StayIdle {
                reason,
                notify_once,
            }) => {
                if notify_once {
                    let _ = tx.send(AppEvent::SystemNotice(format!(
                        "Orchestrate automatic continuation stopped ({reason}); the goal and work remain active for user review."
                    )));
                }
                return false;
            }
            Err(error) => {
                let _ = tx.send(AppEvent::SystemNotice(format!(
                    "Orchestrate continuation state could not be claimed: {error:#}"
                )));
                return false;
            }
        }
    }
    let goal = record_tui_goal_auto_continuation_start(engine, app, &goal);
    engine.state.add_message(Message::user_text(
        kcoder_engine::goal_continuation::format_goal_continuation_prompt(&goal, &decision),
    ));
    start_turn(engine, app, tx, prompt);
    true
}

fn start_turn(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) {
    start_turn_with_transcript_start(engine, app, tx, prompt, None);
}

fn start_turn_with_transcript_start(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
    transcript_start: Option<usize>,
) {
    let cancel = CancellationToken::new();
    let steer_session = engine.begin_turn_steering();
    let path_preview_generation = app.path_previews.next_generation();
    let handle = spawn_turn(
        engine.clone(),
        None,
        tx.clone(),
        prompt.clone(),
        cancel.clone(),
        steer_session,
        path_preview_generation,
        app.active_background_followup.take(),
    );
    app.begin_turn_with_transcript_start(handle, cancel, transcript_start);
}

fn start_user_shell_command(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
    command: String,
) {
    let cancel = CancellationToken::new();
    let handle = spawn_user_shell_command(
        engine.clone(),
        command,
        tx.clone(),
        prompt.clone(),
        cancel.clone(),
    );
    app.begin_turn(handle, cancel);
}

fn start_manual_compaction(engine: &QueryEngine, app: &mut ReplApp, tx: &AppEventSender) {
    let cancel = CancellationToken::new();
    let handle = spawn_manual_compaction(engine.clone(), tx.clone(), cancel.clone());
    app.foreground_operation_label = Some("Compacting context".to_string());
    app.begin_turn(handle, cancel);
}

fn start_moa_plan(engine: &QueryEngine, app: &mut ReplApp, tx: &AppEventSender, request: String) {
    let cancel = CancellationToken::new();
    let operation_engine = engine.clone().with_cancel_token(cancel.clone());
    let operation_tx = tx.clone();
    let progress_tx = tx.clone();
    let visible_request = request.clone();
    let handle = tokio::spawn(async move {
        let _ = operation_tx.send_ordered(AppEvent::TurnStarted).await;
        let _ = operation_tx
            .send_ordered(AppEvent::SystemNotice(
                "MoA plan: running independent planners; final synthesis will start after all planners settle."
                    .to_string(),
            ))
            .await;
        let progress = Arc::new(move |update: kcoder_engine::MoaPlanProgress| {
            progress_tx.send(AppEvent::MoaPlanProgress {
                message: update.message,
                completed: update.completed,
                total: update.total,
            });
        });
        let event = match operation_engine
            .run_moa_plan_with_progress(&request, progress)
            .await
        {
            Ok(result) => AppEvent::MoaPlanFinished {
                final_path: result.final_path,
                draft_count: result.draft_paths.len(),
                failed_count: result.failed_planners.len(),
            },
            Err(error) => AppEvent::MoaPlanFailed {
                error: error.to_string(),
            },
        };
        let _ = operation_tx.send_ordered(event).await;
        let _ = operation_tx.send_ordered(AppEvent::TurnFinished).await;
    });
    app.push_message(MessageRole::User, visible_request);
    app.foreground_operation_label = Some("Building MoA plan".to_string());
    app.begin_turn(handle, cancel);
}

fn start_side_question(
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    question: String,
) {
    let Some((id, cancel)) = app.open_side_question(question.clone()) else {
        app.push_message(
            MessageRole::System,
            "Close the active dialog before opening /btw.",
        );
        return;
    };
    let engine = engine.clone();
    let tx = tx.clone();
    tokio::spawn(async move {
        let event = match engine.run_side_question(&question, cancel).await {
            Ok(answer) => AppEvent::SideQuestionCompleted { id, answer },
            Err(error) => AppEvent::SideQuestionFailed {
                id,
                error: error.to_string(),
            },
        };
        let _ = tx.send_ordered(event).await;
    });
}

fn spawn_manual_compaction(
    engine: QueryEngine,
    tx: AppEventSender,
    cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut completion = TurnCompletionGuard::new(tx.clone());
        if !tx.send_ordered(AppEvent::TurnStarted).await {
            return;
        }

        let event = tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            result = engine.compact_conversation() => Some(match result {
                Ok(result) => AppEvent::ManualCompactionFinished {
                    did_compact: result.did_compact,
                    pre_compact_tokens: result.pre_compact_tokens,
                    post_compact_tokens: result.post_compact_tokens,
                },
                Err(error) => AppEvent::ManualCompactionFailed {
                    error: error.to_string(),
                },
            }),
        };

        if let Some(event) = event {
            let _ = tx.send_ordered(event).await;
        }
        completion.finish_ordered().await;
    })
}

fn spawn_user_shell_command(
    engine: QueryEngine,
    command: String,
    tx: AppEventSender,
    prompt: TuiPermissionPrompt,
    turn_cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut completion = TurnCompletionGuard::new(tx.clone());
        let _ = tx.send_ordered(AppEvent::TurnStarted).await;
        let events = engine
            .run_user_shell_command(command, &prompt, turn_cancel)
            .await;
        for event in events {
            append_repl_engine_event_diagnostic(&engine, &event);
            let Some(app_event) = engine_event_to_app_event_for_generation(event, 0) else {
                continue;
            };
            if !tx.send_ordered(app_event).await {
                break;
            }
        }
        completion.finish_ordered().await;
    })
}

fn await_turn_task_for_logging(handle: JoinHandle<()>) {
    tokio::spawn(async move {
        match handle.await {
            Err(error) if !error.is_cancelled() => {
                warn!(%error, "turn task failed");
            }
            _ => {}
        }
    });
}

fn complete_finished_turn(
    app: &mut ReplApp,
    engine: &QueryEngine,
    tx: &AppEventSender,
    handle: Option<JoinHandle<()>>,
) -> HandledAppEvent {
    app.flush_active_turn();
    app.consolidate_finished_assistant_stream();
    app.set_loading(false);
    // Reset the row-count baseline so the next `draw()` recomputes
    // `row_budget` from a clean state. After consolidation the merged
    // assistant message can be far taller than the previous frame's
    // `last_line_count`, and a stale value would shrink the render
    // budget and miscompute the scroll offset. Unconditional because
    // scrolled-away users also need a recompute (they just keep their
    // pinned offset via `snap_to_bottom` being guarded below).
    app.transcript_viewport.invalidate_content_layout();
    if let Some(divider) = app.finish_turn_separator_text() {
        app.push_message(MessageRole::System, divider);
    }
    app.refresh_engine_metadata(engine);
    if app.transcript_viewport.is_at_tail() {
        app.snap_to_bottom();
    }
    // Force a full viewport repaint on the next draw. This is set
    // AFTER all message mutations (flush, consolidation, divider push,
    // metadata refresh) so the invalidated previous-buffer diff sees
    // the final transcript state. Without this, ratatui's cell-level
    // diff leaves stale rows when content shifts (e.g. the active-turn
    // lines disappearing into committed messages), producing visible
    // duplicated text until the user scrolls or resizes. Unconditional
    // so scrolled-away users also get a clean repaint of the shifted
    // window.
    app.force_next_viewport_redraw();
    if let Some(handle) = handle {
        await_turn_task_for_logging(handle);
    }
    schedule_deferred_turn_wake(tx, turn_wake_delay_after_finish(engine, app));
    HandledAppEvent::redraw()
}

#[allow(clippy::too_many_arguments)]
async fn handle_user_action_with_terminal<B: Backend + Write>(
    action: UserAction,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
    terminal: &mut Terminal<B>,
    terminal_guard: &mut TerminalGuard,
    terminal_events: &TerminalEventController,
    frame_requester: &FrameRequester,
) -> Result<bool> {
    match action {
        UserAction::Suspend => {
            suspend_tui_with_restored_terminal(
                terminal,
                terminal_guard,
                terminal_events,
                app,
                frame_requester,
            )
            .await?;
            Ok(false)
        }
        UserAction::OpenExternalEditor => {
            app.open_external_editor_with_restored_terminal(
                terminal,
                terminal_guard,
                terminal_events,
                frame_requester,
            )
            .await?;
            Ok(false)
        }
        UserAction::Quit => {
            draw_shutdown_feedback(terminal, app, terminal_guard)?;
            handle_user_action(UserAction::Quit, engine, app, tx, prompt).await
        }
        action => {
            let should_quit = handle_user_action(action, engine, app, tx, prompt).await?;
            if should_quit {
                draw_shutdown_feedback(terminal, app, terminal_guard)?;
            }
            Ok(should_quit)
        }
    }
}

#[cfg(unix)]
async fn suspend_tui_with_restored_terminal<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    terminal_guard: &mut TerminalGuard,
    terminal_events: &TerminalEventController,
    app: &mut ReplApp,
    frame_requester: &FrameRequester,
) -> Result<()> {
    terminal_events.pause().await;
    let result = suspend_tui_inner(terminal, terminal_guard, app, frame_requester);
    flush_terminal_input_buffer();
    terminal_events.resume();
    result
}

#[cfg(unix)]
fn suspend_tui_inner<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    terminal_guard: &mut TerminalGuard,
    app: &mut ReplApp,
    frame_requester: &FrameRequester,
) -> Result<()> {
    let suspend_cursor_y = terminal.viewport_area.y;
    terminal
        .reset_cursor_style()
        .context("failed to reset cursor style before suspend")?;
    let _ = terminal.show_cursor();
    std::io::Write::flush(terminal.backend_mut()).context("failed to flush before suspend")?;

    let restored_state = terminal_guard.restore_for_suspend();
    let restored_alternate_screen = restored_state.alternate_screen_enabled();
    crossterm::execute!(
        std::io::stdout(),
        crossterm::cursor::MoveTo(0, suspend_cursor_y),
        crossterm::cursor::Show
    )
    .context("failed to position cursor before suspend")?;

    let suspend_result = terminal_modes::suspend_current_process();
    let reenter_result = terminal_guard
        .reenter_after_external_program(restored_state)
        .and_then(|_| terminal_modes::reapply_raw_mode_after_resume())
        .context("failed to re-enter KCoder terminal after suspend");

    if restored_alternate_screen {
        if let Ok(size) = terminal.size() {
            terminal.set_viewport_area(Rect::new(0, 0, size.width.max(1), size.height.max(1)));
        }
        terminal.clear().context("failed to clear after suspend")?;
    } else if let Ok(Some(position)) =
        terminal_probe::cursor_position(terminal_probe::DEFAULT_TIMEOUT)
    {
        terminal.set_viewport_area(Rect::new(0, position.y, 0, 0));
    } else {
        terminal.set_viewport_area(Rect::new(0, suspend_cursor_y, 0, 0));
    }

    terminal.invalidate_viewport();
    app.force_next_viewport_redraw();
    frame_requester.schedule_frame();
    suspend_result.and(reenter_result)
}

#[cfg(not(unix))]
async fn suspend_tui_with_restored_terminal<B: Backend + Write>(
    _terminal: &mut Terminal<B>,
    _terminal_guard: &mut TerminalGuard,
    _terminal_events: &TerminalEventController,
    app: &mut ReplApp,
    _frame_requester: &FrameRequester,
) -> Result<()> {
    app.push_message(
        MessageRole::System,
        "Suspend is not supported on this platform.",
    );
    Ok(())
}

fn draw_shutdown_feedback<B: Backend + Write>(
    terminal: &mut Terminal<B>,
    app: &mut ReplApp,
    terminal_guard: &TerminalGuard,
) -> Result<()> {
    app.show_shutdown_in_progress();
    let surface_mode = if terminal_guard.uses_alternate_screen() {
        TerminalSurfaceMode::Fullscreen
    } else {
        TerminalSurfaceMode::Inline
    };
    draw_kcoder_frame_with_mode(terminal, app, surface_mode).map(|_| ())
}

async fn handle_submitted_message(
    submitted: SubmittedMessage,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<bool> {
    // Run submit hooks immediately, but defer writing the message into
    // engine state until its turn is scheduled. That preserves
    // provider-required tool_use/tool_result adjacency while still
    // letting the UI show queued input right away.
    if !submitted.images.is_empty() && !engine.model_supports_vision() {
        let _ = tx.send(AppEvent::SystemNotice(format!(
            "[image input blocked] Model '{}' was auto-discovered as text-only. Add an explicit provider profile with vision capability to enable images.",
            engine.model_name()
        )));
        return Ok(false);
    }
    let text = submitted.text.clone();
    let (hook_events, modified_text, blocking_error) =
        engine.run_user_prompt_submit_hooks(&text).await;
    for ev in hook_events {
        if let EngineEvent::HookMessage { text, is_error } = ev {
            let _ = tx.send(AppEvent::SystemNotice(if is_error {
                format!("[hook error] {}", text)
            } else {
                format!("[hook] {}", text)
            }));
        }
    }
    if let Some(error) = blocking_error {
        let _ = tx.send(AppEvent::SystemNotice(format!("[hook blocked] {}", error)));
        return Ok(false);
    }
    let effective_text = modified_text.unwrap_or(text.clone());
    let model_message = match submitted.to_model_message(effective_text) {
        Ok(message) => message,
        Err(error) => {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "[image input error] {}",
                error
            )));
            return Ok(false);
        }
    };
    let queued = QueuedUserMessage::from_submitted(model_message, &submitted);
    if app.turn_lifecycle_in_progress() {
        if app.pending_input_count() >= USER_MESSAGE_QUEUE_MAX {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
            )));
            return Ok(false);
        }

        let steer_id = app.next_turn_steer_id();
        match engine.enqueue_turn_steer(steer_id, queued.model_message.clone()) {
            Ok(()) => {
                app.track_pending_turn_steer(steer_id, queued);
                return Ok(false);
            }
            Err(TurnSteerError::NoActiveTurn) => {
                // Manual compaction, foreground shells, and shutdown races are not steerable;
                // retain the input as a regular request for the next turn.
            }
            Err(TurnSteerError::QueueFull { max }) => {
                let _ = tx.send(AppEvent::SystemNotice(format!(
                    "Turn steer queue is full ({max} pending). Wait for the next model boundary."
                )));
                return Ok(false);
            }
        }
    }

    // Input submitted while idle, or rejected by a non-steerable foreground
    // operation, retains next-turn queue semantics.
    if !app.enqueue_user_message_for_turn(queued) {
        let _ = tx.send(AppEvent::SystemNotice(format!(
            "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
        )));
        return Ok(false);
    }

    let outcome = try_start_next_turn(engine, app, tx, prompt).await?;
    Ok(matches!(outcome, StartTurnOutcome::Quit))
}

async fn handle_agent_view_submitted_message(
    submitted: SubmittedMessage,
    agent_id: &str,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
) -> Result<bool> {
    if !submitted.images.is_empty() || !submitted.remote_image_urls.is_empty() {
        let _ = tx.send(AppEvent::SystemNotice(
            "Agent steering currently accepts text only; attachments were not sent.".to_string(),
        ));
        return Ok(false);
    }
    let message = expand_pending_pastes(&submitted.text, &submitted.pending_pastes);
    if message.trim().is_empty() {
        let _ = tx.send(AppEvent::SystemNotice(
            "Agent steering message must not be empty.".to_string(),
        ));
        return Ok(false);
    }
    match engine.steer_subagent(agent_id, message.trim()).await {
        Ok(receipt) => {
            let status = receipt.status.as_str();
            if receipt.queued {
                let queue_position = receipt.queue_position.unwrap_or(1);
                if let Some(message_id) = receipt.message_id.as_deref() {
                    app.queue_subagent_steer_in_panel(agent_id, message_id, queue_position);
                    app.queue_agent_view_steer(agent_id, message_id, message.trim());
                }
                app.set_agent_view_steer_status(agent_id, format!("Steering queued ({status})"));
                app.set_transient_status(format!(
                    "Sending to {agent_id}: {status}, position {queue_position}"
                ));
            } else {
                let _ = tx.send(AppEvent::SystemNotice(format!(
                    "Could not steer {agent_id} ({status}): {}",
                    truncate_display_text(&receipt.next_action, 320)
                )));
            }
        }
        Err(error) => {
            let _ = tx.send(AppEvent::SystemNotice(format!(
                "Could not steer {agent_id}: {error}"
            )));
        }
    }
    Ok(false)
}

pub(crate) fn resume_session_from_history_path(
    path: &Path,
    engine: &QueryEngine,
    app: &mut ReplApp,
) {
    if !path.exists() {
        app.push_message(
            MessageRole::System,
            format!("Session history not found: {}", path.display()),
        );
        return;
    }

    let mut prepared_resume = match kcoder_state::prepare_session_resume(path) {
        Ok(value) => value,
        Err(error) => {
            app.push_message(
                MessageRole::System,
                format!("Failed to preflight session: {}", error),
            );
            return;
        }
    };
    if !prepared_resume.has_persisted_cwd()
        && !history_path_belongs_to_current_project(path, &engine.state.base_cwd())
    {
        app.push_message(
                MessageRole::System,
                format!(
                    "Session {} does not include working-directory metadata. To avoid running tools in the wrong project, start KCoder from that session's original directory and resume it there.",
                    path.display()
                ),
            );
        return;
    }

    if let Some(base_cwd) = prepared_resume.persisted_base_cwd()
        && !same_directory(base_cwd, &engine.cwd)
    {
        app.push_message(
            MessageRole::System,
            format!(
                "Session {} belongs to {}. Start KCoder from that directory before resuming it; this engine's tools, sandbox, skills, hooks, and memory are bound to {}.",
                path.display(),
                base_cwd.display(),
                engine.cwd.display(),
            ),
        );
        return;
    }

    let transcript_history = prepared_resume.take_transcript_history();
    let visible_count = transcript_history.len();
    let defer_earlier_transcript =
        app.fullscreen_surface && visible_count > RESUME_TRANSCRIPT_INITIAL_MESSAGES;
    let (loaded_start, visible_messages) = if defer_earlier_transcript {
        match transcript_history.load_tail(RESUME_TRANSCRIPT_INITIAL_MESSAGES) {
            Ok(tail) => tail,
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to load resumed transcript tail: {error}"),
                );
                return;
            }
        }
    } else {
        match transcript_history.load_all() {
            Ok(messages) => (0, messages),
            Err(error) => {
                app.push_message(
                    MessageRole::System,
                    format!("Failed to load resumed transcript: {error}"),
                );
                return;
            }
        }
    };

    match engine.apply_prepared_session_resume(prepared_resume) {
        Ok(_count) => {
            app.refresh_engine_metadata(engine);
            if defer_earlier_transcript {
                app.replace_transcript_from_resumed_tail(
                    &visible_messages,
                    transcript_history,
                    loaded_start,
                );
            } else {
                app.replace_transcript_from_history(&visible_messages);
            }
            app.reconcile_subagent_panels_from_engine(engine);
            app.push_message(
                MessageRole::System,
                format!(
                    "Resumed session from {} ({} messages).",
                    path.display(),
                    visible_count
                ),
            );
            app.snap_to_bottom();
        }
        Err(e) => {
            app.push_message(
                MessageRole::System,
                format!("Failed to resume session: {}", e),
            );
        }
    }
}

fn same_directory(left: &Path, right: &Path) -> bool {
    let left = left.canonicalize().unwrap_or_else(|_| left.to_path_buf());
    let right = right.canonicalize().unwrap_or_else(|_| right.to_path_buf());
    left == right
}

fn history_path_belongs_to_current_project(path: &Path, cwd: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(project_dirs) = Settings::project_data_dirs_for_read(cwd) else {
        return false;
    };
    project_dirs.iter().any(|dir| parent == dir)
}

async fn handle_user_action(
    action: UserAction,
    engine: &QueryEngine,
    app: &mut ReplApp,
    tx: &AppEventSender,
    prompt: &TuiPermissionPrompt,
) -> Result<bool> {
    match action {
        UserAction::Quit => {
            if let Some(handle) = app.abort_turn_for_shutdown() {
                match handle.await {
                    Err(error) if !error.is_cancelled() => {
                        warn!(%error, "turn task failed during shutdown");
                    }
                    _ => {}
                }
            }
            Ok(true)
        }
        UserAction::Suspend => Ok(false),
        UserAction::Submit(submitted) => {
            if let Some(agent_id) = app.viewed_agent_id().map(str::to_string) {
                handle_agent_view_submitted_message(submitted, &agent_id, engine, app, tx).await
            } else {
                handle_submitted_message(submitted, engine, app, tx, prompt).await
            }
        }
        UserAction::RunShellCommand {
            command,
            history_text,
        } => {
            if app.has_interruptible_turn() {
                if !app.enqueue_user_message_for_turn(QueuedUserMessage::from_shell_prompt(
                    history_text,
                )) {
                    let _ = tx.send(AppEvent::SystemNotice(format!(
                        "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
                    )));
                }
                return Ok(false);
            }
            if command.is_empty() {
                app.push_user_shell_help();
                let outcome = try_start_next_turn(engine, app, tx, prompt).await?;
                return Ok(matches!(outcome, StartTurnOutcome::Quit));
            }
            start_user_shell_command(engine, app, tx, prompt, command);
            Ok(false)
        }
        UserAction::SlashCommand(command) => {
            let (slash_name, _) = parse_slash_input(&command);
            let is_side_question = slash_name.eq_ignore_ascii_case("/btw");
            let is_immediate_control = matches!(
                slash_name.to_ascii_lowercase().as_str(),
                "/agent" | "/stop" | "/clean" | "/outline" | "/jump"
            );
            if app.has_interruptible_turn() && !is_side_question && !is_immediate_control {
                if !app
                    .enqueue_user_message_for_turn(QueuedUserMessage::from_slash_command(command))
                {
                    let _ = tx.send(AppEvent::SystemNotice(format!(
                        "Input queue is full ({USER_MESSAGE_QUEUE_MAX} pending). Use /queue clear to discard queued prompts."
                    )));
                }
                return Ok(false);
            }
            match handle_slash_command(&command, app, engine).await {
                Some(UserAction::Quit) => return Ok(true),
                Some(UserAction::Submit(submitted)) => {
                    handle_submitted_message(submitted, engine, app, tx, prompt).await?;
                }
                Some(UserAction::CompactConversation) => {
                    start_manual_compaction(engine, app, tx);
                }
                Some(UserAction::StartSideQuestion(question)) => {
                    start_side_question(engine, app, tx, question);
                }
                Some(UserAction::StartMoaPlan(request)) => {
                    start_moa_plan(engine, app, tx, request);
                }
                _ => {}
            }
            app.refresh_engine_metadata(engine);
            Ok(false)
        }
        UserAction::CompactConversation => {
            start_manual_compaction(engine, app, tx);
            Ok(false)
        }
        UserAction::StartSideQuestion(question) => {
            start_side_question(engine, app, tx, question);
            Ok(false)
        }
        UserAction::StartMoaPlan(request) => {
            start_moa_plan(engine, app, tx, request);
            Ok(false)
        }
        UserAction::ResumeSession(path) => {
            resume_session_from_history_path(&path, engine, app);
            Ok(false)
        }
        UserAction::ConfirmGoalReplacement {
            objective,
            token_budget,
            mode,
            verification_kind,
        } => {
            match prepare_goal_objective(engine.state.cwd(), objective.trim()) {
                Ok(prepared) => {
                    let context_snapshot =
                        kcoder_state::goal_context_snapshot(&engine.state.messages());
                    let verifier_selection = if mode.is_strict() {
                        goal_pro_verifier_selection(engine)
                    } else {
                        GoalVerifierSelection::default()
                    };
                    let goal = match engine
                        .state
                        .set_goal_prepared_with_mode_and_verification_and_verifier(
                            prepared.objective.clone(),
                            prepared.objective_file.clone(),
                            token_budget,
                            mode,
                            verification_kind,
                            verifier_selection,
                        ) {
                        Ok(goal) => goal,
                        Err(error) => {
                            app.push_message(
                                MessageRole::System,
                                format!("Failed to replace goal: {error:#}"),
                            );
                            return Ok(false);
                        }
                    };
                    let goal = if mode.is_strict() {
                        engine
                            .state
                            .set_goal_context_snapshot(context_snapshot)
                            .unwrap_or(goal)
                    } else {
                        goal
                    };
                    let goal = if mode.is_strict() {
                        match kcoder_engine::agent::ensure_goal_pro_workspace_baseline(
                            &engine.state,
                            &goal,
                        )
                        .await
                        {
                            Ok(goal) => goal,
                            Err(error) => {
                                engine.state.clear_goal();
                                app.push_message(
                                    MessageRole::System,
                                    format!(
                                        "Failed to capture the replacement Goal Pro verifier baseline; the replacement goal was cleared: {error}"
                                    ),
                                );
                                return Ok(false);
                            }
                        }
                    } else {
                        goal
                    };
                    let materialized = prepared
                        .objective_file
                        .as_ref()
                        .map(|path| format!(" Objective saved to {}.", path.display()))
                        .unwrap_or_default();
                    app.refresh_engine_metadata(engine);
                    app.push_message(
                        MessageRole::System,
                        format!(
                            "{} replaced{} Active objective: {}",
                            if mode.is_arrangement() {
                                "UltGoal"
                            } else if mode.is_strict() {
                                "Goal Pro"
                            } else {
                                "Goal"
                            },
                            materialized,
                            truncate_display_text(&goal.objective, 120)
                        ),
                    );
                }
                Err(error) => {
                    app.push_message(
                        MessageRole::System,
                        format!("Failed to prepare goal objective: {error:#}"),
                    );
                }
            }
            Ok(false)
        }
        UserAction::ClearUi => {
            app.clear_conversation_ui(engine);
            Ok(false)
        }
        UserAction::CopyLastResponse => {
            app.copy_last_assistant_response();
            Ok(false)
        }
        UserAction::PasteClipboardImage => {
            if app.clipboard_image_paste_in_flight {
                app.set_transient_status("Clipboard image paste is already in progress");
                return Ok(false);
            }
            app.clipboard_image_paste_in_flight = true;
            app.set_transient_status("Reading image from clipboard…");
            let tx = tx.clone();
            tokio::spawn(async move {
                let event = match tokio::task::spawn_blocking(clipboard_image::read_clipboard_image)
                    .await
                {
                    Ok(Ok(image)) => AppEvent::ClipboardImageReady(image),
                    Ok(Err(error)) => AppEvent::ClipboardImageFailed(error.to_string()),
                    Err(error) => AppEvent::ClipboardImageFailed(format!(
                        "clipboard image worker failed: {error}"
                    )),
                };
                let _ = tx.send_ordered(event).await;
            });
            Ok(false)
        }
        UserAction::OpenExternalEditor => {
            app.open_external_editor().await;
            Ok(false)
        }
        UserAction::EditPreviousMessage => {
            app.edit_previous_message(engine);
            Ok(false)
        }
        UserAction::ToggleRawOutput => {
            app.set_raw_output_mode(!app.raw_output_mode());
            Ok(false)
        }
        UserAction::AdjustReasoning(direction) => {
            app.adjust_reasoning_effort(engine, direction);
            Ok(false)
        }
        UserAction::CompleteDeferredTurn => {
            let handle = app.take_deferred_turn_finish_handle();
            complete_finished_turn(app, engine, tx, handle);
            Ok(false)
        }
        UserAction::Interrupt => {
            if let Some(goal) = engine.state.goal()
                && goal.status == GoalStatus::Active
            {
                engine.state.update_goal_status(GoalStatus::Paused);
                app.refresh_engine_metadata(engine);
                let command = goal_command_for_goal(&goal);
                let name = goal_display_name(&goal);
                let _ = tx.send(AppEvent::SystemNotice(format!(
                        "{name} paused by interrupt. Use {command} resume to continue, {command} status to inspect, or {command} clear to discard. Objective: {}",
                        truncate_display_text(&goal.objective, 160)
                    )));
            }
            Ok(false)
        }
        UserAction::ShortenToolWait => {
            engine.shorten_waiting_tools();
            Ok(false)
        }
        UserAction::TryStartTurn => {
            let outcome = try_start_next_turn(engine, app, tx, prompt).await?;
            Ok(matches!(outcome, StartTurnOutcome::Quit))
        }
    }
}

async fn handle_app_event(
    event: AppEvent,
    app: &mut ReplApp,
    engine: &QueryEngine,
    tx: &AppEventSender,
    _prompt: &TuiPermissionPrompt,
) -> HandledAppEvent {
    match event {
        AppEvent::Terminal(CEvent::Key(key)) => {
            let action = app.handle_key(key);
            if let Some(action) = action {
                HandledAppEvent::action(action)
            } else {
                HandledAppEvent::redraw()
            }
        }
        AppEvent::Terminal(CEvent::Resize(width, height)) => {
            app.observe_terminal_resize(Size::new(width, height));
            HandledAppEvent::redraw()
        }
        AppEvent::Terminal(CEvent::Mouse(mouse)) => {
            let was_dragging_scrollbar = app.transcript_viewport.drag_active();
            if let Some(action) = handle_mouse_event(mouse, app) {
                HandledAppEvent::action(action)
            } else if matches!(mouse.kind, MouseEventKind::Moved) && !was_dragging_scrollbar {
                HandledAppEvent::quiet()
            } else {
                HandledAppEvent::redraw()
            }
        }
        AppEvent::Terminal(CEvent::Paste(text)) => {
            if !app.handle_paste_text_for_active_overlay(&text) {
                match app.handle_paste_text(&text) {
                    Ok(()) => {}
                    Err(error) => {
                        app.push_message(MessageRole::System, format!("[paste input] {error}"))
                    }
                }
            }
            HandledAppEvent::redraw()
        }
        AppEvent::Terminal(CEvent::FocusGained) => {
            // The cached fg/bg colors come from the startup probe (run before
            // the crossterm event reader was spawned, see run_repl_with_engine).
            // We deliberately do NOT call `terminal_palette::requery_default_colors`
            // here: that path writes OSC 10/11 queries to the tty and crossterm
            // 0.28's input parser does not understand OSC sequences, so the
            // responses would race the parser and leak into the prompt buffer
            // the same way the startup probe did before the fix.
            HandledAppEvent::redraw()
        }
        AppEvent::Terminal(CEvent::FocusLost) => HandledAppEvent::quiet(),
        AppEvent::ClipboardImageReady(image) => {
            app.clipboard_image_paste_in_flight = false;
            match app.attach_clipboard_image(image) {
                Ok(()) => app.set_transient_status("Attached image from clipboard"),
                Err(error) => {
                    app.push_message(MessageRole::System, format!("[clipboard image] {error:#}"))
                }
            }
            HandledAppEvent::redraw()
        }
        AppEvent::ClipboardImageFailed(error) => {
            app.clipboard_image_paste_in_flight = false;
            app.set_transient_status(format!(
                "No clipboard image found; text/path paste is unchanged ({error})"
            ));
            HandledAppEvent::redraw()
        }
        AppEvent::AssistantDelta(delta) => {
            app.spinner.mark_responding(delta.chars().count());
            let redraw = app.mark_streaming_delta_redraw_seeded();
            app.enqueue_streaming_text_delta(delta);
            if redraw {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            }
        }
        AppEvent::AssistantThinkingDelta(text) => {
            app.spinner.mark_thinking(text.chars().count());
            let redraw = app.mark_streaming_delta_redraw_seeded();
            let drained_pending_text = app.drain_pending_streaming_text_all();
            app.append_streaming_thinking(text);
            if redraw || drained_pending_text {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            }
        }
        AppEvent::ToolInputProgress { name, chars } => {
            app.commit_streaming_thinking_summary();
            app.spinner.mark_tool_input(&name, chars);
            if chars == 0 {
                HandledAppEvent::redraw_and_flush()
            } else {
                HandledAppEvent::redraw()
            }
        }
        AppEvent::ToolInputPreview { id, preview } => {
            app.push_write_input_preview(id, preview);
            HandledAppEvent::redraw()
        }
        AppEvent::ToolPathPreview {
            generation,
            attempt_id,
            id,
            path,
        } => {
            app.path_previews.update(generation, attempt_id, id, path);
            HandledAppEvent::redraw()
        }
        AppEvent::AssistantMessageStarted => {
            app.open_subagent_panel = None;
            app.spinner.mark_requesting();
            app.start_streaming_message();
            HandledAppEvent::redraw()
        }
        AppEvent::AssistantMessageDone => {
            // The engine committed the assistant message and latest provider usage before
            // emitting this event. Refresh immediately so context-left does not retain the
            // previous request's value throughout a later long-running tool call.
            app.refresh_engine_metadata(engine);
            app.mark_streaming_message_done_pending();
            let finished = app.finish_streaming_message_if_ready();
            if finished || app.streaming_message_done_pending {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            }
        }
        AppEvent::FrameTick => {
            let agent_picker_refreshed = slash::refresh_agent_picker(app, engine);
            let agent_view_refreshed = app.refresh_agent_view_transcript(engine, false).await;
            let transient_status_redraw = app.clear_expired_transient_status_at(Instant::now());
            let spinner_redraw = app.spinner.tick();
            let presented = app.drain_pending_streaming_text_tick();
            let committed = app.is_loading && app.commit_streaming_text_tick();
            let finalized = app.finish_streaming_message_if_ready();
            let deferred_finish = if app.ready_to_complete_deferred_turn_finish() {
                let handle = app.take_deferred_turn_finish_handle();
                Some(complete_finished_turn(app, engine, tx, handle))
            } else {
                None
            };
            let live_stream_redraw = app.is_loading
                || app.active_turn.is_some()
                || !app.streaming_text_pending.is_empty()
                || app.streaming_message_done_pending;
            let background_status_redraw = app.has_running_background_job();
            let mut handled = if agent_view_refreshed
                // Even an unchanged snapshot needs another draw to rearm child polling.
                || app.agent_view.is_some()
                || agent_picker_refreshed
                || app.copy_needs_tick()
                || app.navigation_needs_tick()
                || transient_status_redraw
                || spinner_redraw
                || presented
                || committed
                || finalized
                || live_stream_redraw
                || background_status_redraw
            {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            };
            if let Some(deferred_finish) = deferred_finish {
                handled.merge(deferred_finish);
            }
            handled
        }
        AppEvent::ToolUseStarted { id, name, input } => {
            if is_subagent_tool_name(&name) {
                app.push_subagent_pending(id, name, input);
            } else {
                app.open_subagent_panel = None;
                if is_send_message_tool_name(&name) {
                    app.pending_send_message_inputs
                        .insert(id.clone(), input.clone());
                }
                app.push_tool_running(id, name, input);
            }
            HandledAppEvent::redraw_and_flush()
        }
        AppEvent::ToolResult {
            id,
            name,
            text,
            is_error,
        } => {
            if name.eq_ignore_ascii_case("bash") {
                app.update_background_job_lifetime_from_tool_result(&text);
            }
            if is_send_message_tool_name(&name) {
                let result = parse_subagent_result(&text, is_error);
                let input = app
                    .pending_send_message_inputs
                    .remove(&id)
                    .unwrap_or_default();
                if result.status == "resuming" {
                    app.convert_running_tool_to_subagent_panel(id.clone(), name.clone(), input);
                }
                if result.queued
                    && let (Some(agent_id), Some(message_id)) =
                        (result.agent_id.as_deref(), result.message_id.as_deref())
                {
                    app.queue_subagent_steer_in_panel(
                        agent_id,
                        message_id,
                        result.queue_position.unwrap_or(1),
                    );
                }
            }
            let belongs_to_subagent_panel = app
                .subagent_panels
                .values()
                .any(|panel| panel.has_tool_call(&id));
            if belongs_to_subagent_panel {
                app.finish_subagent_tool_call(&id, &text, is_error);
            } else {
                app.push_tool_done(id, name, text, is_error);
            }
            app.refresh_engine_metadata(engine);
            HandledAppEvent::redraw()
        }
        AppEvent::PermissionRequest {
            tool_name,
            description,
            input,
            risk,
            detail_lines,
            response_tx,
        } => {
            app.enqueue_permission_dialog(PermissionDialog {
                tool_name,
                description,
                input,
                risk,
                detail_lines,
                response_tx,
                selected: 0,
            });
            HandledAppEvent::redraw()
        }
        AppEvent::UserQuestionRequest {
            request,
            response_tx,
        } => {
            let states = question_dialog_initial_states(&request);
            let current = states.first().cloned().unwrap_or_default();
            app.enqueue_question_dialog(QuestionDialog {
                request,
                response_tx,
                states,
                selected: current.selected,
                cursor: current.cursor,
                scroll_top: current.scroll_top,
                focused: 0,
            });
            HandledAppEvent::redraw()
        }
        AppEvent::Error(err) => {
            app.path_previews.clear();
            app.push_message(MessageRole::System, format!("Error: {}", err));
            HandledAppEvent::redraw()
        }
        AppEvent::Fatal(err) => {
            app.path_previews.clear();
            append_repl_exit_diagnostic(engine, "fatal", &err);
            app.push_message(MessageRole::System, format!("Fatal: {}", err));
            HandledAppEvent::action(UserAction::Quit)
        }
        AppEvent::SystemNotice(text) => {
            app.push_message(MessageRole::System, text);
            HandledAppEvent::redraw()
        }
        AppEvent::MoaReference {
            label,
            text,
            index,
            count,
        } => {
            app.push_message(
                MessageRole::System,
                format_moa_reference_message(&label, &text, index, count),
            );
            HandledAppEvent::redraw()
        }
        AppEvent::MoaAggregating { aggregator } => {
            app.push_message(
                MessageRole::System,
                format!("MoA acting model: {aggregator}"),
            );
            HandledAppEvent::redraw()
        }
        AppEvent::MoaPlanProgress {
            message,
            completed,
            total,
        } => {
            app.foreground_operation_label = Some(if total > 0 {
                format!("{message} ({completed}/{total})")
            } else {
                message
            });
            HandledAppEvent::redraw()
        }
        AppEvent::TurnStarted => {
            app.refresh_engine_metadata(engine);
            app.mark_turn_started();
            HandledAppEvent::redraw()
        }
        AppEvent::TurnSteerApplied { id } => {
            if app.apply_pending_turn_steer(id) {
                app.spinner.mark_requesting();
                HandledAppEvent::redraw_and_flush()
            } else {
                warn!(
                    steer_id = id,
                    "received applied steer without matching TUI input"
                );
                HandledAppEvent::quiet()
            }
        }
        AppEvent::ManualCompactionFinished {
            did_compact,
            pre_compact_tokens,
            post_compact_tokens,
        } => {
            app.refresh_engine_metadata(engine);
            if did_compact {
                let message = if post_compact_tokens < pre_compact_tokens {
                    format!(
                        "Context compaction completed ({} -> {} tokens).",
                        pre_compact_tokens, post_compact_tokens
                    )
                } else {
                    format!(
                        "Context compaction completed; model context is now {} tokens.",
                        post_compact_tokens
                    )
                };
                app.push_message(MessageRole::System, message);
            } else {
                app.push_message(
                    MessageRole::System,
                    "Context compaction skipped: not enough older conversation to compact.",
                );
            }
            app.snap_to_bottom();
            HandledAppEvent::redraw()
        }
        AppEvent::ManualCompactionFailed { error } => {
            app.push_message(
                MessageRole::System,
                format!("Context compaction failed: {error}"),
            );
            app.snap_to_bottom();
            HandledAppEvent::redraw()
        }
        AppEvent::MoaPlanFinished {
            final_path,
            draft_count,
            failed_count,
        } => {
            app.refresh_engine_metadata(engine);
            app.replace_transcript_from_history(&engine.state.messages());
            app.push_message(
                MessageRole::System,
                format!(
                    "MoA plan completed: {} drafts, {} failed planner(s). Final: {}",
                    draft_count,
                    failed_count,
                    final_path.display()
                ),
            );
            app.snap_to_bottom();
            HandledAppEvent::redraw()
        }
        AppEvent::MoaPlanFailed { error } => {
            app.push_message(MessageRole::System, format!("MoA plan failed: {error}"));
            app.snap_to_bottom();
            HandledAppEvent::redraw()
        }
        AppEvent::SideQuestionCompleted { id, answer } => {
            if let Some(overlay) = app.side_question_overlay.as_mut()
                && overlay.id == id
            {
                overlay.status = SideQuestionStatus::Answered(answer);
                overlay.scroll = 0;
            }
            HandledAppEvent::redraw()
        }
        AppEvent::SideQuestionFailed { id, error } => {
            if let Some(overlay) = app.side_question_overlay.as_mut()
                && overlay.id == id
            {
                overlay.status = SideQuestionStatus::Failed(error);
                overlay.scroll = 0;
            }
            HandledAppEvent::redraw()
        }
        AppEvent::TurnFinished => {
            app.defer_unapplied_turn_steers();
            let handle = app.finish_turn_state();
            if app.should_defer_turn_finish_for_streaming() {
                app.defer_turn_finish_until_streaming_drained(handle);
                HandledAppEvent::redraw()
            } else {
                complete_finished_turn(app, engine, tx, handle)
            }
        }
        AppEvent::HistoryChanged => {
            app.refresh_engine_metadata(engine);
            let messages = engine.state.messages();
            app.replace_transcript_from_history(&messages);
            app.reconcile_subagent_panels_from_engine(engine);
            HandledAppEvent::redraw()
        }
        AppEvent::TurnWakeRequested => HandledAppEvent::action(UserAction::TryStartTurn),
        AppEvent::BackgroundFollowupRequested {
            ids,
            events,
            summary,
        } => {
            enqueue_background_followup(app, ids, events, summary);
            HandledAppEvent::action(UserAction::TryStartTurn)
        }
        AppEvent::BackgroundJobStarted {
            id,
            description,
            continuation,
        } => {
            // Background status hints are intentionally not pushed to the
            // transcript. They are surfaced via compact status UI so the user
            // does not mistake them for assistant output. Sub-agent completions
            // still reach the model through the engine's notification path;
            // tool background tasks are polled explicitly via TaskOutput.
            if continuation {
                app.detach_subagent_routing_for_continuation(&id);
            }
            app.record_background_job_hint(BackgroundJobHint {
                id,
                description,
                state: BackgroundJobHintState::Running,
                error: None,
                started_at: Some(std::time::Instant::now()),
            });
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobAssociated {
            id,
            tool_call_id,
            run_in_background,
        } => {
            app.associate_subagent_panel(&id, &tool_call_id, run_in_background);
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobPromoted { id } => {
            app.promote_subagent_panel(&id);
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobProgress {
            id,
            message,
            detail,
            current,
            total,
        } => {
            let hint_changed =
                app.update_background_job_progress(&id, message.clone(), current, total);
            let panel_changed = app.update_subagent_panel_progress(
                &id,
                &message,
                detail.as_deref(),
                current,
                total,
            );
            if hint_changed || panel_changed {
                HandledAppEvent::redraw()
            } else {
                HandledAppEvent::quiet()
            }
        }
        AppEvent::SubagentSteerApplied {
            id,
            message_id,
            queue_depth,
        } => {
            app.apply_subagent_steer_to_panel(&id, &message_id, queue_depth);
            app.finish_agent_view_steer(&id, &message_id);
            app.refresh_agent_view_transcript(engine, true).await;
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobReconciledRunning {
            id,
            detail,
            current,
            total,
        } => {
            app.update_subagent_panel_progress(&id, "Running", detail.as_deref(), current, total);
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobPaused { id, reason } => {
            let reason = engine
                .state
                .task(&id)
                .map(|task| orchestrate_agent_status_detail(&task))
                .unwrap_or(reason);
            app.complete_background_job_hint(
                &id,
                BackgroundJobHintState::Paused,
                Some(reason.clone()),
            );
            app.pause_subagent_panel(&id, "Paused", Some(&reason));
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobHalted { id, reason } => {
            let reason = engine
                .state
                .task(&id)
                .map(|task| orchestrate_agent_status_detail(&task))
                .unwrap_or(reason);
            app.complete_background_job_hint(
                &id,
                BackgroundJobHintState::Halted,
                Some(reason.clone()),
            );
            app.finish_subagent_panel(&id, SubagentPhase::Halted, reason);
            app.flush_terminal_subagent_panel_if_idle();
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobCompleted { id, summary } => {
            app.complete_background_job_hint(&id, BackgroundJobHintState::Completed, None);
            if let Some(summary) = summary.as_deref() {
                app.update_subagent_panel_progress(&id, "Completed", Some(summary), None, None);
            }
            app.finish_subagent_panel(&id, SubagentPhase::Completed, "Completed");
            app.flush_terminal_subagent_panel_if_idle();
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobFailed { id, error } => {
            if error.trim() == "cancelled by user" {
                app.complete_background_job_hint(&id, BackgroundJobHintState::Completed, None);
                app.finish_subagent_panel(&id, SubagentPhase::Cancelled, "Cancelled");
                app.flush_terminal_subagent_panel_if_idle();
                if !app.is_loading && !app.has_running_background_job() {
                    app.spinner.stop();
                }
                return HandledAppEvent::redraw();
            }
            // Update an existing hint if present, otherwise record a new
            // failed entry so status surfaces can expose the failure.
            if !app.complete_background_job_hint(
                &id,
                BackgroundJobHintState::Failed,
                Some(error.clone()),
            ) {
                app.record_background_job_hint(BackgroundJobHint {
                    id: id.clone(),
                    description: format!("error: {error}"),
                    state: BackgroundJobHintState::Failed,
                    error: Some(error.clone()),
                    started_at: None,
                });
            }
            app.finish_subagent_panel(&id, SubagentPhase::Failed, error);
            app.flush_terminal_subagent_panel_if_idle();
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
        AppEvent::BackgroundJobCancelled { id } => {
            app.complete_background_job_hint(&id, BackgroundJobHintState::Cancelled, None);
            app.finish_subagent_panel(&id, SubagentPhase::Cancelled, "Cancelled");
            app.flush_terminal_subagent_panel_if_idle();
            if !app.is_loading && !app.has_running_background_job() {
                app.spinner.stop();
            }
            HandledAppEvent::redraw()
        }
    }
}

fn handle_mouse_event(mouse: MouseEvent, app: &mut ReplApp) -> Option<UserAction> {
    trace_tui_lab_mouse_event("input", mouse, app);
    app.last_mouse_pos = Some((mouse.column, mouse.row));
    if app.handle_copy_mouse(mouse) {
        return None;
    }
    if app.handle_outline_mouse(mouse) {
        return None;
    }
    if app.active_overlay.is_none()
        && matches!(
            mouse.kind,
            MouseEventKind::ScrollUp
                | MouseEventKind::ScrollDown
                | MouseEventKind::Drag(MouseButton::Left)
        )
    {
        app.cancel_pending_navigation_for_input();
    }

    if handle_transcript_scrollbar_mouse(mouse, app) {
        return None;
    }

    if handle_transcript_selection_mouse(mouse, app) {
        return None;
    }

    if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) {
        return handle_left_mouse_click(mouse.column, mouse.row, app);
    }

    let is_scroll = matches!(
        mouse.kind,
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
    );

    if is_scroll {
        if app.navigation.inline && app.transcript_overlay.is_some() {
            app.transcript_viewport
                .queue_wheel(if mouse.kind == MouseEventKind::ScrollUp {
                    ScrollDirection::Up
                } else {
                    ScrollDirection::Down
                });
            return None;
        }
        if let Some(overlay) = app.transcript_overlay.as_mut() {
            match mouse.kind {
                MouseEventKind::ScrollUp => overlay.scroll_by(-3),
                MouseEventKind::ScrollDown => overlay.scroll_by(3),
                _ => {}
            }
            return None;
        }

        // History search uses the wheel for its own selection.
        if let Some(search) = app.history_search.as_mut() {
            match mouse.kind {
                MouseEventKind::ScrollUp if search.selected > 0 => search.selected -= 1,
                MouseEventKind::ScrollDown if search.selected + 1 < search.matches.len() => {
                    search.selected += 1;
                }
                _ => {}
            }
            return None;
        }

        if let Some(picker) = app.resume_session_picker.as_mut() {
            let matches_len = resume_session_picker_matches(picker).len();
            match mouse.kind {
                MouseEventKind::ScrollUp => {
                    picker.selected = picker.selected.saturating_sub(1);
                }
                MouseEventKind::ScrollDown => {
                    picker.selected = picker
                        .selected
                        .saturating_add(1)
                        .min(matches_len.saturating_sub(1));
                }
                _ => {}
            }
            return None;
        }

        let dialog_area = app.dialog_host_area();
        if let Some(dialog) = app.pending_question.as_mut() {
            match mouse.kind {
                MouseEventKind::ScrollUp => {
                    move_question_dialog_cursor_by(dialog, -1, dialog_area, false);
                }
                MouseEventKind::ScrollDown => {
                    move_question_dialog_cursor_by(dialog, 1, dialog_area, false);
                }
                _ => {}
            }
            return None;
        }

        if let Some(picker) = app.picker_overlay.as_mut() {
            let matches_len = picker.matches().len();
            match mouse.kind {
                MouseEventKind::ScrollUp => {
                    picker.selected = picker.selected.saturating_sub(1);
                }
                MouseEventKind::ScrollDown => {
                    picker.selected = picker
                        .selected
                        .saturating_add(1)
                        .min(matches_len.saturating_sub(1));
                }
                _ => {}
            }
            return None;
        }

        if app.slash_menu.is_some() {
            let matches_len = app.slash_menu_matches().len();
            if let Some(menu) = app.slash_menu.as_mut() {
                match mouse.kind {
                    MouseEventKind::ScrollUp => {
                        menu.selected = menu.selected.saturating_sub(1);
                    }
                    MouseEventKind::ScrollDown => {
                        menu.selected = menu
                            .selected
                            .saturating_add(1)
                            .min(matches_len.saturating_sub(1));
                    }
                    _ => {}
                }
            }
            return None;
        }

        // Other overlays should consume wheel events so they don't leak into
        // the transcript behind them.
        if app.pending_permission.is_some()
            || app.permission_editor.is_some()
            || app.pending_goal_replacement.is_some()
            || app.resume_session_picker.is_some()
            || app.slash_menu.is_some()
            || app.context_inspector.is_some()
            || app.settings_inspector.is_some()
            || app.picker_overlay.is_some()
            || app.keys_overlay.is_some()
            || app.transcript_overlay.is_some()
        {
            return None;
        }
    }

    match mouse.kind {
        MouseEventKind::ScrollUp => {
            if app.navigation.anchor.is_none() {
                app.expand_deferred_resumed_transcript();
            }
            app.transcript_viewport.queue_wheel(ScrollDirection::Up);
        }
        MouseEventKind::ScrollDown => {
            app.transcript_viewport.queue_wheel(ScrollDirection::Down);
        }
        _ => {}
    }
    None
}

fn trace_tui_lab_mouse_event(phase: &str, mouse: MouseEvent, app: &ReplApp) {
    let Ok(run_dir) = std::env::var("KCODER_TUI_LAB_RUN_DIR") else {
        return;
    };
    if run_dir.is_empty() {
        return;
    }
    let path = Path::new(&run_dir).join("mouse-events.log");
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let _ = writeln!(
        file,
        "{phase}\t{:?}\trow={}\tcol={}\t{}",
        mouse.kind,
        mouse.row,
        mouse.column,
        app.transcript_viewport.trace_state(),
    );
}

fn handle_transcript_scrollbar_mouse(mouse: MouseEvent, app: &mut ReplApp) -> bool {
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            let Some(area) = app.transcript_viewport.scrollbar_area() else {
                app.transcript_viewport.end_drag();
                return false;
            };
            if !rect_contains(area, mouse.column, mouse.row) {
                app.transcript_viewport.end_drag();
                return false;
            }
            if app.deferred_resumed_transcript.is_some() {
                // The current thumb represents only the loaded tail. Complete the transcript
                // first and prime full geometry from the same row index so this press can begin dragging.
                if !app.expand_deferred_resumed_transcript() {
                    return true;
                }
            }
            if let Some(command) = app.transcript_viewport.begin_drag(mouse.row) {
                app.apply_transcript_scrollbar_command(command, true);
            }
            true
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            if !app.transcript_viewport.drag_active() {
                return false;
            }
            app.scroll_transcript_to_scrollbar_row(mouse.row, false);
            true
        }
        MouseEventKind::Moved => {
            if !app.transcript_viewport.drag_active() {
                return false;
            }
            // `Moved` does not carry button state. Treat it as a drag fallback
            // only while the pointer remains in the scrollbar hit column; if a
            // terminal dropped the matching mouse-up, ordinary transcript hover
            // must not keep moving the scrollbar.
            if !transcript_scrollbar_drag_column_contains(app, mouse.column) {
                app.transcript_viewport.end_drag();
                return false;
            }
            app.scroll_transcript_to_scrollbar_row(mouse.row, false);
            true
        }
        MouseEventKind::Up(MouseButton::Left) => {
            if !app
                .transcript_viewport
                .release_drag(mouse.column, mouse.row)
            {
                return false;
            }
            app.frame_rate_limiter.reset();
            trace_tui_lab_mouse_event("after-up", mouse, app);
            app.finish_manual_scroll_at_tail();
            true
        }
        _ => false,
    }
}

fn handle_transcript_selection_mouse(mouse: MouseEvent, app: &mut ReplApp) -> bool {
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            app.begin_transcript_selection(mouse.column, mouse.row)
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            app.update_transcript_selection(mouse.column, mouse.row)
        }
        MouseEventKind::Up(MouseButton::Left) => {
            app.finish_transcript_selection(mouse.column, mouse.row)
        }
        _ => false,
    }
}

fn transcript_scrollbar_drag_column_contains(app: &ReplApp, column: u16) -> bool {
    app.transcript_viewport.drag_column_contains(column)
}

fn handle_left_mouse_click(column: u16, row: u16, app: &mut ReplApp) -> Option<UserAction> {
    let frame_area = app.last_frame_area?;
    let dialog_area = app.dialog_host_area().unwrap_or(frame_area);

    if let Some(index) = app
        .pending_permission
        .as_ref()
        .and_then(|dialog| permission_option_hit_index(dialog_area, dialog, column, row))
    {
        if let Some(dialog) = app.pending_permission.as_mut() {
            dialog.selected = index;
        }
        app.finish_permission_dialog_with_response(
            PERMISSION_OPTION_RESPONSES[index.min(PERMISSION_OPTION_RESPONSES.len() - 1)],
        );
        return None;
    }

    if app.pending_permission.is_some() || app.permission_editor.is_some() {
        return None;
    }

    if let Some(index) = app
        .pending_question
        .as_ref()
        .and_then(|dialog| question_option_hit_index(dialog_area, dialog, column, row))
    {
        if let Some(dialog) = app.pending_question.as_mut() {
            let multi_select = dialog.request.questions[dialog.focused].multi_select;
            set_question_dialog_cursor(dialog, index, Some(dialog_area), !multi_select);
            if multi_select {
                if dialog.selected.contains(&index) {
                    if dialog.selected.len() > 1 {
                        dialog.selected.retain(|selected| *selected != index);
                    }
                } else {
                    dialog.selected.push(index);
                    dialog.selected.sort_unstable();
                }
                question_dialog_clear_current_answer(dialog);
                question_dialog_save_current_state(dialog);
            }
        }
        return None;
    }

    if app.pending_question.is_some() {
        return None;
    }

    if app.pending_goal_replacement.is_some() {
        return None;
    }

    if app.history_search.is_some() {
        return None;
    }

    if let Some((entry_index, path)) = app.resume_session_picker.as_ref().and_then(|picker| {
        let area = app.transcript_viewport.transcript_area()?;
        if !rect_contains(area, column, row) {
            return None;
        }
        let row_offset = row.saturating_sub(area.y) as usize;
        let entry_index =
            resume_session_picker_hit_index(picker, usize::from(area.height), row_offset)?;
        let path = picker.entries.get(entry_index)?.path.clone();
        Some((entry_index, path))
    }) {
        if let Some(picker) = app.resume_session_picker.as_mut() {
            let matches = resume_session_picker_matches(picker);
            picker.selected = matches
                .iter()
                .position(|index| *index == entry_index)
                .unwrap_or(picker.selected);
        }
        app.close_resume_session_picker();
        return Some(UserAction::ResumeSession(path));
    }

    if app.resume_session_picker.is_some() {
        return None;
    }

    if let (Some(menu), Some(overlay_area)) =
        (app.slash_menu.as_ref(), app.last_bottom_overlay_area)
    {
        let matches_len = app.slash_menu_matches().len();
        if let Some(index) =
            slash_menu_hit_index(overlay_area, matches_len, menu.selected, column, row)
        {
            if let Some(menu) = app.slash_menu.as_mut() {
                menu.selected = index.min(matches_len.saturating_sub(1));
            }
            app.accept_slash_menu_selection(index);
            return None;
        }
    }

    if let Some((index, action)) = app.picker_overlay.as_ref().and_then(|picker| {
        let matches = picker.matches_indexed();
        let index = picker_hit_index_for(picker, frame_area, matches.len(), column, row)?;
        let (item_index, item) = matches.get(index).cloned()?;
        let value = picker.value_for_original_index(item_index, &item);
        let turn = picker.item_turns.get(item_index).copied();
        Some((index, (picker.on_confirm, value, turn)))
    }) {
        if let Some(picker) = app.picker_overlay.as_mut() {
            picker.selected = index;
        }
        app.close_picker_overlay();
        return match action {
            (PickerAction::ViewAgent, id, _) => {
                Some(UserAction::SlashCommand(format!("/agent view {id}")))
            }
            (PickerAction::SwitchModel, item, _) => {
                Some(UserAction::SlashCommand(format!("/model {}", item)))
            }
            (PickerAction::SwitchTheme, item, _) => {
                Some(UserAction::SlashCommand(format!("/theme {}", item)))
            }
            (PickerAction::RewindToTurn, _, turn) => {
                turn.map(|turn| UserAction::SlashCommand(format!("/rewind {turn}")))
            }
        };
    }

    if app.focus_composer_at_mouse(column, row) {
        return None;
    }

    None
}

async fn handle_slash_command(
    command: &str,
    app: &mut ReplApp,
    engine: &QueryEngine,
) -> Option<UserAction> {
    let (cmd, args) = parse_slash_input(command);
    // Clone the Arc to avoid borrowing `app` while running the command.
    let registry = Arc::clone(&app.slash_registry);
    if let Some(cmd) = registry.get(cmd) {
        match cmd.run(args, app, engine).await {
            SlashResult::Quit => return Some(UserAction::Quit),
            SlashResult::Submit(text) => {
                return Some(UserAction::Submit(SubmittedMessage::text(text)));
            }
            SlashResult::SubmitWithDisplay {
                visible_text,
                model_text,
            } => {
                return Some(UserAction::Submit(SubmittedMessage::text_with_visible(
                    visible_text,
                    model_text,
                )));
            }
            SlashResult::StartCompact => return Some(UserAction::CompactConversation),
            SlashResult::StartSideQuestion(question) => {
                return Some(UserAction::StartSideQuestion(question));
            }
            SlashResult::StartMoaPlan(request) => {
                return Some(UserAction::StartMoaPlan(request));
            }
            SlashResult::Handled => {}
        }
    } else if slash_token_looks_like_path(cmd) {
        // The leading token is not a registered command but looks like a
        // filesystem path: the user is referring to a path (for example
        // "/tmp describe this project"), not invoking a command. Submit the input as a
        // normal message instead of rejecting it.
        return Some(UserAction::Submit(SubmittedMessage::text(
            command.to_string(),
        )));
    } else {
        app.push_message(
            MessageRole::System,
            format!(
                "Unknown command: {}. Type /help for available commands, or start the input with a space to send it as a message.",
                cmd
            ),
        );
    }
    None
}

/// True when an unrecognized `/token` looks like a filesystem path rather
/// than a mistyped command: it contains another path separator (`/data/x`),
/// or it exists as an absolute path on disk (`/tmp`).
fn slash_token_looks_like_path(cmd: &str) -> bool {
    let body = cmd.strip_prefix('/').unwrap_or(cmd);
    if body.is_empty() {
        return false;
    }
    if body.contains('/') || body.contains('\\') {
        return true;
    }
    std::path::Path::new(cmd).exists()
}

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

#[cfg(test)]
fn engine_event_to_app_event(event: EngineEvent) -> Option<AppEvent> {
    engine_event_to_app_event_for_generation(event, 0)
}

fn engine_event_to_app_event_for_generation(
    event: EngineEvent,
    generation: u64,
) -> Option<AppEvent> {
    Some(match event {
        EngineEvent::BackgroundScoped { event, .. } => {
            return engine_event_to_app_event_for_generation(*event, generation);
        }
        EngineEvent::AssistantMessageStarted => AppEvent::AssistantMessageStarted,
        EngineEvent::TurnSteerApplied { id } => AppEvent::TurnSteerApplied { id },
        EngineEvent::AssistantTextDelta(text) => AppEvent::AssistantDelta(text),
        EngineEvent::AssistantThinkingDelta(text) => AppEvent::AssistantThinkingDelta(text),
        EngineEvent::ToolInputReset => return None,
        EngineEvent::ToolInputProgress { name, chars, .. } => {
            AppEvent::ToolInputProgress { name, chars }
        }
        EngineEvent::ToolInputPreview { id, preview } => AppEvent::ToolInputPreview { id, preview },
        EngineEvent::ToolPathPreview {
            attempt_id,
            id,
            path,
        } => AppEvent::ToolPathPreview {
            generation,
            attempt_id,
            id,
            path,
        },
        EngineEvent::AssistantMessageDone => AppEvent::AssistantMessageDone,
        EngineEvent::ToolUseStarted { id, name, input } => AppEvent::ToolUseStarted {
            id,
            name,
            input: input.to_string(),
        },
        EngineEvent::ToolResult { id, name, output } => {
            let text = output
                .content
                .into_iter()
                .filter_map(|b| match b {
                    kcoder_types::ContentBlock::Text { text } => Some(text),
                    _ => None,
                })
                .collect::<String>();
            AppEvent::ToolResult {
                id,
                name,
                text,
                is_error: output.is_error,
            }
        }
        EngineEvent::ToolDenied { id, name, reason } => AppEvent::ToolResult {
            id,
            name,
            text: reason,
            is_error: true,
        },
        EngineEvent::SystemNotice(text) => AppEvent::SystemNotice(text),
        EngineEvent::ProviderRetry(details) => AppEvent::SystemNotice(details.notice_text()),
        EngineEvent::MoaReference {
            label,
            text,
            index,
            count,
        } => AppEvent::MoaReference {
            label,
            text,
            index,
            count,
        },
        EngineEvent::MoaAggregating { aggregator } => AppEvent::MoaAggregating { aggregator },
        EngineEvent::Error(err) | EngineEvent::ProviderFailed { message: err, .. } => {
            AppEvent::Error(err)
        }
        EngineEvent::UserMessageAdded => AppEvent::HistoryChanged,
        EngineEvent::SubagentSteerApplied { .. } => return None,
        EngineEvent::MaxTurnsReached { max_turns, .. } => AppEvent::SystemNotice(format!(
            "Reached the maximum number of turns ({} turns).",
            max_turns
        )),
        EngineEvent::StreamAborted { reason } => {
            AppEvent::SystemNotice(format!("Stream aborted: {}", reason))
        }
        EngineEvent::CompactionFailed { error, .. } => {
            AppEvent::SystemNotice(format!("Compaction failed: {}", error))
        }
        EngineEvent::CompactionRecovered { details } => {
            AppEvent::SystemNotice(details.recovered_notice_text())
        }
        EngineEvent::HookMessage { text, is_error } => AppEvent::SystemNotice(if is_error {
            format!("[hook error] {}", text)
        } else {
            text
        }),
        EngineEvent::BackgroundJobStarted { .. }
        | EngineEvent::BackgroundJobAssociated { .. }
        | EngineEvent::BackgroundJobPromoted { .. }
        | EngineEvent::BackgroundJobProgress { .. }
        | EngineEvent::BackgroundJobCompleted { .. }
        | EngineEvent::BackgroundJobFailed { .. }
        | EngineEvent::BackgroundJobPaused { .. }
        | EngineEvent::BackgroundJobHalted { .. }
        | EngineEvent::BackgroundJobCancelled { .. } => return None,
    })
}

fn format_moa_reference_message(label: &str, text: &str, index: usize, count: usize) -> String {
    let title = if count > 0 {
        format!("MoA reference {index}/{count} - {label}")
    } else {
        format!("MoA reference {index} - {label}")
    };
    let text = text.trim();
    if text.is_empty() {
        title
    } else {
        format!("{title}\n{text}")
    }
}

fn spawn_turn(
    engine: QueryEngine,
    text: Option<String>,
    tx: AppEventSender,
    prompt: TuiPermissionPrompt,
    turn_cancel: CancellationToken,
    steer_session: Option<TurnSteerSession>,
    path_preview_generation: u64,
    background_followup: Option<(Vec<kcoder_types::BackgroundRunKey>, String)>,
) -> JoinHandle<()> {
    // `text` is kept as an `Option<String>` for backward-compatibility with
    // existing call sites, but the REPL flow always passes `None`. User text
    // is appended to engine.state at the scheduling boundary, immediately
    // before this function is called, so queued input cannot split an
    // assistant tool_use from its tool_result.
    let _ = text;

    tokio::spawn(async move {
        let mut completion = TurnCompletionGuard::new(tx.clone());
        let goal_at_start = engine.state.goal().filter(|goal| goal.status.is_active());
        let goal_turn_started_at = Instant::now();
        let mut goal_turn_failure: Option<GoalTurnFailure> = None;
        let mut orchestrate_turn_failed = false;
        // Constructing the stream synchronously registers the current turn's steering mailbox.
        // Even if background notifications are refreshed before startup, later user input
        // cannot accidentally enter the next-turn queue.
        let mut stream = if let Some(steer_session) = steer_session {
            engine.run_turn_stream_with_cancel_and_steering(&prompt, turn_cancel, steer_session)
        } else {
            engine.run_turn_stream_with_cancel(&prompt, turn_cancel)
        };

        // Drain any subagent notifications that have piled up so far
        // before the follow-up turn starts streaming. This guarantees
        // the next API call sees the freshly-injected
        // `<subagent_notification .../>` user messages.
        for event in engine.flush_background_jobs_with_hooks().await {
            if let EngineEvent::HookMessage { text, is_error } = event {
                let _ = tx
                    .send_ordered(AppEvent::SystemNotice(if is_error {
                        format!("[hook error] {}", text)
                    } else {
                        text
                    }))
                    .await;
            }
        }

        let _ = tx.send_ordered(AppEvent::TurnStarted).await;
        while let Some(event) = stream.next().await {
            if matches!(
                event,
                EngineEvent::Error(_)
                    | EngineEvent::ProviderFailed { .. }
                    | EngineEvent::StreamAborted { .. }
                    | EngineEvent::MaxTurnsReached { .. }
            ) {
                orchestrate_turn_failed = true;
            }
            if let Some(failure) = goal_turn_failure_from_engine_event(&event) {
                goal_turn_failure = Some(failure);
            }
            append_repl_engine_event_diagnostic(&engine, &event);
            let Some(app_event) =
                engine_event_to_app_event_for_generation(event, path_preview_generation)
            else {
                continue;
            };

            if !tx.send_ordered(app_event).await {
                orchestrate_turn_failed = true;
                break;
            }
        }
        if !orchestrate_turn_failed && let Some((keys, turn_id)) = background_followup {
            if !keys.is_empty() {
                let outcome = async {
                    engine.state.flush_history().await?;
                    engine.state.finish_background_followup(&keys, &turn_id)
                }
                .await;
                if let Err(error) = outcome {
                    let _ = tx
                        .send_ordered(AppEvent::SystemNotice(format!(
                            "Background follow-up completion could not be persisted: {error:#}"
                        )))
                        .await;
                }
            }
        }
        if let Err(error) = engine.record_orchestrate_continuation_outcome(orchestrate_turn_failed)
        {
            let _ = tx
                .send_ordered(AppEvent::SystemNotice(format!(
                    "Orchestrate continuation outcome could not be persisted: {error:#}"
                )))
                .await;
        }
        if let Some(start_goal) = goal_at_start.as_ref() {
            let elapsed_seconds = goal_turn_started_at.elapsed().as_secs();
            let still_active_same_goal = engine
                .state
                .goal()
                .map(|goal| goal.goal_id == start_goal.goal_id && goal.status.is_active())
                .unwrap_or(false);
            if still_active_same_goal
                && let Some(goal) = engine.state.account_active_goal_usage(0, elapsed_seconds)
                && goal.status.is_active()
                && goal.budget_exhausted()
                && let Some(goal) = engine.state.update_goal_status(GoalStatus::BudgetLimited)
            {
                let budget = goal.token_budget.unwrap_or(goal.tokens_used);
                let command = goal_command_for_goal(&goal);
                let name = goal_display_name(&goal);
                let _ = tx
                        .send_ordered(AppEvent::SystemNotice(format!(
                            "{name} token budget reached ({}/{} tokens). Use {command} clear before starting a new goal.",
                            goal.tokens_used, budget
                        )))
                        .await;
            }
        }
        if let (Some(start_goal), Some(failure)) = (goal_at_start.as_ref(), goal_turn_failure) {
            stop_active_goal_after_turn_failure(&engine, start_goal, failure, &tx).await;
        }
        // Ensure the loading indicator stops after the turn (including any
        // tool executions that followed the assistant message).
        completion.finish_ordered().await;
    })
}

#[derive(Debug, Clone)]
struct GoalTurnFailure {
    reason: String,
    status: GoalStatus,
}

fn goal_turn_failure_from_engine_event(event: &EngineEvent) -> Option<GoalTurnFailure> {
    match event {
        EngineEvent::ProviderFailed { message, details } => Some(GoalTurnFailure {
            reason: message.clone(),
            status: if details.category == kcoder_types::ProviderFailureCategory::QuotaExceeded {
                GoalStatus::UsageLimited
            } else {
                GoalStatus::Paused
            },
        }),
        EngineEvent::Error(reason) => Some(GoalTurnFailure {
            reason: reason.clone(),
            status: goal_failure_status(reason),
        }),
        EngineEvent::StreamAborted { reason } if reason != "cancelled by user" => {
            Some(GoalTurnFailure {
                reason: reason.clone(),
                status: goal_failure_status(reason),
            })
        }
        _ => None,
    }
}

async fn stop_active_goal_after_turn_failure(
    engine: &QueryEngine,
    start_goal: &Goal,
    failure: GoalTurnFailure,
    tx: &AppEventSender,
) {
    let Some(current) = engine.state.goal() else {
        return;
    };
    if current.goal_id != start_goal.goal_id || current.status != GoalStatus::Active {
        return;
    }

    let status = failure.status;
    let Some(goal) = engine.state.update_goal_status(status) else {
        return;
    };
    let status_text = match status {
        GoalStatus::UsageLimited => "usage-limited",
        GoalStatus::Blocked => "blocked",
        _ => status.as_str(),
    };
    let _ = tx
        .send_ordered(AppEvent::SystemNotice(format!(
            "{} automatically marked {status_text} after a turn error to prevent automatic retry loops. Use {} resume after addressing the issue, or {} clear to discard it. Error: {}",
            goal_display_name(&goal),
            goal_command_for_goal(&goal),
            goal_command_for_goal(&goal),
            compact_failure_reason(&failure.reason, 240)
        )))
        .await;
    debug!(
        goal_id = %goal.goal_id,
        status = goal.status.as_str(),
        reason = %failure.reason,
        "stopped active goal after turn failure"
    );
}

fn compact_failure_reason(reason: &str, max_width: usize) -> String {
    truncate_display_text(
        &reason.split_whitespace().collect::<Vec<_>>().join(" "),
        max_width,
    )
}

fn goal_failure_status(reason: &str) -> GoalStatus {
    let lower = reason.to_lowercase();
    if lower.contains("usage limit")
        || lower.contains("usage_limit")
        || lower.contains("usage limits")
        || lower.contains("insufficient quota")
        || lower.contains("insufficient_quota")
        || lower.contains("quota exceeded")
        || lower.contains("credit balance")
        || lower.contains("insufficient credit")
        || lower.contains("insufficient_credit")
    {
        GoalStatus::UsageLimited
    } else {
        // The engine already performed in-turn provider retries. Pause the outer goal
        // here to prevent an infinite TUI continuation loop while allowing the user or
        // headless scheduler to resume after repairing the environment. Only update_goal's
        // three-turn audit may produce Blocked; never infer it from error text.
        GoalStatus::Paused
    }
}

/// Render a one-line summary of a background event for the synthetic
/// follow-up nudge the idle watcher injects into the main conversation.
fn background_followup_key_is_live(engine: &QueryEngine, key: &str) -> bool {
    match serde_json::from_str::<kcoder_types::BackgroundRunKey>(key) {
        Ok(run) => {
            engine
                .state
                .task_for_background_run(&run)
                .is_some_and(|task| {
                    matches!(task.kind, kcoder_state::TaskKind::Subagent)
                        && task.notify_parent_on_completion
                })
                && engine
                    .state
                    .background_run_record(&run)
                    .is_some_and(|record| {
                        !record.suppressed && !record.followup_started && !record.followup_handled
                    })
        }
        Err(_) => engine.background_job_triggers_followup(key),
    }
}

fn background_event_id(event: &EngineEvent) -> Option<&str> {
    match event.background_payload() {
        EngineEvent::BackgroundJobStarted { id, .. }
        | EngineEvent::BackgroundJobCompleted { id, .. }
        | EngineEvent::BackgroundJobFailed { id, .. }
        | EngineEvent::BackgroundJobPaused { id, .. }
        | EngineEvent::BackgroundJobHalted { id, .. }
        | EngineEvent::BackgroundJobCancelled { id, .. } => Some(id),
        _ => None,
    }
}

fn format_background_event(event: &EngineEvent) -> String {
    match event.background_payload() {
        EngineEvent::BackgroundJobStarted { id, description } => {
            format!("[started: {id} — {description}]")
        }
        EngineEvent::BackgroundJobCompleted { id, .. } => {
            format!("[completed: {id}]")
        }
        EngineEvent::BackgroundJobFailed { id, error } => {
            format!("[failed: {id} — {error}]")
        }
        EngineEvent::BackgroundJobPaused { id, reason } => {
            format!("[paused: {id} — {reason}]")
        }
        EngineEvent::BackgroundJobHalted { id, reason } => {
            format!("[halted: {id} — {reason}]")
        }
        EngineEvent::BackgroundJobCancelled { id, reason } => {
            format!("[cancelled: {id} — {reason}]")
        }
        _ => "[other event]".to_string(),
    }
}

#[cfg(test)]
fn format_goal_continuation_prompt(goal: &Goal) -> String {
    let decision = kcoder_engine::goal_continuation::plan_goal_continuation(true, goal, None)
        .unwrap_or(kcoder_engine::goal_continuation::GoalContinuationDecision {
            stall_nudge: false,
            premature_stop: None,
        });
    kcoder_engine::goal_continuation::format_goal_continuation_prompt(goal, &decision)
}

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
