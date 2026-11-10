//! One error-aware continuation for a tool batch rejected before dispatch.
use crate::EngineEvent;
use kcoder_state::AppState;
use kcoder_tools::ToolOutput;
use kcoder_types::{ContentBlock, Message, MessageOrigin, Usage};
use serde_json::Value;
use std::collections::HashSet;

const NOT_EXECUTED: &str =
    "Tool was not executed: another call in the same response had incomplete JSON arguments.";
const REGENERATE: &str = "<system-reminder>The preceding model response ended with incomplete \
tool argument JSON. No tools in that response were executed. Continue from the recorded results \
of earlier responses; do not repeat operations that already have results. Regenerate any still \
needed calls with complete JSON matching their declared schemas. For tool_execute, include the \
exact discovered tool_name and actual argument values, rather than a copy of the schema. \
Do not guess the outcome of an earlier operation.</system-reminder>";

#[derive(Default)]
pub(super) struct ToolArgumentRecovery {
    regenerated: bool,
}

impl ToolArgumentRecovery {
    pub(super) fn prepare(
        &mut self,
        state: &AppState,
        blocks: &[ContentBlock],
        usage: &Option<Usage>,
        complete: &[(String, String, Value)],
    ) -> Option<Vec<EngineEvent>> {
        if self.regenerated {
            return None;
        }
        let mut ids = HashSet::new();
        for block in blocks {
            if let ContentBlock::ToolUse { id, name, .. } = block
                && (name == "show_widget" || !ids.insert(id.as_str()))
            {
                // A live widget preview or ambiguous call identity cannot be replayed.
                return None;
            }
        }
        self.regenerated = true;
        let mut events = vec![EngineEvent::ToolInputReset];
        let mut content = Vec::new();
        for block in blocks {
            match block {
                ContentBlock::ToolUse { id, .. } => {
                    if let Some((id, name, input)) = complete
                        .iter()
                        .find(|(complete_id, _, _)| complete_id == id)
                    {
                        content.push(ContentBlock::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                        events.push(EngineEvent::ToolUseStarted {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                    }
                }
                ContentBlock::Text { text } if !text.is_empty() => content.push(block.clone()),
                ContentBlock::Thinking { .. } | ContentBlock::RedactedThinking { .. } => {
                    content.push(block.clone())
                }
                _ => {}
            }
        }
        if !content.is_empty() {
            state.add_message(Message::Assistant {
                content,
                usage: usage.clone(),
            });
        }
        events.push(EngineEvent::AssistantMessageDone);
        if !complete.is_empty() {
            state.add_message(Message::User {
                origin: MessageOrigin::Runtime,
                content: complete
                    .iter()
                    .map(|(id, _, _)| ContentBlock::ToolResult {
                        tool_use_id: id.clone(),
                        content: vec![ContentBlock::Text {
                            text: NOT_EXECUTED.into(),
                        }],
                        is_error: Some(true),
                    })
                    .collect(),
            });
            for (id, name, _) in complete {
                events.push(EngineEvent::ToolResult {
                    id: id.clone(),
                    name: name.clone(),
                    output: ToolOutput::error(NOT_EXECUTED),
                });
            }
        }
        state.add_message(Message::runtime_text(REGENERATE));
        events.push(EngineEvent::SystemNotice(
            "Model returned incomplete tool arguments; no tools in that response ran. \
             Asking the same model to continue by regenerating complete arguments once."
                .into(),
        ));
        Some(events)
    }
}
