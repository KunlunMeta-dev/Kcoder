/// Short, transient hint about background work. Shown in compact status
/// surfaces instead of the transcript so the user does not mistake it for
/// assistant output.
#[derive(Debug, Clone)]
pub struct BackgroundJobHint {
    pub id: String,
    pub description: String,
    pub state: BackgroundJobHintState,
    /// Optional failure reason populated when the background job finished
    /// with an error.
    pub error: Option<String>,
    /// When the hint was first recorded. Used for compact elapsed labels when
    /// the UI needs to show whether background work has been stuck for a long time.
    pub started_at: Option<std::time::Instant>,
}

/// Latest bounded progress associated with a running managed job.
#[derive(Debug, Clone)]
pub struct BackgroundJobProgressHint {
    pub message: String,
    pub current: Option<usize>,
    pub total: Option<usize>,
    pub updated_at: std::time::Instant,
}

/// Lifetime metadata returned by managed command tools after a job starts.
#[derive(Debug, Clone)]
pub struct BackgroundJobLifetimeHint {
    pub total_timeout: std::time::Duration,
    pub deadline: std::time::Instant,
}

impl BackgroundJobLifetimeHint {
    pub fn label(&self) -> String {
        let remaining = self
            .deadline
            .saturating_duration_since(std::time::Instant::now());
        format!(
            "{} left / {} timeout",
            format_elapsed(remaining),
            format_elapsed(self.total_timeout)
        )
    }
}

impl BackgroundJobProgressHint {
    pub fn label(&self) -> String {
        match (self.current, self.total) {
            (Some(current), Some(total)) => {
                format!("Turn {current}/max {total} · {}", self.message)
            }
            (Some(current), None) => format!("Turn {current} · {}", self.message),
            (None, _) => self.message.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundJobHintState {
    Running,
    Paused,
    Halted,
    Completed,
    Cancelled,
    Failed,
}

impl BackgroundJobHint {
    /// Human-readable elapsed time for the running hint. Returns `None`
    /// if the hint is not running.
    pub fn elapsed_label(&self) -> Option<String> {
        let started = self.started_at?;
        let elapsed = started.elapsed();
        Some(format_elapsed(elapsed))
    }
}

fn format_elapsed(elapsed: std::time::Duration) -> String {
    let total_secs = elapsed.as_secs();
    if total_secs < 60 {
        format!("{}.{:02}s", total_secs, elapsed.subsec_millis() / 10)
    } else if total_secs < 3600 {
        format!("{}m{:02}s", total_secs / 60, total_secs % 60)
    } else {
        format!("{}h{:02}m", total_secs / 3600, (total_secs / 60) % 60)
    }
}

pub(crate) fn background_status_group_label(
    label: &str,
    running: usize,
    failed: usize,
) -> Option<String> {
    match (running, failed) {
        (0, 0) => None,
        (running, 0) => Some(format!("{label} {running} running")),
        (0, failed) => Some(format!("{label} {failed} failed")),
        (running, failed) => Some(format!("{label} {running} running {failed} failed")),
    }
}
