use kcoder_state::AppState;
use kcoder_types::{StreamEvent, Usage};

/// Drop also records partial usage after a stream error, protocol rejection or cancellation.
pub(super) struct UsageAttempt<'a> {
    state: Option<&'a AppState>,
    model: &'a str,
    usage: Option<Usage>,
}

impl<'a> UsageAttempt<'a> {
    pub(super) fn new(state: Option<&'a AppState>, model: &'a str) -> Self {
        Self {
            state,
            model,
            usage: None,
        }
    }

    pub(super) fn observe(&mut self, event: &StreamEvent) {
        let update = match event {
            StreamEvent::MessageStart { message } => message.usage.as_ref(),
            StreamEvent::MessageDelta { delta } => delta.usage.as_ref(),
            _ => None,
        };
        if let Some(update) = update {
            if let Some(usage) = self.usage.as_mut() {
                usage.merge_stream_update(update);
            } else {
                self.usage = Some(update.clone());
            }
        }
    }
}

impl Drop for UsageAttempt<'_> {
    fn drop(&mut self) {
        if let Some(state) = self.state {
            state.record_token_usage(self.model, self.usage.as_ref());
        }
    }
}
