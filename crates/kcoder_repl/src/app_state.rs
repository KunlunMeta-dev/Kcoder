//! Shared REPL state, defaults, and presentation metadata. The app remains the sole state owner.

use super::*;

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

pub(super) fn non_empty_setting(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub(super) const SPINNER_INTERVAL_MS: u64 = 80;
pub(super) const COMMIT_TICK_INTERVAL_MS: u64 = 320;
pub(super) const STREAM_TEXT_PRESENTATION_INTERVAL_MS: u64 = 67;
pub(super) const STREAM_TEXT_SMOOTH_GRAPHEMES_PER_TICK: usize = 32;
pub(super) const STREAM_TEXT_CATCH_UP_PENDING_GRAPHEMES: usize = 384;
pub(super) const STREAM_TEXT_CATCH_UP_GRAPHEMES_PER_TICK: usize = 192;
pub(super) const STREAM_SMOOTH_COMMIT_SOURCE_LINES: usize = 1;
pub(super) const STREAM_CATCH_UP_QUEUE_DEPTH_LINES: usize = 8;
pub(super) const STREAM_CATCH_UP_COMMIT_SOURCE_LINES: usize = 8;
/// Maximum transcript height retained for the current streaming turn in inline mode.
pub(super) const INLINE_ACTIVE_TRANSCRIPT_MAX_ROWS: usize = 6;
pub(super) const DEBUG_STARTUP_A_LINES_ENV: &str = "KCODER_TUI_DEBUG_STARTUP_A_LINES";
pub(super) const DEBUG_STARTUP_A_LINES_MAX: usize = 5_000;
/// Maximum number of queued events to coalesce before giving the renderer a
/// chance to flush a frame. Without this, a fast streaming provider can keep
/// the channel non-empty indefinitely and starve redraw until a resize event.
pub(super) const EVENT_BATCH_MAX_EVENTS: usize = 128;
/// Time budget for one event coalescing pass. This is deliberately below the
/// frame-rate cap so streaming can stay smooth without making the UI wait for
/// the event queue to become completely empty.
pub(super) const EVENT_BATCH_MAX_DURATION: Duration = Duration::from_millis(8);
/// Prevent fast-returning `/goal` turns from hot-looping and flooding the
/// transcript when the model has not marked the objective complete or blocked.
pub(super) const GOAL_CONTINUATION_COOLDOWN: Duration = Duration::from_millis(1_500);
/// Scrolling should keep several screens of context around the viewport, but
/// dragging a scrollbar must not rebuild the large review window on every
/// mouse move.
pub(super) const FULLSCREEN_SCROLL_RENDER_OVERSCAN_MULTIPLIER: usize = 6;
pub(super) const FULLSCREEN_SCROLL_RENDER_MAX_ROWS: usize = 1_000;
/// Near the live tail, a small skipped prefix is cheap to render exactly and
/// keeps the scrollbar thumb from jumping between exact tail rows and the
/// coarser row index estimate.
pub(super) const FULLSCREEN_EXACT_TAIL_PREFIX_MAX_MESSAGES: usize = 32;
/// Enable a time-bounded press-again interaction for idle Ctrl+C exits.
pub(super) const DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED: bool = true;
pub(super) const QUIT_SHORTCUT_WINDOW: Duration = Duration::from_secs(1);
pub(super) const TRANSIENT_STATUS_TTL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ReasoningShortcutDirection {
    Lower,
    Raise,
}

impl ReasoningShortcutDirection {
    pub(super) fn bound_message(self, effort: &ReasoningEffort) -> String {
        let label = reasoning_effort_sentence_label(effort);
        match self {
            Self::Lower => format!("Reasoning is already at the lowest level ({label})."),
            Self::Raise => format!("Reasoning is already at the highest level ({label})."),
        }
    }
}

pub(super) fn reasoning_shortcut_choices() -> [ReasoningEffort; 5] {
    [
        ReasoningEffort::Minimal,
        ReasoningEffort::Low,
        ReasoningEffort::Medium,
        ReasoningEffort::High,
        ReasoningEffort::XHigh,
    ]
}

pub(super) fn reasoning_effort_sentence_label(effort: &ReasoningEffort) -> String {
    match effort {
        ReasoningEffort::XHigh => "extra high".to_string(),
        ReasoningEffort::Custom(value) => value.clone(),
        _ => effort.as_str().to_string(),
    }
}

pub(super) fn reasoning_shortcut_anchor(current: Option<&ReasoningEffort>) -> ReasoningEffort {
    let configured = current.cloned().unwrap_or(ReasoningEffort::Medium);
    if reasoning_shortcut_choices().contains(&configured) {
        configured
    } else {
        ReasoningEffort::Medium
    }
}

pub(super) fn next_reasoning_effort(
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

pub(super) fn model_footer_label(model: &str, effort: Option<&ReasoningEffort>) -> String {
    match effort {
        Some(ReasoningEffort::None) | None => model.to_string(),
        Some(effort) => format!("{model} {}", effort.as_str()),
    }
}

pub(super) fn shell_command_from_prompt(text: &str) -> Option<String> {
    text.trim_start()
        .strip_prefix('!')
        .map(|command| command.trim().to_string())
}

pub(super) fn is_ctrl_c_key(key: &KeyEvent) -> bool {
    let altgr = key_hint::is_altgr(key.modifiers);
    (key_hint::ctrl(KeyCode::Char('c')).is_press(*key)
        || matches!(key.code, KeyCode::Char(c) if c.eq_ignore_ascii_case(&'c'))
            && key.modifiers.contains(KeyModifiers::CONTROL))
        && !altgr
}

pub(super) fn is_suspend_key(key: &KeyEvent) -> bool {
    let altgr = key_hint::is_altgr(key.modifiers);
    key_hint::ctrl(KeyCode::Char('z')).is_press(*key) && !altgr
}

pub(super) fn is_transcript_overlay_shortcut(key: &KeyEvent) -> bool {
    let altgr = key_hint::is_altgr(key.modifiers);
    !altgr && key_hint::ctrl(KeyCode::Char('t')).is_press(*key)
}

pub(super) fn is_tool_transcript_toggle_shortcut(key: &KeyEvent) -> bool {
    let altgr = key_hint::is_altgr(key.modifiers);
    !altgr && key_hint::alt(KeyCode::Char('t')).is_press(*key)
}

/// Pastes longer than this collapse into a `[Pasted Content N chars]`
/// placeholder in the composer (the full text is stored and expanded on
/// submit), so big pastes never blow up the input area.
pub(super) const LARGE_PASTE_CHAR_THRESHOLD: usize = 300;
pub(super) const PERMISSION_OPTION_RESPONSES: [PermissionResponse; 7] = [
    PermissionResponse::AllowOnce,
    PermissionResponse::AllowAlways,
    PermissionResponse::AllowForSession,
    PermissionResponse::DenyOnce,
    PermissionResponse::DenyAlways,
    PermissionResponse::DenyForSession,
    PermissionResponse::Edit,
];
pub(super) const QUESTION_DIALOG_DEFAULT_VISIBLE_OPTIONS: usize = 5;
/// Small transcript scroll step used for terminal alternate-scroll key events.
pub(super) const TRANSCRIPT_SCROLL_LINES: i32 = 3;
/// Maximum number of follow-up user messages held while a turn is running.
pub(super) const USER_MESSAGE_QUEUE_MAX: usize = 64;
pub(super) const USER_SHELL_COMMAND_HELP_TITLE: &str = "Prefix a command with ! to run it locally";
pub(super) const USER_SHELL_COMMAND_HELP_HINT: &str = "Example: !ls";

#[derive(Debug, Clone)]
pub(super) struct PendingBackgroundFollowup {
    /// One id per event, same order. Cron-originated entries use an empty id
    /// and always survive validation.
    pub(super) ids: Vec<String>,
    pub(super) events: Vec<String>,
    pub(super) summary: String,
}

impl PendingBackgroundFollowup {
    /// Drop queued events whose sub-agent no longer exists or no longer
    /// triggers a follow-up (for example after `close_agent`). Cron entries
    /// carry an empty id and always stay.
    pub(super) fn retain_followup_tasks(&mut self, engine: &QueryEngine) {
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
pub(super) struct QueuedUserMessage {
    pub(super) model_message: Message,
    pub(super) display_message: Message,
    pub(super) restore_text: String,
    pub(super) local_image_attachments: Vec<LocalImageAttachment>,
    pub(super) remote_image_urls: Vec<String>,
    pub(super) pending_pastes: Vec<(String, String)>,
    pub(super) action: QueuedInputAction,
}

#[derive(Debug, Clone)]
pub(super) struct PendingTurnSteer {
    pub(super) id: u64,
    pub(super) message: QueuedUserMessage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum QueuedInputAction {
    Plain,
    Slash,
    RunShell,
}

#[derive(Debug, Clone)]
pub(super) enum QueuedTurnInput {
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
    pub(super) fn from_model_message(model_message: Message) -> Self {
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

    pub(super) fn from_submitted(model_message: Message, submitted: &SubmittedMessage) -> Self {
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

    pub(super) fn from_shell_prompt(history_text: String) -> Self {
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

    pub(super) fn from_slash_command(command: String) -> Self {
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

    pub(super) fn into_turn_input(self) -> QueuedTurnInput {
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
pub(super) struct ActiveTurnRenderCacheKey {
    pub(super) active_render_revision: u64,
    pub(super) active_tools_expanded: bool,
    pub(super) tool_transcript_expanded: bool,
    pub(super) render_markdown: bool,
    pub(super) code_theme: String,
    pub(super) width: u16,
    pub(super) tool_summary_indicator: &'static str,
}

#[derive(Debug, Clone)]
pub(super) struct ActiveTurnRenderCache {
    pub(super) key: ActiveTurnRenderCacheKey,
    pub(super) lines: Vec<Line<'static>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FullscreenTranscriptRenderCacheKey {
    pub(super) width: u16,
    pub(super) row_budget: usize,
    pub(super) render_budget: usize,
    pub(super) messages_len: usize,
    pub(super) messages_epoch: u64,
    pub(super) transcript_scroll: TranscriptScroll,
    pub(super) active_render_revision: u64,
    pub(super) active_display_rows: usize,
    pub(super) active_tools_expanded: bool,
    pub(super) tool_transcript_expanded: bool,
    pub(super) render_markdown: bool,
    pub(super) code_theme: String,
    pub(super) welcome_info: Option<StartupWelcomeInfo>,
    pub(super) startup_idle_surface_active: bool,
    pub(super) scrollbar_fast_path_active: bool,
    pub(super) scrollbar_drag_active: bool,
    pub(super) tool_summary_indicator: &'static str,
    pub(super) subagent_animation_frame: u8,
}

#[derive(Debug, Clone)]
pub(super) struct FullscreenTranscriptRenderCache {
    pub(super) key: FullscreenTranscriptRenderCacheKey,
    pub(super) render: FullscreenTranscriptRender,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum OverlayKind {
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
pub(super) enum SideQuestionStatus {
    Loading,
    Answered(String),
    Failed(String),
}

#[derive(Debug)]
pub(super) struct SideQuestionOverlay {
    pub(super) id: u64,
    pub(super) question: String,
    pub(super) status: SideQuestionStatus,
    pub(super) scroll: u16,
    pub(super) cancel: CancellationToken,
    pub(super) started_at: Instant,
}

#[derive(Debug, Clone)]
pub(super) struct MentionMenu {
    pub(super) replace_start: usize,
    pub(super) replace_end: usize,
    pub(super) candidates: Vec<String>,
    pub(super) selected: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct ResumeSessionEntry {
    pub(crate) session_id: String,
    pub(crate) path: PathBuf,
    pub(crate) preview: Option<String>,
}

pub(super) const RESUME_TRANSCRIPT_INITIAL_MESSAGES: usize = TRANSCRIPT_RENDER_MAX_MESSAGES * 2;

#[derive(Debug)]
pub(super) struct DeferredResumedTranscript {
    pub(super) history: PreparedTranscriptHistory,
    /// Number of DisplayMessages occupied by the transformed resumed tail; later entries were appended after resume.
    pub(super) loaded_display_len: usize,
}

#[derive(Debug, Clone)]
pub(super) struct ResumeSessionPicker {
    pub(super) entries: Vec<ResumeSessionEntry>,
    pub(super) selected: usize,
    pub(super) filter: String,
}

#[derive(Default)]
pub(super) enum TurnState {
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
    pub(super) fn is_active(&self) -> bool {
        !matches!(self, Self::Idle)
    }

    pub(super) fn cancel_flag(&self) -> Option<&CancellationToken> {
        match self {
            Self::Starting { cancel, .. } | Self::Running { cancel, .. } => Some(cancel),
            Self::Idle | Self::Finishing { .. } => None,
        }
    }
}

pub(super) fn recover_read_lock<'a, T>(
    lock: &'a RwLock<T>,
    name: &str,
) -> std::sync::RwLockReadGuard<'a, T> {
    match lock.read() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!(lock = name, "recovering poisoned read lock");
            poisoned.into_inner()
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LineLimitMode {
    Head,
    Tail,
}

#[derive(Debug, Clone)]
pub(super) struct FullscreenTranscriptRender {
    pub(super) lines: Vec<Line<'static>>,
    pub(super) total_rows: usize,
    pub(super) top: usize,
    pub(super) local_top: usize,
}

#[derive(Debug, Clone)]
pub(super) struct TransientStatus {
    pub(super) text: String,
    pub(super) expires_at: Instant,
}

impl TransientStatus {
    pub(super) fn new(text: impl Into<String>, now: Instant) -> Self {
        Self {
            text: text.into(),
            expires_at: now + TRANSIENT_STATUS_TTL,
        }
    }

    pub(super) fn is_active_at(&self, now: Instant) -> bool {
        now < self.expires_at
    }

    pub(super) fn remaining_at(&self, now: Instant) -> Duration {
        self.expires_at.saturating_duration_since(now)
    }
}

pub(super) fn normalize_pasted_search_query(pasted: &str) -> Option<String> {
    let sanitized = sanitize_tui_text(pasted);
    let normalized = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then_some(normalized)
}

pub(super) fn reasoning_summary_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| format!("{THINKING_MESSAGE_PREFIX}{trimmed}"))
}

pub(super) fn reasoning_status_detail(text: &str) -> Option<String> {
    (!text.trim().is_empty()).then(|| "Thinking".to_string())
}

#[derive(Clone, Default)]
pub(super) struct ComposerKillBuffer {
    pub(super) text: String,
    pub(super) pending_pastes: Vec<(String, String)>,
    pub(super) local_image_attachments: Vec<LocalImageAttachment>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ComposerDraftSnapshot {
    pub(super) input: String,
    pub(super) cursor_grapheme_index: usize,
    pub(super) pending_pastes: Vec<(String, String)>,
    pub(super) local_image_attachments: Vec<LocalImageAttachment>,
    pub(super) remote_image_urls: Vec<String>,
    pub(super) selected_remote_image_index: Option<usize>,
}

#[derive(Clone, Debug)]
pub(super) struct PendingSubagentProgress {
    pub(super) message: String,
    pub(super) detail: Option<String>,
    pub(super) current: Option<usize>,
    pub(super) total: Option<usize>,
    pub(super) promoted: bool,
}

#[derive(Clone, Debug)]
pub(super) struct PendingSubagentSteerApplied {
    pub(super) message_id: String,
    pub(super) queue_depth: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct AgentTranscriptFingerprint {
    pub(super) len: u64,
    pub(super) modified: Option<SystemTime>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PendingAgentViewSteer {
    pub(super) message_id: String,
    pub(super) body: String,
}

#[derive(Debug)]
pub(super) struct AgentViewState {
    pub(super) live_revision: Option<u64>,
    pub(super) agent_id: String,
    pub(super) display_name: String,
    pub(super) steer_status: Option<String>,
    pub(super) transcript_path: PathBuf,
    pub(super) transcript: TranscriptStore,
    pub(super) fingerprint: Option<AgentTranscriptFingerprint>,
    pub(super) pending_steers: Vec<PendingAgentViewSteer>,
    pub(super) parent_viewport: TranscriptViewport,
    pub(super) parent_navigation: transcript_navigation::NavigationState,
    pub(super) parent_outline: transcript_outline::OutlineModel,
    pub(super) refresh_after: Instant,
    pub(super) load_error: Option<String>,
}

impl ComposerKillBuffer {
    pub(super) fn is_empty(&self) -> bool {
        self.text.is_empty()
    }
}

#[derive(Debug, Clone)]
pub(super) struct ModelDiscoveryCache {
    pub(super) fetched_at: Instant,
    pub(super) groups: Vec<DiscoveredModelGroup>,
}

/// Minimal REPL application state.
pub struct ReplApp {
    pub messages: TranscriptStore,
    /// Full-screen resume loads only the tail synchronously; full history is read from the offset index on the user's first explicit review.
    pub(super) deferred_resumed_transcript: Option<DeferredResumedTranscript>,
    pub(super) welcome_component_mounted: bool,
    pub(super) welcome_scrollback_committed: bool,
    pub(super) startup_live_viewport_top_limit: Option<u16>,
    pub(super) input: String,
    pub(super) cursor_grapheme_index: usize,
    /// Display column retained across repeated vertical cursor movements.
    pub(super) composer_preferred_col: Option<usize>,
    pub(super) input_scroll_row: usize,
    pub(super) last_input_width: u16,
    /// Single-entry readline kill buffer used by Ctrl+Y.
    pub(super) composer_kill_buffer: ComposerKillBuffer,
    /// Retains native Linux clipboard ownership so copied text remains pasteable.
    pub(super) clipboard_lease: Option<clipboard_copy::ClipboardLease>,
    /// Wall-clock instant of the most recent successful Enter-submit. Used
    /// to rate-limit repeated Enter presses so a user mashing the key
    /// cannot flood the model with empty/duplicated submissions while a
    /// turn is in flight.
    pub(super) last_submit_at: Option<std::time::Instant>,
    pub(super) is_loading: bool,
    /// Authoritative transcript viewport, wheel, layout, and scrollbar state.
    pub(super) transcript_viewport: TranscriptViewport,
    pub(super) navigation: transcript_navigation::NavigationState,
    pub(super) outline: transcript_outline::OutlineModel,
    pub(super) outline_open: bool,
    pub(super) outline_geometry: Option<widgets::outline::OutlineGeometry>,
    pub(super) outline_press: Option<widgets::outline::OutlineHit>,
    pub(super) navigation_footer: Vec<(Rect, &'static str)>,
    pub(super) navigation_footer_press: Option<(Rect, &'static str)>,
    /// Number of stable transcript messages already written into the
    /// terminal's native scrollback when running the legacy inline surface.
    /// These messages stay in `messages` for session state, but are skipped by
    /// the hot live viewport renderer only in that legacy mode.
    pub(super) scrollback_committed_until: usize,
    /// Resize-reflow scheduler for legacy KCoder-owned native terminal scrollback.
    pub(super) transcript_reflow: TranscriptReflowState,
    /// Current draw target. Fullscreen mode owns the whole terminal buffer and
    /// keeps transcript history inside the TUI instead of native scrollback.
    pub(super) fullscreen_surface: bool,
    /// Full terminal area from the last draw, used for mouse hit testing.
    pub(super) last_frame_area: Option<ratatui::layout::Rect>,
    /// Plain text rows visible in the last rendered transcript area.
    pub(super) last_transcript_visible_rows: Vec<String>,
    /// Active transcript mouse selection in visible row/column coordinates.
    pub(super) transcript_selection: Option<TranscriptSelection>,
    pub(super) transcript_selection_rows: Option<Vec<String>>,
    /// Whether the left mouse button is currently selecting transcript text.
    pub(super) transcript_selection_drag_active: bool,
    /// Last rendered transient bottom overlay area (`/` menu, shortcut help).
    pub(super) last_bottom_overlay_area: Option<ratatui::layout::Rect>,
    /// Last rendered composer outer area.
    pub(super) last_composer_area: Option<ratatui::layout::Rect>,
    /// Last rendered composer inner content area.
    pub(super) last_composer_content: Option<ratatui::layout::Rect>,
    /// Force the next terminal draw to ignore the previous buffer. This is
    /// used after clearing submitted input so stale wide-character cells in
    /// the real terminal cannot survive next to the placeholder.
    pub(super) force_viewport_redraw: bool,
    /// Terminal emulators may preserve/reflow old cells when the visible size
    /// changes. The next draw after a resize must reset the physical live
    /// surface, not only the ratatui diff buffer.
    pub(super) resize_viewport_reset_pending: bool,
    /// Last known mouse position for hover/tooltip handling.
    pub(super) last_mouse_pos: Option<(u16, u16)>,
    /// Whether the most recent tool result is expanded in the TUI.
    /// Whether tool result messages are expanded in the TUI.
    pub(super) last_tool_output_expanded: bool,
    /// Whether collapsed tool runs are expanded back into transcript order.
    pub(super) tool_transcript_expanded: bool,
    /// Whether the in-flight active tools summary is expanded.
    pub(super) active_tools_expanded: bool,
    /// Active permission prompt waiting for user input.
    pub(super) pending_permission: Option<PermissionDialog>,
    /// Active permission input editor overlay.
    pub(super) permission_editor: Option<PermissionEditor>,
    /// Permission prompts queued while another modal is active.
    pub(super) permission_queue: VecDeque<PermissionDialog>,
    /// Active user question dialog overlay.
    pub(super) pending_question: Option<QuestionDialog>,
    /// Local confirmation dialog for replacing an unfinished `/goal`.
    pub(super) pending_goal_replacement: Option<GoalReplacementDialog>,
    /// User questions queued while another modal is active.
    pub(super) question_queue: VecDeque<QuestionDialog>,
    /// Background sub-agent status hints. Rendered in compact status surfaces
    /// rather than in the transcript so the user does not confuse them for
    /// assistant output. Capped at a small ring so a long session does not
    /// leak memory.
    pub(super) background_job_hints: Vec<BackgroundJobHint>,
    pub(super) background_job_lifetimes: HashMap<String, BackgroundJobLifetimeHint>,
    /// Latest lifecycle heartbeat for each running managed job. Kept separate
    /// from lifecycle hints so old persisted/test hint literals remain small.
    pub(super) background_job_progress: HashMap<String, BackgroundJobProgressHint>,
    /// Structured sub-agent groups. The same snapshot backs both
    /// active-turn entries and already committed transcript cells.
    pub(super) subagent_panels: HashMap<u64, SubagentPanel>,
    pub(super) subagent_panel_by_agent: HashMap<String, u64>,
    pub(super) pending_subagent_terminal: HashMap<String, (SubagentPhase, String)>,
    pub(super) pending_subagent_progress: HashMap<String, PendingSubagentProgress>,
    pub(super) pending_subagent_steer_applied: HashMap<String, PendingSubagentSteerApplied>,
    pub(super) pending_subagent_associations: HashMap<String, (String, bool)>,
    pub(super) pending_send_message_inputs: HashMap<String, String>,
    pub(super) agent_view: Option<AgentViewState>,
    pub(super) open_subagent_panel: Option<u64>,
    pub(super) next_subagent_panel_id: u64,
    pub(super) subagent_animation_started_at: Instant,
    /// User input waiting for a later turn. During a steerable regular turn, normal
    /// input goes to `pending_turn_steers`; slash commands, shell commands, and
    /// non-steerable foreground operations continue to use this queue.
    pub(super) user_message_queue: VecDeque<QueuedUserMessage>,
    pub(super) queued_model_error: Option<String>,
    /// Input accepted by the engine and waiting to enter the current regular turn.
    /// It remains here for rendering and recovery until the engine confirms that
    /// each item crossed a safe model boundary.
    pub(super) pending_turn_steers: VecDeque<PendingTurnSteer>,
    /// Steering input still unapplied when a turn ends; prioritized when scheduling the next regular turn.
    pub(super) rejected_turn_steers: VecDeque<QueuedUserMessage>,
    pub(super) next_turn_steer_id: u64,
    /// Background follow-up requests waiting for the next non-user turn.
    pub(super) pending_background_followups: VecDeque<PendingBackgroundFollowup>,
    pub(super) active_background_followup: Option<(Vec<kcoder_types::BackgroundRunKey>, String)>,
    /// Per-goal automatic continuation counts for this process. The persisted
    /// `continuation_count` is audit-only and must not let one restart disable continuations permanently.
    pub(super) goal_auto_continuations_started: HashMap<String, usize>,
    /// Goals for which the continuation-limit notice has been shown, preventing repeated notices on idle wakeups.
    pub(super) goal_auto_continuation_limit_notices: HashSet<String>,
    /// Current-process marker passed by the harness through a one-time inherited pipe.
    /// Read and close the descriptor at startup so agent shells and providers cannot receive the token.
    pub(super) goal_auto_continuation_notice_marker: String,
    /// Local image files attached to the current composer draft.
    pub(super) local_image_attachments: Vec<LocalImageAttachment>,
    /// Remote image URLs rehydrated from history/backtrack and rendered above the composer.
    pub(super) remote_image_urls: Vec<String>,
    /// Highlighted remote image row, if keyboard navigation has selected one.
    pub(super) selected_remote_image_index: Option<usize>,
    /// Large paste payloads hidden behind visible placeholders in the composer.
    pub(super) pending_pastes: Vec<(String, String)>,
    /// Prevent duplicate clipboard reads while native clipboard APIs are blocked.
    pub(super) clipboard_image_paste_in_flight: bool,
    /// Active history search overlay.
    pub(super) history_search: Option<HistorySearch>,
    /// Active previous-session picker rendered in the committed transcript area.
    pub(super) resume_session_picker: Option<ResumeSessionPicker>,
    /// Active slash-command picker overlay.
    pub(super) slash_menu: Option<SlashMenu>,
    /// File candidates for the `@path` fragment at the composer cursor.
    pub(super) mention_menu: Option<MentionMenu>,
    pub(super) mention_file_index: Vec<String>,
    /// Active context inspector overlay.
    pub(super) context_inspector: Option<ContextInspector>,
    /// Active settings inspector overlay.
    pub(super) settings_inspector: Option<SettingsInspector>,
    /// Active generic picker overlay.
    pub(super) picker_overlay: Option<PickerOverlay>,
    pub(super) model_discovery_cache: Option<ModelDiscoveryCache>,
    pub(super) warned_discovered_models: HashSet<String>,
    /// Active keyboard-shortcuts help overlay.
    pub(super) keys_overlay: Option<KeysOverlay>,
    /// Multi-line shortcut help rendered in the footer.
    pub(super) footer_shortcuts_overlay: bool,
    /// Final frame state shown before a user-requested shutdown clears the
    /// terminal viewport.
    pub(super) shutdown_in_progress: bool,
    /// Active full transcript pager overlay.
    pub(super) transcript_overlay: Option<TranscriptOverlay>,
    pub(super) copy_view: Option<copy_view::CopyView>,
    /// Isolated one-shot answer shown outside the main transcript.
    pub(super) side_question_overlay: Option<SideQuestionOverlay>,
    pub(super) side_question_sequence: u64,
    /// Single active overlay kind, kept in sync with the overlay payload
    /// fields above so routing can rely on one state machine.
    pub(super) active_overlay: Option<OverlayKind>,
    /// Registered slash commands.
    pub(super) slash_registry: Arc<slash::SlashRegistry>,
    /// Whether to render assistant output as Markdown.
    pub(super) render_markdown: bool,
    /// Whether transcript output should favor raw text for terminal selection.
    pub(super) raw_output_mode: bool,
    /// Code theme for syntax highlighting.
    pub(super) code_theme: String,
    /// In-flight content for the current assistant turn. Holds streaming text,
    /// thinking, and tool statuses so they render as one stable cell instead of
    /// bouncing the transcript as tool messages are added.
    pub(super) active_turn: Option<ActiveCell>,
    /// O(1) presentation identity for the active turn. Streaming deltas bump
    /// this revision instead of hashing the entire growing response per frame.
    pub(super) active_turn_render_revision: u64,
    /// Cached rendered lines for the active turn tail. This avoids re-running
    /// markdown parsing and tool formatting on spinner/status redraws while
    /// the stream content itself has not changed.
    pub(super) active_turn_render_cache: Option<ActiveTurnRenderCache>,
    /// Content-addressed blocks for the fullscreen live tail. Stable committed
    /// and completed active blocks survive updates to the final streaming part.
    pub(super) keyed_transcript_block_render_cache: KeyedTranscriptBlockRenderCache,
    /// Cached fullscreen transcript render. In fullscreen mode, footer/status
    /// animation should not rebuild the committed transcript surface when the
    /// message data, scroll position, and active turn content are unchanged.
    pub(super) fullscreen_transcript_render_cache: Option<FullscreenTranscriptRenderCache>,
    /// True after a turn has used its one-shot streaming redraw seed. Streaming
    /// deltas are normally coalesced by frame ticks; this only protects unusual
    /// event ordering where a delta arrives before any tick-producing event.
    pub(super) streaming_delta_redraw_seeded: bool,
    /// Raw assistant text deltas that have arrived from the provider but have
    /// not yet been presented in the live active turn. Model output is collected
    /// immediately, then frame ticks reveal it at a bounded pace so large
    /// provider chunks do not pop in as a single wall of text.
    pub(super) streaming_text_pending: String,
    /// The API has ended the current assistant message, but pending text still
    /// needs to be presented before final commit/consolidation.
    pub(super) streaming_message_done_pending: bool,
    /// TurnFinished arrived while the presentation queue was still draining.
    /// Keep the TUI turn visually alive until the queued text is visible, then
    /// run the normal finish path exactly once.
    pub(super) deferred_turn_finish_pending: bool,
    pub(super) deferred_turn_finish_handle: Option<JoinHandle<()>>,
    /// Whether assistant text is actively streaming. Delta redraws are still
    /// coalesced by frame ticks; fullscreen keeps stable chunks inside the TUI
    /// transcript, while the legacy inline surface may move them into terminal
    /// scrollback.
    pub(super) streaming_output_active: bool,
    /// Keep the status row hidden after ordinary final-answer streaming until
    /// the turn actually finishes, unless a queued follow-up needs a visible
    /// running affordance.
    pub(super) streaming_status_suppressed_after_output: bool,
    /// Index where the current assistant stream first committed source lines
    /// into the transcript. Used only to consolidate adjacent stream chunks in
    /// source history after finalization; legacy inline terminals may already
    /// have seen those chunks in scrollback.
    pub(super) streaming_transcript_start: Option<usize>,
    /// Transcript index where the most recent model turn started. Tool messages
    /// at or after this point stay expanded while the user is watching the live
    /// turn; older transcript history can still collapse into summaries.
    pub(super) recent_turn_transcript_start: Option<usize>,
    /// Live reasoning/thinking status text. Reasoning deltas stay out of
    /// streaming history and drive status instead.
    pub(super) streaming_thinking_status: String,
    /// Full live reasoning/thinking buffer used to build a compact summary
    /// when the reasoning block ends.
    pub(super) streaming_thinking_buffer: String,
    /// Frame-rate limiter to avoid redrawing faster than 15 FPS during
    /// streaming.
    pub(super) frame_rate_limiter: FrameRateLimiter,
    /// Time window for the double-press quit shortcut.
    pub(super) quit_shortcut_expires_at: Option<Instant>,
    /// The specific key that must be pressed again to quit.
    pub(super) quit_shortcut_key: Option<key_hint::KeyBinding>,
    /// Footer-only hint shown after Esc dismisses another transient footer mode.
    pub(super) edit_previous_hint_visible: bool,
    /// True after the first idle Esc press arms edit-previous mode.
    pub(super) edit_previous_primed: bool,
    /// Short-lived footer/status text for local UI actions such as copy.
    pub(super) transient_status: Option<TransientStatus>,
    /// Spinner animation state.
    pub(super) spinner: SpinnerState,
    /// Single owner for the scheduled/running model turn task and cancellation
    /// flag. Only the TUI event loop mutates this state.
    pub(super) turn_state: TurnState,
    /// Label for foreground work that uses the turn lifecycle without
    /// producing assistant stream events, such as manual compaction.
    pub(super) foreground_operation_label: Option<String>,
    pub(super) path_previews: path_preview::PathPreviews,
    /// Wall-clock start of the current turn, used for the transcript divider
    /// appended when the turn finishes.
    pub(super) turn_started_at: Option<Instant>,
    /// Whether the current turn performed concrete tool work. Final message
    /// separators render only for turns that did work, not for ordinary
    /// conversational replies.
    pub(super) turn_had_work_activity: bool,
    /// Session working directory displayed in the header.
    pub(super) display_cwd: String,
    /// Model name displayed in the header.
    pub(super) model_name: String,
    /// Runtime reasoning effort displayed in status surfaces and sent to compatible providers.
    pub(super) reasoning_effort: Option<ReasoningEffort>,
    /// Provider name for status surfaces.
    pub(super) provider_name: String,
    /// Session identifier.
    pub(super) session_id: String,
    /// Local user-facing session title set by `/rename`.
    pub(super) session_title: Option<String>,
    /// Last sanitized terminal title emitted by KCoder.
    pub(super) last_terminal_title: Option<String>,
    /// Current plan-mode instructions, if active.
    pub(super) plan_mode: Option<String>,
    /// Session-level read-only orchestration mode used to display a persistent, non-dismissible status badge.
    pub(super) session_mode: SessionMode,
    /// Cached progress for active orchestration work, avoiding a PlanStore read on every frame.
    pub(super) orchestrate_progress_label: Option<String>,
    /// Current `/goal` status shown in the compact status area.
    pub(super) goal: Option<Goal>,
    /// Current TodoWrite checklist shown in the TUI status area.
    pub(super) todos: Vec<TodoItem>,
    /// Estimated token count of the current conversation.
    pub(super) token_count: usize,
    /// Total effective context window for the active model.
    pub(super) token_total: usize,
    /// Auto-compaction threshold in tokens.
    pub(super) token_threshold: usize,
    /// Cached rendered lines for committed messages.
    pub(super) render_cache: RenderCache,
    /// Cached estimated row offsets for fullscreen transcript scrollbar drag.
    pub(super) transcript_row_index: TranscriptRowIndex,
    /// Persistent user input history (previous prompts submitted in this or
    /// prior sessions).
    pub(super) input_history: Vec<String>,
    /// Current position when cycling through input history.
    pub(super) input_history_index: Option<usize>,
    /// Path where input history is persisted.
    pub(super) input_history_path: Option<std::path::PathBuf>,
    /// Serializes history snapshots and lets stale queued writes skip themselves.
    pub(super) input_history_save_lock: Arc<Mutex<()>>,
    pub(super) input_history_save_revision: Arc<AtomicU64>,
    /// Unsubmitted input preserved while cycling through history.
    pub(super) input_history_draft: Option<ComposerDraftSnapshot>,
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

pub(super) fn sanitize_write_input_preview(mut preview: WriteInputPreview) -> WriteInputPreview {
    preview.path = preview.path.map(|path| sanitize_tui_text(&path));
    preview.lines = preview
        .lines
        .into_iter()
        .map(|line| sanitize_tui_text(&line))
        .collect();
    preview
}
