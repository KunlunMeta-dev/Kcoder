//! Turn steering within the shared engine ownership boundary.

use super::*;

impl std::fmt::Display for TurnSteerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoActiveTurn => formatter.write_str("no active regular turn accepts steering"),
            Self::QueueFull { max } => write!(formatter, "turn steer queue is full ({max})"),
        }
    }
}

impl std::error::Error for TurnSteerError {}

impl TurnSteerSession {
    pub(super) fn drain_pending(&self) -> Vec<PendingTurnSteer> {
        let mut mailbox = self
            .mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(active) = mailbox
            .active
            .as_mut()
            .filter(|active| active.turn_id == self.turn_id)
        else {
            return Vec::new();
        };
        active.pending.drain(..).collect()
    }

    /// Atomically finish a turn at the final-response boundary, preventing input
    /// from being accepted after an empty check and then never consumed. If new
    /// input is found while holding the lock, return it to the same turn.
    pub(super) fn finish_or_drain(&mut self) -> TurnSteerBoundary {
        let mut mailbox = self
            .mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(active) = mailbox
            .active
            .as_mut()
            .filter(|active| active.turn_id == self.turn_id)
        else {
            self.closed = true;
            return TurnSteerBoundary::Finished;
        };
        if !active.pending.is_empty() {
            return TurnSteerBoundary::Pending(active.pending.drain(..).collect());
        }
        mailbox.active = None;
        self.closed = true;
        TurnSteerBoundary::Finished
    }
}

impl Drop for TurnSteerSession {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        let mut mailbox = self
            .mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if mailbox
            .active
            .as_ref()
            .is_some_and(|active| active.turn_id == self.turn_id)
        {
            mailbox.active = None;
        }
    }
}

impl QueryEngine {
    pub(super) fn note_foreground_activity(&self) {
        *recover_write_lock(
            &self.auto_curator_last_activity,
            "auto_curator_last_activity",
        ) = SystemTime::now();
    }

    /// Signal the engine to stop as soon as it reaches a cancellation check
    /// point.
    pub fn cancel(&self) {
        self.cancel_token.cancel();
    }

    /// Collapse the remaining wait of running wait-style tools (Sleep, wait) to
    /// a short grace period without cancelling the turn. Waking a tool this way
    /// is one-shot: it never affects waits that start later.
    pub fn shorten_waiting_tools(&self) {
        self.shorten_signal.notify_waiters();
    }

    /// True while a main-thread turn stream is alive on this engine. Host
    /// watch loops must not flush background events while this is set: the
    /// turn loop owns completion-notification delivery in that window.
    pub fn turn_driver_active(&self) -> bool {
        self.turn_driver_signal.active()
    }

    pub(crate) fn turn_driver_signal(&self) -> &turn_driver::TurnDriverSignal {
        &self.turn_driver_signal
    }

    pub(super) fn is_cancelled(&self) -> bool {
        self.cancel_token.is_cancelled()
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel_token.clone()
    }

    /// Queue user input for the current regular turn. It is written to the session
    /// only after the current provider response and its complete tool batch, and
    /// never splits a tool_use/tool_result pair.
    pub fn enqueue_turn_steer(
        &self,
        id: u64,
        message: Message,
    ) -> std::result::Result<(), TurnSteerError> {
        let mut mailbox = self
            .turn_steer_mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(active) = mailbox.active.as_mut() else {
            return Err(TurnSteerError::NoActiveTurn);
        };
        if active.pending.len() >= TURN_STEER_QUEUE_MAX {
            return Err(TurnSteerError::QueueFull {
                max: TURN_STEER_QUEUE_MAX,
            });
        }
        active.pending.push_back(PendingTurnSteer { id, message });
        Ok(())
    }

    /// Register the steering mailbox before scheduling an asynchronous turn task.
    /// The TUI uses this handle to eliminate races from rapid submissions before
    /// the task receives its first poll.
    pub fn begin_turn_steering(&self) -> Option<TurnSteerSession> {
        let mut mailbox = self
            .turn_steer_mailbox
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if mailbox.active.is_some() {
            warn!("another regular turn is already active; steering disabled for concurrent turn");
            return None;
        }
        mailbox.next_turn_id = mailbox.next_turn_id.wrapping_add(1).max(1);
        let turn_id = mailbox.next_turn_id;
        mailbox.active = Some(ActiveTurnSteers {
            turn_id,
            pending: VecDeque::new(),
        });
        Some(TurnSteerSession {
            mailbox: Arc::clone(&self.turn_steer_mailbox),
            turn_id,
            closed: false,
        })
    }

    pub(super) fn apply_turn_steers(&self, steers: Vec<PendingTurnSteer>) -> Vec<u64> {
        steers
            .into_iter()
            .map(|steer| {
                self.state.add_message(steer.message);
                steer.id
            })
            .collect()
    }
}
