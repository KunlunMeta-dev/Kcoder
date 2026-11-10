use clap::ValueEnum;

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum TuiDevScenario {
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
    pub fn as_str(self) -> &'static str {
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

    pub fn startup_description(self) -> &'static str {
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
