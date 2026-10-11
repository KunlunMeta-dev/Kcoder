//! Event-batch result and redraw/flush aggregation.

use super::*;

pub(super) struct HandledAppEvent {
    pub(super) action: Option<UserAction>,
    pub(super) redraw: bool,
    pub(super) flush_frame: bool,
}

impl HandledAppEvent {
    pub(super) fn redraw() -> Self {
        Self {
            action: None,
            redraw: true,
            flush_frame: false,
        }
    }

    pub(super) fn redraw_and_flush() -> Self {
        Self {
            action: None,
            redraw: true,
            flush_frame: true,
        }
    }

    pub(super) fn quiet() -> Self {
        Self {
            action: None,
            redraw: false,
            flush_frame: false,
        }
    }

    pub(super) fn action(action: UserAction) -> Self {
        Self {
            action: Some(action),
            redraw: true,
            flush_frame: false,
        }
    }

    pub(super) fn merge(&mut self, next: Self) {
        self.redraw |= next.redraw;
        self.flush_frame |= next.flush_frame;
        if self.action.is_none() {
            self.action = next.action;
        }
    }
}
