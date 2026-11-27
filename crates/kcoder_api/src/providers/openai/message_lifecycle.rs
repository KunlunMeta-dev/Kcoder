//! Native OpenAI protocols share the engine's normalized message lifecycle.
use crate::providers::ProviderStream;
use futures::StreamExt;
use kcoder_types::{StreamEvent, StreamingMessage};

pub(super) fn with_message_lifecycle(mut stream: ProviderStream, model: String) -> ProviderStream {
    Box::pin(async_stream::stream! {
        let mut started = false;
        let mut open_blocks = std::collections::BTreeSet::new();
        while let Some(event) = stream.next().await {
            // HTTP/protocol failures before a valid event must remain eligible
            // for the host's pre-response retry policy.
            if !started && event.is_ok() {
                started = true;
                yield Ok(StreamEvent::MessageStart {
                    message: StreamingMessage {
                        id: String::new(),
                        role: "assistant".into(),
                        content: Vec::new(),
                        model: model.clone(),
                        stop_reason: None,
                        stop_sequence: None,
                        usage: None,
                    },
                });
            }
            match &event {
                Ok(StreamEvent::ContentBlockStart { index, .. }) => { open_blocks.insert(*index); }
                Ok(StreamEvent::ContentBlockStop { index }) => { open_blocks.remove(index); }
                Ok(StreamEvent::MessageStop) => {
                    // Chat Completions finishes text/reasoning with the message;
                    // Responses peers may likewise omit per-block done events.
                    // Close only on a confirmed terminal event, never on EOF/error.
                    for index in std::mem::take(&mut open_blocks) {
                        yield Ok(StreamEvent::ContentBlockStop { index });
                    }
                }
                _ => {}
            }
            yield event;
        }
    })
}
