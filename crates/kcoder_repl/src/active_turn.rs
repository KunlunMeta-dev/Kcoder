use crate::subagent_panel::SubagentPanel;
use crate::tool_format::format_running_tool;
use crate::write_preview::format_write_preview_message;
use kcoder_engine::WriteInputPreview;
use kcoder_types::{DisplayMessage, MessageRole};

/// In-flight content for a single assistant turn. Assistant text and tool
/// calls are kept as ordered entries so the transcript mirrors the model's
/// visible content-block order.
#[derive(Debug, Default, Hash)]
pub(crate) struct ActiveCell {
    pub(crate) entries: Vec<ActiveEntry>,
}

impl ActiveCell {
    pub(crate) fn has_running_tool_entries(&self) -> bool {
        self.entries.iter().any(|entry| match entry {
            ActiveEntry::Tool(ToolStatus::Running { .. }) => true,
            ActiveEntry::SubagentPanel(panel) => !panel.all_terminal(),
            _ => false,
        })
    }

    /// True when a running tool call supports collapsing its remaining wait
    /// (Sleep, wait), so the Escape key can shorten it instead of cancelling
    /// the whole turn.
    pub(crate) fn has_running_shortenable_tool(&self) -> bool {
        self.entries.iter().any(|entry| match entry {
            ActiveEntry::Tool(ToolStatus::Running { name, .. }) => {
                matches!(name.as_str(), "Sleep" | "wait")
            }
            _ => false,
        })
    }

    pub(crate) fn display_messages(&self, expanded_tools: bool) -> Vec<DisplayMessage> {
        self.display_messages_with_text_filter(expanded_tools, |text| {
            (!text.is_empty()).then(|| text.to_string())
        })
    }

    fn display_messages_with_text_filter(
        &self,
        expanded_tools: bool,
        text_filter: impl Fn(&str) -> Option<String>,
    ) -> Vec<DisplayMessage> {
        let mut messages = Vec::new();
        for entry in &self.entries {
            match entry {
                ActiveEntry::Text(text) => {
                    if let Some(text) = text_filter(text) {
                        messages.push(DisplayMessage {
                            role: MessageRole::Assistant,
                            text,
                        });
                    }
                }
                ActiveEntry::Tool(ToolStatus::Running {
                    name,
                    input,
                    write_preview,
                    ..
                }) => {
                    if !name.is_empty() {
                        messages.push(DisplayMessage {
                            role: MessageRole::System,
                            text: write_preview.as_ref().map_or_else(
                                || format_running_tool(name, input, expanded_tools),
                                |preview| {
                                    format_write_preview_message(
                                        &format!("⟳ Running tool: {name}"),
                                        preview,
                                    )
                                },
                            ),
                        });
                    }
                }
                ActiveEntry::Tool(ToolStatus::Done {
                    use_text,
                    status_text,
                    diff_text,
                    write_preview,
                    ..
                }) => {
                    if let Some(preview) = write_preview {
                        messages.push(DisplayMessage {
                            role: MessageRole::System,
                            text: format_write_preview_message("[Tool use: write]", preview),
                        });
                    } else if !use_text.is_empty() {
                        messages.push(DisplayMessage {
                            role: MessageRole::System,
                            text: use_text.clone(),
                        });
                    }
                    if !status_text.is_empty() {
                        messages.push(DisplayMessage {
                            role: MessageRole::System,
                            text: status_text.clone(),
                        });
                    }
                    if let Some(diff) = diff_text {
                        messages.push(DisplayMessage {
                            role: MessageRole::System,
                            text: diff.clone(),
                        });
                    }
                }
                ActiveEntry::SubagentPanel(panel) => messages.push(DisplayMessage {
                    role: MessageRole::System,
                    text: panel.encode_message(),
                }),
            }
        }
        messages
    }
}

#[derive(Debug, Hash)]
pub(crate) enum ActiveEntry {
    Text(String),
    Tool(ToolStatus),
    SubagentPanel(SubagentPanel),
}

#[derive(Debug, Hash)]
pub(crate) enum ToolStatus {
    Running {
        id: String,
        name: String,
        input: String,
        write_preview: Option<WriteInputPreview>,
    },
    // `Done` stores pre-rendered display text instead of the raw tool result.
    // Large tool outputs should not be rescanned on every spinner redraw while
    // the active turn is still open.
    Done {
        id: String,
        input: String,
        use_text: String,
        status_text: String,
        diff_text: Option<String>,
        write_preview: Option<WriteInputPreview>,
    },
}
