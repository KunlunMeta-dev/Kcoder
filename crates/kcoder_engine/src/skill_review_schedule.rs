//! Idle-time scheduling for the background skill review.
//!
//! Completed main-thread turns only accumulate tool-call counts here. The
//! review itself starts from the hosts' idle poll
//! ([`QueryEngine::poll_idle_maintenance`]) once the foreground has been idle
//! for `skills.auto_skill_review_idle_minutes` since the last turn and at least
//! `auto_skill_review_interval` new tool calls accumulated since the previous
//! review. Each idle episode (identified by the last foreground-activity
//! instant) gets at most one review; new input starts a turn, which moves that
//! instant and so restarts the deadline. A per-session cursor records how many
//! messages the previous review covered so the next prompt can point at what
//! changed. State is in memory: a session closed or unloaded before its
//! deadline is simply not reviewed.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime};

#[derive(Debug, Default)]
pub(crate) struct SkillReviewSchedule {
    /// Foreground tool calls since the previous review, by tool name.
    tool_counts: BTreeMap<String, usize>,
    tool_calls: usize,
    /// Conversation messages covered by the previous review.
    reviewed_messages: usize,
    /// Foreground-activity instant of the idle episode already handled.
    handled_episode: Option<SystemTime>,
}

/// What one review covers, taken atomically from the schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SkillReviewWindow {
    pub(crate) tool_counts: BTreeMap<String, usize>,
    pub(crate) tool_calls: usize,
    /// Messages already covered by an earlier review (0 when none or when the
    /// transcript shrank, e.g. after compaction or a session replacement).
    pub(crate) reviewed_before: usize,
    pub(crate) message_count: usize,
}

impl SkillReviewSchedule {
    pub(crate) fn record_tool_calls(&mut self, tools: &[String]) {
        for tool in tools {
            *self.tool_counts.entry(tool.clone()).or_insert(0) += 1;
        }
        self.tool_calls = self.tool_calls.saturating_add(tools.len());
    }

    /// Cheap in-memory gate evaluated on every idle tick; it never touches the
    /// transcript. `idle_for` is zero while a foreground turn is active.
    pub(crate) fn ready(
        &self,
        episode: SystemTime,
        idle_for: Duration,
        idle_deadline: Duration,
        min_tool_calls: usize,
    ) -> bool {
        idle_for >= idle_deadline
            && self.handled_episode != Some(episode)
            && self.tool_calls >= min_tool_calls.max(1)
    }

    /// Mark the episode handled without reviewing (e.g. the last answer was
    /// empty), keeping the accumulated activity for a later episode.
    pub(crate) fn skip_episode(&mut self, episode: SystemTime) {
        self.handled_episode = Some(episode);
    }

    /// Consume the accumulated activity for one review and advance the cursor.
    pub(crate) fn begin_review(
        &mut self,
        episode: SystemTime,
        message_count: usize,
    ) -> SkillReviewWindow {
        let reviewed_before = if self.reviewed_messages <= message_count {
            self.reviewed_messages
        } else {
            0
        };
        self.handled_episode = Some(episode);
        self.reviewed_messages = message_count;
        SkillReviewWindow {
            tool_counts: std::mem::take(&mut self.tool_counts),
            tool_calls: std::mem::take(&mut self.tool_calls),
            reviewed_before,
            message_count,
        }
    }

    #[cfg(test)]
    pub(crate) fn pending_tool_calls(&self) -> usize {
        self.tool_calls
    }

    #[cfg(test)]
    pub(crate) fn reviewed_messages(&self) -> usize {
        self.reviewed_messages
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    fn tools(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn ready_requires_idle_deadline_enough_calls_and_a_new_episode() {
        let episode = SystemTime::UNIX_EPOCH + 100 * MINUTE;
        let mut schedule = SkillReviewSchedule::default();
        schedule.record_tool_calls(&tools(&["read", "edit"]));
        assert!(
            !schedule.ready(episode, 31 * MINUTE, 30 * MINUTE, 3),
            "too few calls"
        );
        schedule.record_tool_calls(&tools(&["bash"]));
        assert!(
            !schedule.ready(episode, 29 * MINUTE, 30 * MINUTE, 3),
            "before deadline"
        );
        assert!(schedule.ready(episode, 30 * MINUTE, 30 * MINUTE, 3));

        let window = schedule.begin_review(episode, 12);
        assert_eq!(window.tool_calls, 3);
        assert_eq!(window.tool_counts.get("read"), Some(&1));
        assert_eq!(window.reviewed_before, 0);
        schedule.record_tool_calls(&tools(&["read", "read", "read"]));
        assert!(
            !schedule.ready(episode, 90 * MINUTE, 30 * MINUTE, 3),
            "one review per idle episode"
        );
        let next_episode = episode + 60 * MINUTE;
        assert!(schedule.ready(next_episode, 30 * MINUTE, 30 * MINUTE, 3));
        assert_eq!(schedule.begin_review(next_episode, 20).reviewed_before, 12);
    }

    #[test]
    fn cursor_resets_when_the_transcript_shrinks() {
        let episode = SystemTime::UNIX_EPOCH;
        let mut schedule = SkillReviewSchedule::default();
        schedule.record_tool_calls(&tools(&["read"]));
        schedule.begin_review(episode, 40);
        schedule.record_tool_calls(&tools(&["read"]));
        assert_eq!(
            schedule.begin_review(episode + MINUTE, 6).reviewed_before,
            0
        );
    }

    #[test]
    fn skipped_episode_keeps_accumulated_activity() {
        let episode = SystemTime::UNIX_EPOCH;
        let mut schedule = SkillReviewSchedule::default();
        schedule.record_tool_calls(&tools(&["read", "edit"]));
        schedule.skip_episode(episode);
        assert!(!schedule.ready(episode, 60 * MINUTE, MINUTE, 2));
        assert!(schedule.ready(episode + MINUTE, 60 * MINUTE, MINUTE, 2));
    }
}
