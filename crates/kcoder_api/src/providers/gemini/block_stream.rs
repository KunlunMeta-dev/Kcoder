//! Keep consecutive Gemini text fragments in one logical output block.
use crate::{ApiErrorKind, response_budget::ResponseBudget};
use kcoder_types::{ContentBlock, StreamEvent};

#[derive(Default)]
pub(super) struct BlockStream {
    next_index: usize,
    open: Option<usize>,
    incoming: Option<(usize, usize)>,
}

impl BlockStream {
    fn close(&mut self, events: &mut Vec<StreamEvent>, budget: &mut ResponseBudget) {
        if let Some(index) = self.open.take() {
            budget.finish(index);
            events.push(StreamEvent::ContentBlockStop { index });
        }
    }

    pub(super) fn normalize(
        &mut self,
        raw: Vec<StreamEvent>,
        budget: &mut ResponseBudget,
    ) -> Result<Vec<StreamEvent>, ApiErrorKind> {
        let mut events = Vec::new();
        for event in raw {
            match event {
                StreamEvent::ContentBlockStart {
                    index: raw_index,
                    content_block: ContentBlock::Text { text },
                } => {
                    let index = if let Some(index) = self.open {
                        index
                    } else {
                        let index = self.next_index;
                        let event = StreamEvent::ContentBlockStart {
                            index,
                            content_block: ContentBlock::Text { text },
                        };
                        budget.observe(&event)?;
                        events.push(event);
                        self.next_index += 1;
                        self.open = Some(index);
                        index
                    };
                    self.incoming = Some((raw_index, index));
                }
                StreamEvent::ContentBlockStart {
                    index: raw_index,
                    content_block,
                } => {
                    self.close(&mut events, budget);
                    let index = self.next_index;
                    let event = StreamEvent::ContentBlockStart {
                        index,
                        content_block,
                    };
                    budget.observe(&event)?;
                    self.next_index += 1;
                    self.incoming = Some((raw_index, index));
                    events.push(event);
                }
                StreamEvent::ContentBlockDelta {
                    index: raw_index,
                    delta,
                } => {
                    let index = self
                        .incoming
                        .filter(|(raw, _)| *raw == raw_index)
                        .map(|(_, index)| index)
                        .ok_or_else(|| ApiErrorKind::Api {
                            error_type: "provider_protocol_error".into(),
                            message: "Gemini delta has no active part".into(),
                        })?;
                    let event = StreamEvent::ContentBlockDelta { index, delta };
                    budget.observe(&event)?;
                    events.push(event);
                }
                StreamEvent::ContentBlockStop { index: raw_index } => {
                    if let Some((_, index)) =
                        self.incoming.take().filter(|(raw, _)| *raw == raw_index)
                        && self.open != Some(index)
                    {
                        budget.finish(index);
                        events.push(StreamEvent::ContentBlockStop { index });
                    }
                }
                StreamEvent::MessageStop => {
                    self.close(&mut events, budget);
                    events.push(StreamEvent::MessageStop);
                }
                other => events.push(other),
            }
        }
        Ok(events)
    }
}
