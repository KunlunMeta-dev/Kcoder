use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::terminal_glyphs::PANEL_STATUS_SEPARATOR;
use crate::{KCODER_UI_THEME, truncate_display_text};

pub(crate) const SUBAGENT_PANEL_PREFIX: &str = "[Subagent panel] ";
const MAX_LATEST_MODEL_CHARS: usize = 2_000;
const BRAILLE_LEVELS: [&str; 7] = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) enum SubagentPhase {
    Pending,
    Queued,
    Running,
    Paused,
    Halted,
    Completed,
    Failed,
    Cancelled,
}

impl SubagentPhase {
    pub(crate) fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Halted | Self::Completed | Self::Failed | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) enum SubagentDelivery {
    Foreground,
    Background,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) struct SubagentMember {
    pub(crate) tool_call_id: String,
    pub(crate) agent_id: Option<String>,
    pub(crate) item_text: String,
    pub(crate) phase: SubagentPhase,
    pub(crate) delivery: SubagentDelivery,
    pub(crate) status_text: String,
    pub(crate) latest_model_text: String,
    pub(crate) current: Option<usize>,
    pub(crate) total: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) pending_steer_message_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) last_applied_steer_message_id: Option<String>,
    #[serde(default)]
    pub(crate) steer_queue_depth: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub(crate) struct SubagentPanel {
    pub(crate) id: u64,
    pub(crate) members: Vec<SubagentMember>,
}

impl SubagentPanel {
    pub(crate) fn new(id: u64) -> Self {
        Self {
            id,
            members: Vec::new(),
        }
    }

    pub(crate) fn add_pending(
        &mut self,
        tool_call_id: String,
        item_text: String,
        delivery: SubagentDelivery,
    ) {
        self.members.push(SubagentMember {
            tool_call_id,
            agent_id: None,
            item_text,
            phase: SubagentPhase::Pending,
            delivery,
            status_text: "Prompting...".to_string(),
            latest_model_text: String::new(),
            current: None,
            total: None,
            pending_steer_message_ids: Vec::new(),
            last_applied_steer_message_id: None,
            steer_queue_depth: 0,
        });
    }

    pub(crate) fn associate(
        &mut self,
        tool_call_id: &str,
        agent_id: &str,
        delivery: SubagentDelivery,
    ) -> bool {
        let Some(member) = self
            .members
            .iter_mut()
            .find(|member| member.tool_call_id == tool_call_id)
        else {
            return false;
        };
        member.agent_id = Some(agent_id.to_string());
        if delivery == SubagentDelivery::Background {
            member.delivery = SubagentDelivery::Background;
        }
        if member.phase == SubagentPhase::Pending {
            member.phase = SubagentPhase::Queued;
            member.status_text = "Queued...".to_string();
        }
        true
    }

    pub(crate) fn update_progress(
        &mut self,
        agent_id: &str,
        status: &str,
        detail: Option<&str>,
        current: Option<usize>,
        total: Option<usize>,
    ) -> bool {
        let Some(member) = self.member_by_agent_id_mut(agent_id) else {
            return false;
        };
        if member.phase.is_terminal() {
            return false;
        }
        let status_text = status.trim().to_string();
        let next_current = match (member.current, current) {
            (Some(existing), Some(next)) => Some(existing.max(next)),
            (existing, next) => existing.or(next),
        };
        let next_total = total.or(member.total);
        let next_detail = detail
            .map(str::trim)
            .filter(|detail| !detail.is_empty())
            .map(|detail| {
                detail
                    .chars()
                    .rev()
                    .take(MAX_LATEST_MODEL_CHARS)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect::<String>()
            });
        let changed = member.phase != SubagentPhase::Running
            || member.status_text != status_text
            || member.current != next_current
            || member.total != next_total
            || next_detail
                .as_ref()
                .is_some_and(|detail| member.latest_model_text != *detail);
        member.phase = SubagentPhase::Running;
        member.status_text = status_text;
        member.current = next_current;
        member.total = next_total;
        if let Some(detail) = next_detail {
            member.latest_model_text = detail;
        }
        changed
    }

    pub(crate) fn promote(&mut self, agent_id: &str) -> bool {
        let Some(member) = self.member_by_agent_id_mut(agent_id) else {
            return false;
        };
        member.delivery = SubagentDelivery::Background;
        if !member.phase.is_terminal() {
            member.phase = SubagentPhase::Running;
            member.status_text = "Running in background".to_string();
        }
        true
    }

    pub(crate) fn apply_steer(
        &mut self,
        agent_id: &str,
        message_id: &str,
        queue_depth: usize,
    ) -> bool {
        let Some(member) = self.member_by_agent_id_mut(agent_id) else {
            return false;
        };
        if member.phase.is_terminal() {
            return false;
        }
        member
            .pending_steer_message_ids
            .retain(|pending| pending != message_id);
        member.last_applied_steer_message_id = Some(message_id.to_string());
        member.steer_queue_depth = queue_depth;
        member.phase = SubagentPhase::Running;
        member.status_text = if queue_depth == 0 {
            "Steering applied".to_string()
        } else {
            format!("Steering applied · {queue_depth} queued")
        };
        true
    }

    pub(crate) fn queue_steer(
        &mut self,
        agent_id: &str,
        message_id: &str,
        queue_depth: usize,
    ) -> bool {
        let Some(member) = self.member_by_agent_id_mut(agent_id) else {
            return false;
        };
        if member.phase.is_terminal() {
            return false;
        }
        if !member
            .pending_steer_message_ids
            .iter()
            .any(|pending| pending == message_id)
        {
            member
                .pending_steer_message_ids
                .push(message_id.to_string());
        }
        member.steer_queue_depth = queue_depth;
        member.status_text = format!("Steering queued · {queue_depth} pending");
        true
    }

    pub(crate) fn pause(&mut self, agent_id: &str, status: &str, detail: Option<&str>) -> bool {
        let Some(member) = self.member_by_agent_id_mut(agent_id) else {
            return false;
        };
        if member.phase.is_terminal() {
            return false;
        }
        member.phase = SubagentPhase::Paused;
        member.status_text = status.trim().to_string();
        if let Some(detail) = detail.map(str::trim).filter(|detail| !detail.is_empty()) {
            member.latest_model_text = detail.chars().take(MAX_LATEST_MODEL_CHARS).collect();
        }
        true
    }

    pub(crate) fn restart(&mut self, agent_id: &str, delivery: SubagentDelivery) -> bool {
        let Some(member) = self.member_by_agent_id_mut(agent_id) else {
            return false;
        };
        if !member.phase.is_terminal() {
            return false;
        }
        member.phase = SubagentPhase::Queued;
        member.delivery = delivery;
        member.status_text = "Queued...".to_string();
        member.latest_model_text.clear();
        member.current = None;
        member.total = None;
        member.pending_steer_message_ids.clear();
        member.last_applied_steer_message_id = None;
        member.steer_queue_depth = 0;
        true
    }

    pub(crate) fn finish(
        &mut self,
        agent_id: &str,
        phase: SubagentPhase,
        status: impl Into<String>,
    ) -> bool {
        let Some(member) = self.member_by_agent_id_mut(agent_id) else {
            return false;
        };
        if member.phase.is_terminal() {
            return false;
        }
        member.phase = phase;
        member.status_text = status.into();
        true
    }

    pub(crate) fn finish_tool_call(
        &mut self,
        tool_call_id: &str,
        phase: SubagentPhase,
        status: impl Into<String>,
    ) -> bool {
        let Some(member) = self
            .members
            .iter_mut()
            .find(|member| member.tool_call_id == tool_call_id)
        else {
            return false;
        };
        if member.phase.is_terminal() {
            return false;
        }
        member.phase = phase;
        member.status_text = status.into();
        true
    }

    pub(crate) fn has_tool_call(&self, tool_call_id: &str) -> bool {
        self.members
            .iter()
            .any(|member| member.tool_call_id == tool_call_id)
    }

    pub(crate) fn all_terminal(&self) -> bool {
        !self.members.is_empty() && self.members.iter().all(|member| member.phase.is_terminal())
    }

    fn member_by_agent_id_mut(&mut self, agent_id: &str) -> Option<&mut SubagentMember> {
        self.members
            .iter_mut()
            .find(|member| member.agent_id.as_deref() == Some(agent_id))
    }

    pub(crate) fn encode_message(&self) -> String {
        format!(
            "{SUBAGENT_PANEL_PREFIX}{}",
            serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
        )
    }
}

pub(crate) fn decode_panel_message(text: &str) -> Option<SubagentPanel> {
    serde_json::from_str(text.strip_prefix(SUBAGENT_PANEL_PREFIX)?).ok()
}

pub(crate) fn panel_message_id(text: &str) -> Option<u64> {
    decode_panel_message(text).map(|panel| panel.id)
}

pub(crate) fn compact_panel_status(panel: &SubagentPanel, width: u16) -> String {
    let count = panel.members.len();
    let completed = panel
        .members
        .iter()
        .filter(|member| member.phase == SubagentPhase::Completed)
        .count();
    let mut text = format!("Agent Swarm {completed}/{count}");
    for (index, member) in panel.members.iter().enumerate() {
        let glyph = match member.phase {
            SubagentPhase::Completed => "✓",
            SubagentPhase::Failed => "×",
            SubagentPhase::Cancelled => "⊘",
            SubagentPhase::Halted => "■",
            SubagentPhase::Paused => "Ⅱ",
            SubagentPhase::Running => "◐",
            SubagentPhase::Pending | SubagentPhase::Queued => "○",
        };
        text.push_str(&format!(" · {:03}{glyph}", index + 1));
    }
    truncate_display_text(&text, usize::from(width.max(1)))
}

pub(crate) fn render_panel_message(
    text: &str,
    width: u16,
    phase_elapsed: Duration,
    available_rows: Option<usize>,
) -> Option<Vec<Line<'static>>> {
    let panel = decode_panel_message(text)?;
    let theme = &KCODER_UI_THEME;
    let width = usize::from(width.max(1));
    let inner_width = width.saturating_sub(2).max(1);
    let count = panel.members.len();
    let description = if count == 1 {
        panel
            .members
            .first()
            .map(|member| member.item_text.as_str())
            .unwrap_or("delegated task")
            .to_string()
    } else {
        format!("{count} delegated tasks")
    };
    let title = format!("Agent Swarm ─ {description}");
    let title = truncate_display_text(&title, inner_width.saturating_sub(4).max(1));
    let rail_len =
        inner_width.saturating_sub(unicode_width::UnicodeWidthStr::width(title.as_str()) + 3);
    let mut lines = vec![Line::from(vec![
        Span::styled("─ ", Style::default().fg(theme.accent_primary)),
        Span::styled(
            title,
            Style::default()
                .fg(theme.mode_agent)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(" {}", "─".repeat(rail_len)),
            Style::default().fg(theme.accent_primary),
        ),
    ])];

    const MIN_MEMBER_CELL_WIDTH: usize = 34;
    const COLUMN_GAP: usize = 2;
    let width_columns = ((inner_width + COLUMN_GAP) / (MIN_MEMBER_CELL_WIDTH + COLUMN_GAP))
        .max(1)
        .min(count.max(1));
    let member_row_budget = available_rows
        .map(|rows| rows.saturating_sub(2).max(1))
        .unwrap_or(count.max(1));
    let height_columns = count.div_ceil(member_row_budget).max(1);
    let columns = width_columns.max(height_columns).min(count.max(1));
    let gap = if columns > 1 { COLUMN_GAP } else { 0 };
    let cell_width = inner_width.saturating_sub(gap * columns.saturating_sub(1)) / columns;
    for row in 0..count.div_ceil(columns) {
        let mut spans = vec![Span::raw(" ")];
        for column in 0..columns {
            let index = row * columns + column;
            let Some(member) = panel.members.get(index) else {
                continue;
            };
            if column > 0 {
                spans.push(Span::raw(" ".repeat(gap)));
            }
            spans.extend(render_member_cell(
                member,
                index + 1,
                cell_width,
                phase_elapsed,
            ));
        }
        lines.push(Line::from(spans));
    }

    let completed = panel
        .members
        .iter()
        .filter(|member| member.phase == SubagentPhase::Completed)
        .count();
    let failed = panel
        .members
        .iter()
        .filter(|member| member.phase == SubagentPhase::Failed)
        .count();
    let cancelled = panel
        .members
        .iter()
        .filter(|member| member.phase == SubagentPhase::Cancelled)
        .count();
    let halted = panel
        .members
        .iter()
        .filter(|member| member.phase == SubagentPhase::Halted)
        .count();
    let paused = panel
        .members
        .iter()
        .filter(|member| member.phase == SubagentPhase::Paused)
        .count();
    let active = panel
        .members
        .iter()
        .filter(|member| {
            matches!(
                member.phase,
                SubagentPhase::Pending | SubagentPhase::Queued | SubagentPhase::Running
            )
        })
        .count();
    let background = panel
        .members
        .iter()
        .filter(|member| {
            member.delivery == SubagentDelivery::Background
                && matches!(
                    member.phase,
                    SubagentPhase::Pending | SubagentPhase::Queued | SubagentPhase::Running
                )
        })
        .count();
    let state_suffix = |include_completed: bool, include_paused: bool| {
        let mut parts = Vec::new();
        if include_completed && completed > 0 {
            parts.push(format!("{completed} completed"));
        }
        if include_paused && paused > 0 {
            parts.push(format!("{paused} paused"));
        }
        if halted > 0 {
            parts.push(format!("{halted} halted"));
        }
        if failed > 0 {
            parts.push(format!("{failed} failed"));
        }
        if cancelled > 0 {
            parts.push(format!("{cancelled} cancelled"));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!(" · {}", parts.join(" · "))
        }
    };
    let (label, color) = if active > 0 {
        let mut suffix = state_suffix(false, true);
        if background > 0 {
            suffix.push_str(&format!(" · {background} background"));
        }
        (
            format!("Working... {completed}/{count}{suffix}"),
            theme.mode_agent,
        )
    } else if paused > 0 {
        (
            format!("Paused. {paused}/{count}{}", state_suffix(true, false)),
            theme.warning,
        )
    } else if completed == 0 && failed > 0 {
        (format!("Failed. {failed}/{count} failed"), theme.error_fg)
    } else if completed == 0 && halted == count {
        (format!("Halted. {halted}/{count}"), theme.warning)
    } else if completed == 0 && cancelled == count {
        (format!("Cancelled. {cancelled}/{count}"), theme.warning)
    } else {
        let all_completed = completed == count;
        let label = if all_completed {
            "Completed"
        } else {
            "Finished"
        };
        let color = if all_completed {
            theme.success
        } else {
            theme.warning
        };
        (
            format!("{label}. {completed}/{count}{}", state_suffix(false, false)),
            color,
        )
    };
    let status_width = inner_width.saturating_sub(label.chars().count() + 3);
    lines.push(Line::from(vec![
        Span::raw(" "),
        Span::styled(
            label,
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(
            PANEL_STATUS_SEPARATOR.to_string().repeat(status_width),
            Style::default().fg(theme.text_muted),
        ),
    ]));
    Some(
        lines
            .into_iter()
            .map(|line| {
                crate::line_truncation::truncate_line_with_ellipsis_if_overflow(line, width)
            })
            .collect(),
    )
}

fn render_member_cell(
    member: &SubagentMember,
    index: usize,
    width: usize,
    phase_elapsed: Duration,
) -> Vec<Span<'static>> {
    let theme = &KCODER_UI_THEME;
    let id = format!("{index:03}");
    if width < 30 {
        let terminal = match member.phase {
            SubagentPhase::Completed => "✓",
            SubagentPhase::Failed => "×",
            SubagentPhase::Cancelled => "⊘",
            SubagentPhase::Halted => "■",
            _ => " ",
        };
        let bar_width = width.saturating_sub(id.len() + terminal.chars().count() + 2);
        let bar = member_bar(member, phase_elapsed)
            .chars()
            .take(bar_width)
            .collect::<String>();
        return vec![
            Span::styled(id, Style::default().fg(theme.accent_primary)),
            Span::raw(" "),
            Span::styled(bar, Style::default().fg(theme.mode_agent)),
            Span::styled(terminal.to_string(), Style::default().fg(theme.text_dim)),
        ];
    }
    let bar = member_bar(member, phase_elapsed);
    let phase = phase_label(member);
    let fixed_width = id.len() + 1 + bar.chars().count() + 1 + phase.chars().count() + 1;
    let detail_width = width.saturating_sub(fixed_width);
    let terminal_detail = matches!(
        member.phase,
        SubagentPhase::Failed | SubagentPhase::Halted | SubagentPhase::Cancelled
    )
    .then_some(member.status_text.trim())
    .filter(|detail| !detail.is_empty() && !matches!(*detail, "Failed" | "Cancelled"));
    let detail = terminal_detail
        .or_else(|| latest_nonempty_line(&member.latest_model_text).filter(|line| !line.is_empty()))
        .unwrap_or(member.item_text.as_str());
    let detail = truncate_display_text(detail, detail_width.max(1));
    let phase_color = match member.phase {
        SubagentPhase::Completed => theme.success,
        SubagentPhase::Failed => theme.error_fg,
        SubagentPhase::Paused | SubagentPhase::Halted => theme.warning,
        SubagentPhase::Cancelled => theme.warning,
        SubagentPhase::Pending | SubagentPhase::Queued => theme.text_muted,
        SubagentPhase::Running => theme.mode_agent,
    };
    vec![
        Span::styled(id, Style::default().fg(theme.accent_primary)),
        Span::raw(" "),
        Span::styled(bar, Style::default().fg(phase_color)),
        Span::raw(" "),
        Span::styled(phase, Style::default().fg(phase_color)),
        Span::raw(" "),
        Span::styled(detail, Style::default().fg(theme.text_dim)),
    ]
}

fn phase_label(member: &SubagentMember) -> String {
    if member.phase == SubagentPhase::Running && !member.pending_steer_message_ids.is_empty() {
        return format!("Steering queued · {} pending", member.steer_queue_depth);
    }
    if member.phase == SubagentPhase::Running && member.last_applied_steer_message_id.is_some() {
        return if member.steer_queue_depth == 0 {
            "Steering applied".to_string()
        } else {
            format!("Steering applied · {} queued", member.steer_queue_depth)
        };
    }
    let base = match member.phase {
        SubagentPhase::Pending => "Prompting...",
        SubagentPhase::Queued => "Queued...",
        SubagentPhase::Running if member.status_text.starts_with("Steering ") => {
            member.status_text.trim()
        }
        SubagentPhase::Running if member.delivery == SubagentDelivery::Background => "Background",
        SubagentPhase::Running => member
            .status_text
            .trim()
            .strip_suffix("...")
            .unwrap_or(member.status_text.trim()),
        SubagentPhase::Completed => "Completed",
        SubagentPhase::Failed => "Failed",
        SubagentPhase::Paused => "Paused",
        SubagentPhase::Halted => "Halted",
        SubagentPhase::Cancelled => "Cancelled",
    };
    match (member.current, member.total) {
        (Some(current), Some(total)) if member.phase == SubagentPhase::Running => {
            format!("{base} {current}/{total}")
        }
        _ => base.to_string(),
    }
}

fn member_bar(member: &SubagentMember, phase_elapsed: Duration) -> String {
    const CELLS: usize = 6;
    match member.phase {
        SubagentPhase::Completed => "⣿".repeat(CELLS),
        SubagentPhase::Failed => format!("{}×", "⣤".repeat(CELLS.saturating_sub(1))),
        SubagentPhase::Paused => format!("{}Ⅱ", "⣀".repeat(CELLS.saturating_sub(1))),
        SubagentPhase::Halted => format!("{}■", "⣀".repeat(CELLS.saturating_sub(1))),
        SubagentPhase::Cancelled => format!("{}⊘", "⣀".repeat(CELLS.saturating_sub(1))),
        SubagentPhase::Pending | SubagentPhase::Queued => " ".repeat(CELLS),
        SubagentPhase::Running => {
            let tick = (phase_elapsed.as_millis() / 80) as usize;
            (0..CELLS)
                .map(|cell| {
                    let distance = (cell + CELLS - (tick % CELLS)) % CELLS;
                    let level = BRAILLE_LEVELS.len().saturating_sub(1 + distance.min(5));
                    BRAILLE_LEVELS[level]
                })
                .collect()
        }
    }
}

fn latest_nonempty_line(text: &str) -> Option<&str> {
    text.lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(str::trim)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_round_trips_and_keeps_stable_member_ids() {
        let mut panel = SubagentPanel::new(7);
        panel.add_pending(
            "tool-1".to_string(),
            "inspect scrolling".to_string(),
            SubagentDelivery::Foreground,
        );
        assert!(panel.associate("tool-1", "agent-1", SubagentDelivery::Foreground));
        assert!(panel.update_progress(
            "agent-1",
            "Running bash",
            Some("checking the latest frame"),
            Some(2),
            Some(60),
        ));

        let decoded = decode_panel_message(&panel.encode_message()).expect("panel should decode");
        assert_eq!(decoded, panel);
        assert_eq!(panel_message_id(&panel.encode_message()), Some(7));
    }

    #[test]
    fn duplicate_progress_does_not_report_a_panel_change() {
        let mut panel = SubagentPanel::new(7);
        panel.add_pending(
            "tool-1".to_string(),
            "inspect project".to_string(),
            SubagentDelivery::Background,
        );
        assert!(panel.associate("tool-1", "agent-1", SubagentDelivery::Background));
        assert!(panel.update_progress(
            "agent-1",
            "Writing response",
            Some("bounded child preview"),
            Some(2),
            Some(60),
        ));

        assert!(!panel.update_progress(
            "agent-1",
            "Writing response",
            Some("bounded child preview"),
            Some(2),
            Some(60),
        ));
    }

    #[test]
    fn steering_state_is_orthogonal_to_agent_lifecycle() {
        let mut panel = SubagentPanel::new(8);
        panel.add_pending(
            "tool-1".to_string(),
            "inspect routing".to_string(),
            SubagentDelivery::Background,
        );
        assert!(panel.associate("tool-1", "agent-1", SubagentDelivery::Background));
        assert!(panel.update_progress("agent-1", "Running", None, Some(1), Some(60)));

        assert!(panel.queue_steer("agent-1", "msg-1", 1));
        let member = &panel.members[0];
        assert_eq!(member.phase, SubagentPhase::Running);
        assert_eq!(member.pending_steer_message_ids, ["msg-1"]);

        assert!(panel.apply_steer("agent-1", "msg-1", 0));
        let member = &panel.members[0];
        assert_eq!(member.phase, SubagentPhase::Running);
        assert!(member.pending_steer_message_ids.is_empty());
        assert_eq!(
            member.last_applied_steer_message_id.as_deref(),
            Some("msg-1")
        );
        assert_eq!(member.steer_queue_depth, 0);

        assert!(panel.update_progress("agent-1", "Writing response", None, Some(2), Some(60)));
        assert_eq!(phase_label(&panel.members[0]), "Steering applied");
    }

    #[test]
    fn render_uses_group_header_and_background_state() {
        let mut panel = SubagentPanel::new(1);
        panel.add_pending(
            "tool-1".to_string(),
            "inspect rendering".to_string(),
            SubagentDelivery::Foreground,
        );
        panel.associate("tool-1", "agent-1", SubagentDelivery::Foreground);
        panel.promote("agent-1");
        let lines = render_panel_message(
            &panel.encode_message(),
            100,
            Duration::from_millis(160),
            None,
        )
        .expect("panel should render");
        let text = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("Agent Swarm"));
        assert!(text.contains("Background"));
        assert!(text.contains("001"));
    }

    #[test]
    fn status_separator_uses_terminal_safe_ascii() {
        let mut panel = SubagentPanel::new(13);
        panel.add_pending(
            "tool-1".to_string(),
            "inspect rendering".to_string(),
            SubagentDelivery::Foreground,
        );

        let lines = render_panel_message(
            &panel.encode_message(),
            100,
            Duration::from_millis(160),
            None,
        )
        .expect("panel should render");
        let status = lines
            .last()
            .expect("panel should include a status separator")
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();

        assert!(status.contains('-'), "status line: {status}");
        assert!(!status.contains(['━', '─']), "status line: {status}");
    }

    #[test]
    fn first_terminal_state_wins_and_all_cancelled_is_not_completed() {
        let mut panel = SubagentPanel::new(2);
        panel.add_pending(
            "tool-1".to_string(),
            "cancel me".to_string(),
            SubagentDelivery::Foreground,
        );
        panel.associate("tool-1", "agent-1", SubagentDelivery::Foreground);
        assert!(panel.finish("agent-1", SubagentPhase::Cancelled, "Cancelled"));
        assert!(!panel.finish("agent-1", SubagentPhase::Completed, "Completed"));

        let rendered =
            render_panel_message(&panel.encode_message(), 80, Duration::ZERO, None).unwrap();
        let text = rendered
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(text.contains("Cancelled. 1/1"));
        assert!(!text.contains("Completed. 0/1"));
    }

    #[test]
    fn late_association_preserves_existing_running_or_terminal_phase() {
        let mut panel = SubagentPanel::new(4);
        panel.add_pending(
            "tool-1".to_string(),
            "fast task".to_string(),
            SubagentDelivery::Foreground,
        );
        panel.finish_tool_call("tool-1", SubagentPhase::Completed, "Completed");

        assert!(panel.associate("tool-1", "agent-1", SubagentDelivery::Foreground));
        assert_eq!(panel.members[0].phase, SubagentPhase::Completed);
        assert_eq!(panel.members[0].status_text, "Completed");
        panel.promote("agent-1");
        panel.associate("tool-1", "agent-1", SubagentDelivery::Foreground);
        assert_eq!(panel.members[0].delivery, SubagentDelivery::Background);
    }

    #[test]
    fn compact_panel_lines_never_exceed_narrow_width() {
        let mut panel = SubagentPanel::new(3);
        panel.add_pending(
            "tool-1".to_string(),
            "a deliberately long delegated task".to_string(),
            SubagentDelivery::Foreground,
        );
        let lines =
            render_panel_message(&panel.encode_message(), 18, Duration::ZERO, None).unwrap();
        assert!(lines.iter().all(|line| line.width() <= 18));
    }

    #[test]
    fn member_columns_adapt_from_three_to_two_to_one() {
        let mut panel = SubagentPanel::new(5);
        for index in 1..=3 {
            panel.add_pending(
                format!("tool-{index}"),
                format!("task {index}"),
                SubagentDelivery::Foreground,
            );
        }
        let rows_with_ids = |width| {
            render_panel_message(&panel.encode_message(), width, Duration::ZERO, None)
                .unwrap()
                .into_iter()
                .filter(|line| {
                    line.spans.iter().any(|span| {
                        span.content.contains("001")
                            || span.content.contains("002")
                            || span.content.contains("003")
                    })
                })
                .count()
        };

        assert_eq!(rows_with_ids(120), 1);
        assert_eq!(rows_with_ids(80), 2);
        assert_eq!(rows_with_ids(40), 3);
    }

    #[test]
    fn short_viewport_compacts_members_into_fewer_rows() {
        let mut panel = SubagentPanel::new(8);
        for index in 1..=3 {
            panel.add_pending(
                format!("tool-{index}"),
                format!("task {index}"),
                SubagentDelivery::Foreground,
            );
        }

        let lines =
            render_panel_message(&panel.encode_message(), 40, Duration::ZERO, Some(3)).unwrap();
        assert_eq!(lines.len(), 3);
        let text = lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(text.contains("001"));
        assert!(text.contains("002"));
        assert!(text.contains("003"));
        assert!(lines.iter().all(|line| line.width() <= 40));
    }

    #[test]
    fn terminal_failure_reason_is_visible() {
        let mut panel = SubagentPanel::new(9);
        panel.add_pending(
            "tool-1".to_string(),
            "review code".to_string(),
            SubagentDelivery::Background,
        );
        panel.associate("tool-1", "agent-1", SubagentDelivery::Background);
        panel.finish("agent-1", SubagentPhase::Failed, "read permission denied");

        let text = render_panel_message(&panel.encode_message(), 100, Duration::ZERO, None)
            .unwrap()
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(text.contains("read permission denied"));
    }

    #[test]
    fn compact_status_keeps_all_member_states_at_40_columns() {
        let mut panel = SubagentPanel::new(10);
        for index in 1..=3 {
            panel.add_pending(
                format!("tool-{index}"),
                format!("task {index}"),
                SubagentDelivery::Foreground,
            );
            panel.associate(
                &format!("tool-{index}"),
                &format!("agent-{index}"),
                SubagentDelivery::Foreground,
            );
            panel.finish(
                &format!("agent-{index}"),
                SubagentPhase::Completed,
                "Completed",
            );
        }

        assert_eq!(
            compact_panel_status(&panel, 40),
            "Agent Swarm 3/3 · 001✓ · 002✓ · 003✓"
        );
    }

    #[test]
    fn progress_is_monotonic_and_explicit_restart_resets_terminal_member() {
        let mut panel = SubagentPanel::new(6);
        panel.add_pending(
            "tool-1".to_string(),
            "continued task".to_string(),
            SubagentDelivery::Foreground,
        );
        panel.associate("tool-1", "agent-1", SubagentDelivery::Foreground);
        panel.update_progress("agent-1", "Working", None, Some(7), Some(60));
        panel.update_progress("agent-1", "Reconciled", None, Some(1), Some(60));
        assert_eq!(panel.members[0].current, Some(7));

        panel.finish("agent-1", SubagentPhase::Completed, "Completed");
        assert!(panel.restart("agent-1", SubagentDelivery::Background));
        assert_eq!(panel.members[0].phase, SubagentPhase::Queued);
        assert_eq!(panel.members[0].delivery, SubagentDelivery::Background);
        assert_eq!(panel.members[0].current, None);
    }

    #[test]
    fn paused_panel_is_not_presented_as_actively_working() {
        let mut panel = SubagentPanel::new(11);
        panel.add_pending(
            "tool-1".to_string(),
            "paused task".to_string(),
            SubagentDelivery::Background,
        );
        panel.associate("tool-1", "agent-1", SubagentDelivery::Background);
        panel.pause(
            "agent-1",
            "Paused",
            Some("queue 2 · breaker paused · retry_message required"),
        );

        let text = render_panel_message(&panel.encode_message(), 120, Duration::ZERO, None)
            .unwrap()
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(text.contains("Paused. 1/1"), "{text}");
        assert!(!text.contains("Working..."), "{text}");
        assert!(text.contains("retry_message"), "{text}");
    }

    #[test]
    fn mixed_halted_and_completed_panel_reports_finished_not_completed() {
        let mut panel = SubagentPanel::new(12);
        for index in 1..=2 {
            panel.add_pending(
                format!("tool-{index}"),
                format!("task {index}"),
                SubagentDelivery::Background,
            );
            panel.associate(
                &format!("tool-{index}"),
                &format!("agent-{index}"),
                SubagentDelivery::Background,
            );
        }
        panel.finish("agent-1", SubagentPhase::Completed, "Completed");
        panel.finish(
            "agent-2",
            SubagentPhase::Halted,
            "queue 1 retained in dead-letter",
        );

        let text = render_panel_message(&panel.encode_message(), 120, Duration::ZERO, None)
            .unwrap()
            .iter()
            .flat_map(|line| line.spans.iter())
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(text.contains("Finished. 1/2 · 1 halted"), "{text}");
        assert!(!text.contains("Completed. 1/2"), "{text}");
    }
}
