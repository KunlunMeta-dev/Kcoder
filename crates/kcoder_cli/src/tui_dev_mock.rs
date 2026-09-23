use clap::ValueEnum;
use kcoder_api::{Provider, ProviderStream};
use kcoder_types::MessagesRequest;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tracing::warn;

mod scenario_events;

use scenario_events::{
    is_targeted_steer_worker, request_has_subagent_notification, request_text_contains,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub(super) enum TuiDevScenario {
    /// Full deterministic agent turn: user message, thinking, tool call, tool result, final text.
    FullTurn,
    /// Longer deterministic output for tail-follow, review, and completion-boundary checks.
    TailFollow,
    /// Compact rendering fixture covering the complete Markdown style vocabulary.
    MarkdownShowcase,
    /// Streaming-code and final Markdown-color regression exceeding the former 64 KiB threshold.
    MarkdownStreaming,
    /// Deterministic long-running bash call for busy-indicator recording and review.
    BusyWait,
    /// Stream a 20K write input, execute it, delete the file, and finish the turn.
    LongWrite,
    /// Stream many reasoning deltas for fixed-height live-preview recording.
    ThinkingPreview,
    /// Deterministic mixed tool storm: read, grep, TodoWrite, bash, and edit/diff in one turn.
    MixedTools,
    /// Write invalid Python and verify real LSP diagnostics enter the next model request.
    LspDiagnostics,
    /// Ask the model to run the built-in OpenCodeReview preview tool.
    OcrReview,
    /// Spawn a sub-agent and verify per-sub-agent trace artifacts.
    SubagentTrace,
    /// Exercise `/goal-pro`: request completion, run verifier, and finish only after PASS.
    GoalPro,
    /// Exercise an Orchestrate-safe main turn using only the read-only tool surface.
    Orchestrate,
    /// Spawn, pause and enqueue to a child, then inspect the trusted Fleet/control surface.
    OrchestrateControl,
}

impl TuiDevScenario {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::FullTurn => "full-turn",
            Self::TailFollow => "tail-follow",
            Self::MarkdownShowcase => "markdown-showcase",
            Self::MarkdownStreaming => "markdown-streaming",
            Self::BusyWait => "busy-wait",
            Self::LongWrite => "long-write",
            Self::ThinkingPreview => "thinking-preview",
            Self::MixedTools => "mixed-tools",
            Self::LspDiagnostics => "lsp-diagnostics",
            Self::OcrReview => "ocr-review",
            Self::SubagentTrace => "subagent-trace",
            Self::GoalPro => "goal-pro",
            Self::Orchestrate => "orchestrate",
            Self::OrchestrateControl => "orchestrate-control",
        }
    }

    pub(super) fn startup_description(self) -> &'static str {
        match self {
            Self::FullTurn => {
                "stream thinking, a bash tool call with counted long output, and a final response"
            }
            Self::TailFollow => "stream a longer counted reply for follow-tail and review checks",
            Self::MarkdownShowcase => {
                "stream a Codex-aligned showcase of headings, links, lists, quotes, tables, and code"
            }
            Self::MarkdownStreaming => "stream a large Rust fence and preserve Markdown colors",
            Self::BusyWait => {
                "call bash, remain silent for several seconds, and verify the busy indicator"
            }
            Self::LongWrite => {
                "stream a large write input, run the write, delete its file, and finish"
            }
            Self::ThinkingPreview => {
                "stream a long reasoning block, keep its live preview stable, and collapse it"
            }
            Self::MixedTools => {
                "stream thinking, mixed read/grep/TodoWrite/bash/edit tool calls, and a final response"
            }
            Self::LspDiagnostics => {
                "write invalid Python, run real pyright LSP diagnostics, and return a final response"
            }
            Self::OcrReview => {
                "call the built-in ocr tool in preview mode and summarize the review scope"
            }
            Self::SubagentTrace => {
                "spawn a sub-agent, let it finish, and persist per-sub-agent trace artifacts"
            }
            Self::GoalPro => {
                "request strict goal completion and require an independent verifier PASS"
            }
            Self::Orchestrate => {
                "run an Orchestrate-safe read-only tool turn and accept a second user turn"
            }
            Self::OrchestrateControl => {
                "spawn a background child, pause it at a safe boundary, queue a durable message, and inspect AgentFleet"
            }
        }
    }
}

#[derive(Debug)]
pub(super) struct MockScenarioProvider {
    scenario: TuiDevScenario,
    request_counter: AtomicUsize,
}

impl MockScenarioProvider {
    pub(super) fn new(scenario: TuiDevScenario) -> Self {
        Self {
            scenario,
            request_counter: AtomicUsize::new(0),
        }
    }
}

impl Provider for MockScenarioProvider {
    fn name(&self) -> &'static str {
        "tui-dev-mock"
    }

    fn supports_client_runtime_reconfiguration(&self) -> bool {
        false
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> Result<ProviderStream, kcoder_api::ApiErrorKind> {
        self.record_request(&request);
        let is_subagent_trace_worker = matches!(self.scenario, TuiDevScenario::SubagentTrace)
            && request_text_contains(&request, "tui-lab-subagent-worker-sentinel")
            && request_text_contains(&request, "Global sub-agent contract");
        let is_orchestrate_control_worker =
            matches!(self.scenario, TuiDevScenario::OrchestrateControl)
                && request_text_contains(&request, "tui-lab-orchestrate-control-worker")
                && request_text_contains(&request, "Global sub-agent contract");
        let is_subagent_followup = matches!(self.scenario, TuiDevScenario::SubagentTrace)
            && request_has_subagent_notification(&request);
        let events = match self.scenario {
            TuiDevScenario::FullTurn => Self::full_turn_events(&request),
            TuiDevScenario::TailFollow => Self::tail_follow_events(&request),
            TuiDevScenario::MarkdownShowcase => Self::markdown_showcase_events(),
            TuiDevScenario::MarkdownStreaming => Self::markdown_streaming_events(),
            TuiDevScenario::BusyWait => Self::busy_wait_events(&request),
            TuiDevScenario::LongWrite => Self::long_write_events(&request),
            TuiDevScenario::ThinkingPreview => Self::thinking_preview_events(&request),
            TuiDevScenario::MixedTools => Self::mixed_tools_events(&request),
            TuiDevScenario::LspDiagnostics => Self::lsp_diagnostics_events(&request),
            TuiDevScenario::OcrReview => Self::ocr_review_events(&request),
            TuiDevScenario::SubagentTrace => Self::subagent_trace_events(&request),
            TuiDevScenario::GoalPro => Self::goal_pro_events(&request),
            TuiDevScenario::Orchestrate => Self::orchestrate_events(&request),
            TuiDevScenario::OrchestrateControl => Self::orchestrate_control_events(&request),
        };
        if let Some(directory) = targeted_steer_gate_directory(self.scenario, &request) {
            // Only the dedicated mock worker waits; production providers never enter this path.
            return Ok(targeted_steer_gated_stream(
                events,
                directory,
                Duration::from_secs(120),
            ));
        }
        let delay = if is_subagent_followup {
            tui_lab_followup_stream_delay().or_else(tui_lab_stream_delay)
        } else if is_subagent_trace_worker || is_orchestrate_control_worker {
            tui_lab_subagent_stream_delay().or_else(tui_lab_stream_delay)
        } else {
            tui_lab_stream_delay()
        };
        if let Some(delay) = delay {
            let stream =
                futures::stream::unfold(events.into_iter(), move |mut events| async move {
                    let event = events.next()?;
                    tokio::time::sleep(delay).await;
                    Some((event, events))
                });
            return Ok(Box::pin(stream));
        }
        Ok(Box::pin(futures::stream::iter(events)))
    }
}

fn targeted_steer_gate_directory(
    scenario: TuiDevScenario,
    request: &MessagesRequest,
) -> Option<PathBuf> {
    if !matches!(scenario, TuiDevScenario::SubagentTrace) || !is_targeted_steer_worker(request) {
        return None;
    }
    std::env::var_os("KCODER_TUI_LAB_STEER_GATE_DIR").map(PathBuf::from)
}

fn targeted_steer_gated_stream(
    events: Vec<Result<kcoder_types::StreamEvent, kcoder_api::ApiErrorKind>>,
    directory: PathBuf,
    timeout: Duration,
) -> ProviderStream {
    Box::pin(futures::stream::unfold(
        (events.into_iter(), Some(directory)),
        move |(mut events, gate)| async move {
            if let Some(directory) = gate
                && let Err(error) = wait_for_targeted_steer_gate(&directory, timeout).await
            {
                return Some((
                    Err(kcoder_api::ApiErrorKind::Api {
                        error_type: "mock_steer_gate".into(),
                        message: error.to_string(),
                    }),
                    (Vec::new().into_iter(), None),
                ));
            }
            events.next().map(|event| (event, (events, None)))
        },
    ))
}

async fn wait_for_targeted_steer_gate(
    directory: &std::path::Path,
    timeout: Duration,
) -> std::io::Result<()> {
    if !directory.is_absolute() || !tokio::fs::symlink_metadata(directory).await?.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "mock steer gate requires an existing absolute directory",
        ));
    }
    // The harness owns this directory and both markers. No user data or prompt is persisted.
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("entered"))
        .await
    {
        Ok(file) => drop(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = tokio::fs::symlink_metadata(directory.join("entered")).await?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "mock steer entered marker must be a regular file",
                ));
            }
        }
        Err(error) => return Err(error),
    }
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match tokio::fs::symlink_metadata(directory.join("release")).await {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                return Ok(());
            }
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "mock steer release must be a regular file",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "mock steer gate release deadline exceeded",
            ));
        }
        // Dropping the provider stream cancels this wait; it owns no detached task or process.
        tokio::time::sleep_until(
            deadline.min(tokio::time::Instant::now() + Duration::from_millis(25)),
        )
        .await;
    }
}

fn tui_lab_followup_stream_delay() -> Option<Duration> {
    let raw = std::env::var("KCODER_TUI_LAB_FOLLOWUP_STREAM_DELAY_MS").ok()?;
    let delay_ms = raw.trim().parse::<u64>().ok()?;
    if delay_ms == 0 {
        return None;
    }
    Some(Duration::from_millis(delay_ms.min(2_000)))
}

fn tui_lab_subagent_stream_delay() -> Option<Duration> {
    let raw = std::env::var("KCODER_TUI_LAB_SUBAGENT_STREAM_DELAY_MS").ok()?;
    let delay_ms = raw.trim().parse::<u64>().ok()?;
    if delay_ms == 0 {
        return None;
    }
    Some(Duration::from_millis(delay_ms.min(2_000)))
}

fn tui_lab_stream_delay() -> Option<Duration> {
    let raw = std::env::var("KCODER_TUI_LAB_STREAM_DELAY_MS").ok()?;
    let delay_ms = raw.trim().parse::<u64>().ok()?;
    if delay_ms == 0 {
        return None;
    }
    Some(Duration::from_millis(delay_ms.min(2_000)))
}

impl MockScenarioProvider {
    fn record_request(&self, request: &MessagesRequest) {
        let Ok(dir) = std::env::var("KCODER_TUI_LAB_REQUEST_DIR") else {
            return;
        };
        if dir.trim().is_empty() {
            return;
        }
        let index = self.request_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let dir = PathBuf::from(dir);
        if let Err(error) = std::fs::create_dir_all(&dir) {
            warn!(
                ?dir,
                ?error,
                "failed to create tui-dev request capture directory"
            );
            return;
        }
        let path = dir.join(format!("request_{index:03}.json"));
        let payload = serde_json::json!({
            "scenario": self.scenario.as_str(),
            "message_count": request.messages.len(),
            "body": request,
        });
        match serde_json::to_vec_pretty(&payload) {
            Ok(bytes) => {
                if let Err(error) = std::fs::write(&path, bytes) {
                    warn!(?path, ?error, "failed to write tui-dev request capture");
                }
            }
            Err(error) => warn!(?path, ?error, "failed to serialize tui-dev request capture"),
        }
    }
}

#[cfg(test)]
#[path = "tui_dev_mock_tests.rs"]
mod tests;
