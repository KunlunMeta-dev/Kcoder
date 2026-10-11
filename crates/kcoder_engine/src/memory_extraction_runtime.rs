//! Memory extraction runtime within the shared engine ownership boundary.

use super::*;

pub(super) fn last_assistant_text(messages: &[Message]) -> Option<String> {
    messages.iter().rev().find_map(|message| match message {
        Message::Assistant { content, .. } => Some(
            content
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>(),
        ),
        Message::User { .. } => None,
    })
}

pub(super) fn extract_memory_facts(text: &str) -> Vec<String> {
    let mut facts = Vec::new();
    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains("remember that")
            && let Some(idx) = lower.find("remember that")
        {
            let fact = line[idx + "remember that".len()..].trim();
            if !fact.is_empty() && fact.len() > 10 {
                facts.push(fact.to_string());
            }
        }
    }
    facts
}

impl QueryEngine {
    /// Extract durable memories from the conversation after a completed turn.
    pub(super) async fn maybe_extract_memories(&self, _recent_tools: &[String]) {
        let enabled = {
            let settings = recover_read_lock(&self.settings, "settings");
            settings.auto_memory_enabled
        };
        if !enabled {
            return;
        }

        // Simple extraction: look for explicit "remember that ..." patterns in
        // assistant text. A full implementation would run a side-agent; this
        // gives immediate value without an extra API call.
        let messages = self.state.recent_messages(4);
        let candidates: Vec<String> = messages
            .iter()
            .rev()
            .take(4)
            .filter_map(|m| match m {
                Message::Assistant { content, .. } => Some(content),
                _ => None,
            })
            .flat_map(|blocks| {
                blocks.iter().filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                })
            })
            .flat_map(|text| extract_memory_facts(&text))
            .collect();

        for fact in candidates {
            if let Err(e) = self.memory_manager.remember_auto("project", &fact) {
                warn!("failed to extract memory: {}", e);
            } else {
                debug!("extracted memory: {}", fact);
            }
        }
    }
}
