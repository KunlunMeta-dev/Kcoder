use kcoder_types::{DisplayMessage, MessageRole};
use std::fmt::Debug;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HistoryCellKind {
    User,
    AgentMarkdown,
    System,
}

pub(crate) trait HistoryCell: Debug + Send + Sync {
    fn kind(&self) -> HistoryCellKind;
    fn display_message(&self) -> DisplayMessage;
}

#[derive(Debug, Clone)]
pub(crate) struct UserHistoryCell {
    text: String,
}

impl UserHistoryCell {
    pub(crate) fn new(text: String) -> Self {
        Self { text }
    }
}

impl HistoryCell for UserHistoryCell {
    fn kind(&self) -> HistoryCellKind {
        HistoryCellKind::User
    }

    fn display_message(&self) -> DisplayMessage {
        DisplayMessage {
            role: MessageRole::User,
            text: self.text.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AgentMarkdownCell {
    markdown: String,
}

impl AgentMarkdownCell {
    pub(crate) fn new(markdown: String) -> Self {
        Self { markdown }
    }
}

impl HistoryCell for AgentMarkdownCell {
    fn kind(&self) -> HistoryCellKind {
        HistoryCellKind::AgentMarkdown
    }

    fn display_message(&self) -> DisplayMessage {
        DisplayMessage {
            role: MessageRole::Assistant,
            text: self.markdown.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SystemHistoryCell {
    text: String,
}

impl SystemHistoryCell {
    pub(crate) fn new(text: String) -> Self {
        Self { text }
    }
}

impl HistoryCell for SystemHistoryCell {
    fn kind(&self) -> HistoryCellKind {
        HistoryCellKind::System
    }

    fn display_message(&self) -> DisplayMessage {
        DisplayMessage {
            role: MessageRole::System,
            text: self.text.clone(),
        }
    }
}

pub(crate) fn history_cell_from_display_message(message: DisplayMessage) -> Box<dyn HistoryCell> {
    match message.role {
        MessageRole::User => Box::new(UserHistoryCell::new(message.text)),
        MessageRole::Assistant => Box::new(AgentMarkdownCell::new(message.text)),
        MessageRole::System => Box::new(SystemHistoryCell::new(message.text)),
    }
}
