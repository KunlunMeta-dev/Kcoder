use std::time::{Duration, Instant};

const MODEL_WAIT_SILENCE: Duration = Duration::from_secs(8);
const STREAM_SILENCE: Duration = Duration::from_secs(5);
const TOOL_SILENCE: Duration = Duration::from_secs(10);
const LONG_TASK_THRESHOLD: Duration = Duration::from_secs(15);
const THOUGHT_RESULT_VISIBILITY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActivityPhase {
    Requesting,
    Thinking,
    PreparingTool,
    Tool,
    Responding,
}

impl ActivityPhase {
    pub(crate) fn default_label(self) -> &'static str {
        match self {
            Self::Requesting => "Connecting model",
            Self::Thinking => "Thinking",
            Self::PreparingTool => "Preparing tool",
            Self::Tool => "Running tool",
            Self::Responding => "Writing response",
        }
    }

    fn silence_threshold(self) -> Duration {
        match self {
            Self::Requesting => MODEL_WAIT_SILENCE,
            Self::Thinking | Self::PreparingTool | Self::Responding => STREAM_SILENCE,
            Self::Tool => TOOL_SILENCE,
        }
    }

    fn silence_label(self) -> &'static str {
        match self {
            Self::Requesting => "Waiting for model",
            Self::Thinking => "No thinking update",
            Self::PreparingTool => "No tool input update",
            Self::Tool => {
                if cfg!(windows) {
                    "Still running - no status update"
                } else {
                    "Still running · no status update"
                }
            }
            Self::Responding => "Waiting for next token",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ActivitySnapshot {
    pub(crate) phase: ActivityPhase,
    pub(crate) elapsed: Duration,
    pub(crate) phase_elapsed: Duration,
    pub(crate) silence: Duration,
    pub(crate) needs_attention: bool,
    pub(crate) estimated_output_tokens: usize,
    pub(crate) thought_for: Option<Duration>,
}

impl ActivitySnapshot {
    pub(crate) fn indicator(self) -> &'static str {
        let elapsed_ms = self.phase_elapsed.as_millis();
        #[cfg(windows)]
        {
            match self.phase {
                ActivityPhase::Requesting => {
                    const FRAMES: [&str; 6] = ["o...", ".o..", "..o.", "...o", "..o.", ".o.."];
                    FRAMES[(elapsed_ms / 120) as usize % FRAMES.len()]
                }
                ActivityPhase::Thinking => {
                    const FRAMES: [&str; 4] = ["|   ", "/   ", "-   ", "\\   "];
                    FRAMES[(elapsed_ms / 240) as usize % FRAMES.len()]
                }
                ActivityPhase::PreparingTool | ActivityPhase::Responding => {
                    const FRAMES: [&str; 6] = [".   ", ":   ", "=   ", "#   ", "=   ", ":   "];
                    FRAMES[(elapsed_ms / 120) as usize % FRAMES.len()]
                }
                ActivityPhase::Tool => {
                    const FRAMES: [&str; 8] = [
                        "#...", ".#..", "..#.", "...#", "..#.", ".#..", "#...", ".#..",
                    ];
                    FRAMES[(elapsed_ms / 120) as usize % FRAMES.len()]
                }
            }
        }

        #[cfg(not(windows))]
        match self.phase {
            ActivityPhase::Requesting => {
                const FRAMES: [&str; 6] = ["●···", "·●··", "··●·", "···●", "··●·", "·●··"];
                FRAMES[(elapsed_ms / 120) as usize % FRAMES.len()]
            }
            ActivityPhase::Thinking => {
                const FRAMES: [&str; 4] = ["◇   ", "◈   ", "◆   ", "◈   "];
                FRAMES[(elapsed_ms / 240) as usize % FRAMES.len()]
            }
            ActivityPhase::PreparingTool => {
                const FRAMES: [&str; 6] = ["▁   ", "▃   ", "▆   ", "█   ", "▆   ", "▃   "];
                FRAMES[(elapsed_ms / 120) as usize % FRAMES.len()]
            }
            ActivityPhase::Tool => {
                const FRAMES: [&str; 8] = [
                    "▁▃▆█",
                    "▃▆█▆",
                    "▆█▆▃",
                    "█▆▃▁",
                    "▆▃▁▃",
                    "▃▁▃▆",
                    "▁▃▆█",
                    "▃▆█▆",
                ];
                FRAMES[(elapsed_ms / 120) as usize % FRAMES.len()]
            }
            ActivityPhase::Responding => {
                const FRAMES: [&str; 6] = ["▁   ", "▃   ", "▆   ", "█   ", "▆   ", "▃   "];
                FRAMES[(elapsed_ms / 120) as usize % FRAMES.len()]
            }
        }
    }

    pub(crate) fn silence_text(self) -> Option<String> {
        self.needs_attention.then(|| {
            format!(
                "{} for {}",
                self.phase.silence_label(),
                format_duration(self.silence)
            )
        })
    }

    pub(crate) fn is_long_task(self) -> bool {
        self.elapsed >= LONG_TASK_THRESHOLD
    }
}

/// Activity state for model requests, thinking, tool execution, and response streaming.
#[derive(Debug, Clone)]
pub(crate) struct SpinnerState {
    paused_at: Option<Instant>,
    is_running: bool,
    started_at: Option<Instant>,
    phase: ActivityPhase,
    phase_started_at: Option<Instant>,
    last_progress_at: Option<Instant>,
    thinking_started_at: Option<Instant>,
    last_thought: Option<(Duration, Instant)>,
    response_chars: usize,
    preparing_tool_name: Option<String>,
    preparing_tool_chars: usize,
}

impl SpinnerState {
    pub(crate) fn new() -> Self {
        Self {
            paused_at: None,
            is_running: false,
            started_at: None,
            phase: ActivityPhase::Requesting,
            phase_started_at: None,
            last_progress_at: None,
            thinking_started_at: None,
            last_thought: None,
            response_chars: 0,
            preparing_tool_name: None,
            preparing_tool_chars: 0,
        }
    }

    pub(crate) fn start(&mut self) {
        if !self.is_running {
            self.begin_turn_at(Instant::now());
        }
        self.is_running = true;
        self.paused_at = None;
    }

    fn begin_turn_at(&mut self, now: Instant) {
        self.started_at = Some(now);
        self.phase = ActivityPhase::Requesting;
        self.phase_started_at = Some(now);
        self.last_progress_at = Some(now);
        self.thinking_started_at = None;
        self.last_thought = None;
        self.response_chars = 0;
        self.preparing_tool_name = None;
        self.preparing_tool_chars = 0;
    }

    pub(crate) fn stop(&mut self) {
        self.is_running = false;
        self.paused_at = None;
        self.started_at = None;
        self.phase_started_at = None;
        self.last_progress_at = None;
        self.thinking_started_at = None;
        self.last_thought = None;
        self.response_chars = 0;
        self.preparing_tool_name = None;
        self.preparing_tool_chars = 0;
    }

    pub(crate) fn pause(&mut self) {
        if self.is_running && self.paused_at.is_none() {
            self.paused_at = Some(Instant::now());
        }
    }

    pub(crate) fn resume(&mut self) {
        self.paused_at = None;
    }

    pub(crate) fn tick(&mut self) -> bool {
        self.is_running && self.paused_at.is_none()
    }

    pub(crate) fn is_running(&self) -> bool {
        self.is_running
    }

    pub(crate) fn mark_requesting(&mut self) {
        self.mark_phase_at(ActivityPhase::Requesting, 0, Instant::now());
    }

    pub(crate) fn mark_thinking(&mut self, chars: usize) {
        self.mark_phase_at(ActivityPhase::Thinking, chars, Instant::now());
    }

    pub(crate) fn mark_tool(&mut self) {
        self.mark_phase_at(ActivityPhase::Tool, 0, Instant::now());
    }

    pub(crate) fn mark_responding(&mut self, chars: usize) {
        self.mark_phase_at(ActivityPhase::Responding, chars, Instant::now());
    }

    pub(crate) fn mark_tool_input(&mut self, name: &str, chars: usize) {
        self.mark_tool_input_at(name, chars, Instant::now());
    }

    fn mark_tool_input_at(&mut self, name: &str, chars: usize, now: Instant) {
        if !self.is_running {
            self.begin_turn_at(now);
            self.is_running = true;
        }
        if self.phase != ActivityPhase::PreparingTool {
            if self.phase == ActivityPhase::Thinking {
                self.finish_thinking_at(now);
            }
            self.phase = ActivityPhase::PreparingTool;
            self.phase_started_at = Some(now);
            self.preparing_tool_name = Some(name.to_string());
            self.preparing_tool_chars = 0;
        } else if self.preparing_tool_name.as_deref() != Some(name) {
            self.preparing_tool_name = Some(name.to_string());
            self.preparing_tool_chars = 0;
            self.phase_started_at = Some(now);
        }
        self.preparing_tool_chars = chars;
        self.last_progress_at = Some(now);
    }

    pub(crate) fn preparing_tool_progress(&self) -> Option<(&str, usize)> {
        self.preparing_tool_name
            .as_deref()
            .map(|name| (name, self.preparing_tool_chars))
    }

    fn mark_phase_at(&mut self, phase: ActivityPhase, chars: usize, now: Instant) {
        if !self.is_running {
            self.begin_turn_at(now);
            self.is_running = true;
        }
        if self.phase != phase {
            if self.phase == ActivityPhase::Thinking {
                self.finish_thinking_at(now);
            }
            if phase != ActivityPhase::PreparingTool {
                self.preparing_tool_name = None;
                self.preparing_tool_chars = 0;
            }
            self.phase = phase;
            self.phase_started_at = Some(now);
            if phase == ActivityPhase::Thinking {
                self.thinking_started_at = Some(now);
            }
        }
        self.last_progress_at = Some(now);
        if phase == ActivityPhase::Responding {
            self.response_chars = self.response_chars.saturating_add(chars);
        }
    }

    fn finish_thinking_at(&mut self, now: Instant) {
        if let Some(started) = self.thinking_started_at.take() {
            self.last_thought = Some((now.saturating_duration_since(started), now));
        }
    }

    pub(crate) fn snapshot(&self) -> ActivitySnapshot {
        self.snapshot_at(Instant::now())
    }

    fn snapshot_at(&self, now: Instant) -> ActivitySnapshot {
        let elapsed = self
            .started_at
            .map(|started| now.saturating_duration_since(started))
            .unwrap_or_default();
        let phase_elapsed = self
            .phase_started_at
            .map(|started| now.saturating_duration_since(started))
            .unwrap_or_default();
        let silence = self
            .last_progress_at
            .map(|progress| now.saturating_duration_since(progress))
            .unwrap_or_default();
        let thought_for = self.last_thought.and_then(|(duration, finished_at)| {
            (now.saturating_duration_since(finished_at) < THOUGHT_RESULT_VISIBILITY)
                .then_some(duration)
        });
        ActivitySnapshot {
            phase: self.phase,
            elapsed,
            phase_elapsed,
            silence,
            needs_attention: silence >= self.phase.silence_threshold(),
            estimated_output_tokens: self.response_chars.div_ceil(4),
            thought_for,
        }
    }
}

fn format_duration(duration: Duration) -> String {
    let seconds = duration.as_secs();
    if seconds < 60 {
        format!("{seconds}s")
    } else {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tick_only_redraws_while_running_and_unpaused() {
        let mut spinner = SpinnerState::new();
        assert!(!spinner.tick());
        spinner.start();
        assert!(spinner.tick());
        spinner.pause();
        assert!(!spinner.tick());
        spinner.resume();
        assert!(spinner.tick());
        spinner.stop();
        assert!(!spinner.tick());
    }

    #[test]
    fn phases_use_distinct_fixed_width_animation_families() {
        let now = Instant::now();
        let mut spinner = SpinnerState::new();
        spinner.begin_turn_at(now);

        let request = spinner.snapshot_at(now).indicator();
        spinner.mark_phase_at(ActivityPhase::Thinking, 12, now);
        let thinking = spinner.snapshot_at(now).indicator();
        spinner.mark_phase_at(ActivityPhase::Tool, 0, now);
        let tool = spinner.snapshot_at(now).indicator();
        spinner.mark_phase_at(ActivityPhase::Responding, 12, now);
        let response = spinner.snapshot_at(now).indicator();

        let expected = if cfg!(windows) {
            ["o...", "|   ", "#...", ".   "]
        } else {
            ["●···", "◇   ", "▁▃▆█", "▁   "]
        };
        assert_eq!([request, thinking, tool, response], expected);
        for frame in [request, thinking, tool, response] {
            assert_eq!(unicode_width::UnicodeWidthStr::width(frame), 4);
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_activity_frames_are_ascii_single_width() {
        let now = Instant::now();
        let mut spinner = SpinnerState::new();
        spinner.begin_turn_at(now);

        for phase in [
            ActivityPhase::Requesting,
            ActivityPhase::Thinking,
            ActivityPhase::PreparingTool,
            ActivityPhase::Tool,
            ActivityPhase::Responding,
        ] {
            spinner.mark_phase_at(phase, 0, now);
            for offset in 0..12 {
                let frame = spinner
                    .snapshot_at(now + Duration::from_millis(offset * 120))
                    .indicator();
                assert!(frame.is_ascii(), "{phase:?} produced {frame:?}");
                assert_eq!(unicode_width::UnicodeWidthStr::width(frame), 4);
            }
        }
    }

    #[test]
    fn silence_threshold_depends_on_real_activity_phase() {
        let now = Instant::now();
        let mut spinner = SpinnerState::new();
        spinner.begin_turn_at(now);
        let request = spinner.snapshot_at(now + Duration::from_secs(8));
        assert_eq!(
            request.silence_text().as_deref(),
            Some("Waiting for model for 8s")
        );

        spinner.mark_phase_at(ActivityPhase::Tool, 0, now);
        let tool = spinner.snapshot_at(now + Duration::from_secs(9));
        assert!(!tool.needs_attention);
        let tool = spinner.snapshot_at(now + Duration::from_secs(10));
        assert_eq!(
            tool.silence_text().as_deref(),
            Some(if cfg!(windows) {
                "Still running - no status update for 10s"
            } else {
                "Still running · no status update for 10s"
            })
        );
    }

    #[test]
    fn thinking_duration_and_response_tokens_come_from_real_deltas() {
        let now = Instant::now();
        let mut spinner = SpinnerState::new();
        spinner.begin_turn_at(now);
        spinner.mark_phase_at(ActivityPhase::Thinking, 30, now + Duration::from_secs(1));
        spinner.mark_phase_at(ActivityPhase::Responding, 400, now + Duration::from_secs(6));

        let snapshot = spinner.snapshot_at(now + Duration::from_secs(7));
        assert_eq!(snapshot.thought_for, Some(Duration::from_secs(5)));
        assert_eq!(snapshot.estimated_output_tokens, 100);
    }

    #[test]
    fn tool_input_progress_replaces_stale_thinking_silence() {
        let now = Instant::now();
        let mut spinner = SpinnerState::new();
        spinner.begin_turn_at(now);
        spinner.mark_phase_at(ActivityPhase::Thinking, 20, now + Duration::from_secs(1));

        spinner.mark_tool_input_at("write", 12_000, now + Duration::from_secs(8));
        let snapshot = spinner.snapshot_at(now + Duration::from_secs(9));

        assert_eq!(snapshot.phase, ActivityPhase::PreparingTool);
        assert_eq!(spinner.preparing_tool_progress(), Some(("write", 12_000)));
        assert_eq!(snapshot.silence, Duration::from_secs(1));
        assert_eq!(snapshot.silence_text(), None);
    }
}
