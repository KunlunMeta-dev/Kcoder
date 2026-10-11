use ratatui::layout::{Constraint, Direction, Layout, Rect};

use crate::widgets::STATUS_INDICATOR_MAX_HEIGHT;

const STATUS_STACK_MAX_HEIGHT: u16 = STATUS_INDICATOR_MAX_HEIGHT + 1;
pub(crate) const BOTTOM_PANE_TOP_SPACER: u16 = 1;

pub(crate) fn max_inline_viewport_height(available_height: u16) -> u16 {
    available_height.max(1)
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ReplLayoutAreas {
    pub(crate) message: Rect,
    pub(crate) bottom_overlay: Option<Rect>,
    pub(crate) status: Option<Rect>,
    pub(crate) pending_input: Option<Rect>,
    pub(crate) input: Rect,
    pub(crate) footer: Rect,
    pub(crate) tail: Rect,
    pub(crate) todo: Option<Rect>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ReplLayoutHeights {
    pub(crate) message: u16,
    pub(crate) bottom_overlay: u16,
    pub(crate) composer: u16,
    pub(crate) status: u16,
    pub(crate) pending_input: u16,
    pub(crate) footer: u16,
    pub(crate) todo: u16,
}

impl From<[u16; 7]> for ReplLayoutHeights {
    fn from(values: [u16; 7]) -> Self {
        let [
            message,
            bottom_overlay,
            composer,
            status,
            pending_input,
            footer,
            todo,
        ] = values;
        Self {
            message,
            bottom_overlay,
            composer,
            status,
            pending_input,
            footer,
            todo,
        }
    }
}

pub(crate) fn split_repl_layout(area: Rect, heights: ReplLayoutHeights) -> ReplLayoutAreas {
    let ReplLayoutHeights {
        message: message_height,
        bottom_overlay: bottom_overlay_height,
        composer: composer_height,
        status: status_height,
        pending_input: pending_input_height,
        footer: footer_height,
        todo: desired_todo_height,
    } = heights;
    let todo_height = desired_todo_height.min(area.height);
    let main_area = Rect {
        height: area.height.saturating_sub(todo_height),
        ..area
    };
    let todo_area = (todo_height > 0).then_some(Rect {
        y: main_area.bottom(),
        height: todo_height,
        ..area
    });

    let footer_height = footer_height.min(main_area.height.saturating_sub(1));
    let mut remaining = main_area.height.saturating_sub(footer_height);

    let composer_min_height = if main_area.height == 0 { 0 } else { 1 };
    let composer_height = composer_height.max(composer_min_height).min(remaining);
    remaining = remaining.saturating_sub(composer_height);

    let bottom_pane_top_spacer = BOTTOM_PANE_TOP_SPACER.min(remaining);
    remaining = remaining.saturating_sub(bottom_pane_top_spacer);

    let status_height = status_height.min(STATUS_STACK_MAX_HEIGHT).min(remaining);
    remaining = remaining.saturating_sub(status_height);

    let pending_input_height = pending_input_height.min(remaining);
    remaining = remaining.saturating_sub(pending_input_height);

    let bottom_overlay_height = bottom_overlay_height.min(remaining);
    remaining = remaining.saturating_sub(bottom_overlay_height);

    let message_height = message_height.min(remaining);

    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(message_height),
            Constraint::Length(bottom_overlay_height),
            Constraint::Length(bottom_pane_top_spacer),
            Constraint::Length(status_height),
            Constraint::Length(pending_input_height),
            Constraint::Length(composer_height),
            Constraint::Length(footer_height),
            Constraint::Min(0),
        ])
        .split(main_area);

    ReplLayoutAreas {
        message: vertical[0],
        bottom_overlay: (bottom_overlay_height > 0).then_some(vertical[1]),
        status: (status_height > 0).then_some(vertical[3]),
        pending_input: (pending_input_height > 0).then_some(vertical[4]),
        input: vertical[5],
        footer: vertical[6],
        tail: vertical[7],
        todo: todo_area,
    }
}
