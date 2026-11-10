//! Native receipts are presentation data, separate from provider messages.
use super::*;
use kcoder_types::web_sources::{WebSourceReadStatus, WebSourcesV1};

#[derive(Clone, Debug, Default)]
pub(super) struct NativeSourceSlots(std::collections::HashMap<String, Vec<WebSourcesV1>>);

impl NativeSourceSlots {
    pub(super) fn register(&mut self, receipts: Vec<WebSourcesV1>) -> DisplayMessage {
        // These opaque IDs belong only to the terminal projection, never model messages.
        let text = self
            .0
            .iter()
            .find_map(|(key, existing)| (existing == &receipts).then(|| key.clone()))
            .unwrap_or_else(|| format!("[native-source-slot:{}]", uuid::Uuid::new_v4()));
        self.0.insert(text.clone(), receipts);
        DisplayMessage {
            role: MessageRole::System,
            text,
        }
    }

    pub(super) fn resolve(
        &self,
        message: &DisplayMessage,
        expanded: bool,
    ) -> Option<DisplayMessage> {
        if message.role != MessageRole::System {
            return None;
        }
        let receipts = self.0.get(&message.text)?;
        Some(DisplayMessage {
            role: MessageRole::System,
            text: if expanded {
                source_text(receipts)
            } else {
                String::new()
            },
        })
    }

    pub(super) fn extend(&mut self, other: &Self) {
        self.0.extend(other.0.clone());
    }
}

fn source_text(receipts: &[WebSourcesV1]) -> String {
    let mut output = String::new();
    for receipt in receipts {
        output.push_str(&format!("Web sources · {}", receipt.tool_call_id));
        if let Some(provider) = receipt.provider {
            output.push_str(&format!(" · {}", provider.id()));
        }
        for source in &receipt.sources {
            let status = match source.read_status {
                WebSourceReadStatus::SummaryOnly => "Summary only",
                WebSourceReadStatus::Read => "Read",
                WebSourceReadStatus::Partial => "Partially read",
                WebSourceReadStatus::Unreadable => "Unreadable",
            };
            output.push_str(&format!(
                "\n- {} · {}{}\n  {}",
                source.title,
                status,
                if source.cache_hit { " · Cached" } else { "" },
                source.url
            ));
            if let Some(author) = &source.author {
                output.push_str(&format!("\n  Author: {author}"));
            }
            if let Some(published) = &source.published_at {
                output.push_str(&format!("\n  Published: {published}"));
            }
            output.push_str(&format!("\n  Retrieved: {}", source.retrieved_at));
        }
        output.push_str("\n\n");
    }
    sanitize_tui_text(output.trim_end())
}

#[derive(Default)]
pub(super) struct WebHistory {
    messages: Vec<Message>,
    receipts: Vec<WebSourcesV1>,
}
impl std::ops::Deref for WebHistory {
    type Target = [Message];
    fn deref(&self) -> &Self::Target {
        &self.messages
    }
}

fn bound_receipts(message: &Message, receipts: &[WebSourcesV1]) -> Vec<WebSourcesV1> {
    let Message::User { content, .. } = message else {
        return Vec::new();
    };
    receipts
        .iter()
        .filter(|receipt| {
            content.iter().any(|block| match block {
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    receipt.matches(&receipt.identity.thread_id, tool_use_id)
                }
                _ => false,
            })
        })
        .cloned()
        .collect()
}

#[cfg(test)]
pub(super) fn history_with_receipts(
    messages: Vec<Message>,
    receipts: &[WebSourcesV1],
) -> WebHistory {
    let receipts = messages
        .iter()
        .flat_map(|message| bound_receipts(message, receipts))
        .collect();
    WebHistory { messages, receipts }
}

pub(super) fn receipts_for_child(engine: &QueryEngine, id: &str) -> Vec<WebSourcesV1> {
    engine
        .subscribe_subagent_conversation(id)
        .ok()
        .map(|subscription| {
            subscription
                .snapshot
                .entries
                .into_iter()
                .flat_map(|entry| entry.web_sources)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn messages_for_state(state: &kcoder_state::AppState) -> WebHistory {
    let mut history = WebHistory::default();
    for (message, receipts) in state.messages_with_web_sources() {
        history.receipts.extend(bound_receipts(&message, &receipts));
        history.messages.push(message);
    }
    history
}

pub(super) fn messages_for_entries(entries: Vec<kcoder_state::HistoryEntry>) -> WebHistory {
    let mut history = WebHistory::default();
    for entry in entries {
        history
            .receipts
            .extend(bound_receipts(&entry.message, &entry.web_sources));
        history.messages.push(entry.message);
    }
    history
}

impl ReplApp {
    pub(super) fn append_bound_web_sources(
        &mut self,
        messages: &[Message],
        receipts: &[WebSourcesV1],
    ) {
        let history = WebHistory {
            messages: Vec::new(),
            receipts: messages
                .iter()
                .flat_map(|message| bound_receipts(message, receipts))
                .collect(),
        };
        self.append_history_web_sources(&history);
    }

    pub(super) fn append_history_web_sources(&mut self, history: &WebHistory) {
        for receipt in &history.receipts {
            let message = self
                .messages
                .native_web_sources
                .register(vec![receipt.clone()]);
            self.messages.push(message);
        }
        if let Some(deferred) = self.deferred_resumed_transcript.as_mut() {
            deferred.loaded_display_len = self.messages.len();
        }
        self.invalidate_transcript_rendering();
    }

    pub(super) fn replace_web_history(&mut self, history: &WebHistory) {
        self.replace_transcript_from_history(history);
        self.append_history_web_sources(history);
    }

    pub(super) fn push_native_web_sources(
        &mut self,
        tool_call_id: &str,
        receipts: Vec<WebSourcesV1>,
    ) {
        let receipts = receipts
            .into_iter()
            .filter(|receipt| receipt.matches(&self.session_id, tool_call_id))
            .collect::<Vec<_>>();
        if receipts.is_empty() {
            return;
        }
        let message = self.messages.native_web_sources.register(receipts);
        if self
            .pending_web_source_slots
            .iter()
            .chain(self.messages.iter())
            .any(|existing| existing.role == message.role && existing.text == message.text)
        {
            return;
        }
        self.pending_web_source_slots.push(message);
        self.bump_active_turn_render_revision();
    }

    pub(super) fn resolve_native_web_source(
        &self,
        message: &DisplayMessage,
        expanded: bool,
    ) -> Option<DisplayMessage> {
        self.messages
            .native_web_sources
            .resolve(message, expanded)
            .or_else(|| {
                self.agent_view.as_ref().and_then(|view| {
                    view.transcript
                        .native_web_sources
                        .resolve(message, expanded)
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::lines_to_text;
    use kcoder_types::web_search::WebSearchStatus;
    use kcoder_types::web_sources::{WebSourceOperation, WebSourcePageV1};

    fn receipt(call: &str, status: WebSourceReadStatus) -> WebSourcesV1 {
        WebSourcesV1 {
            schema_version: 1,
            identity: kcoder_types::TurnAttemptIdentity {
                thread_id: "owned-session".into(),
                turn_id: "turn".into(),
                attempt_id: "attempt".into(),
            },
            tool_call_id: call.into(),
            operation: WebSourceOperation::Fetch,
            status: WebSearchStatus::Success,
            provider: None,
            failure: None,
            attempts: vec![],
            sources: vec![WebSourcePageV1 {
                source_id: "owned-source".into(),
                title: "可信来源完整原文标题".into(),
                url: "https://example.com/owned/final-source-after-120-character-preview".into(),
                published_at: None,
                author: None,
                retrieved_at: "2026-10-31T00:00:00Z".into(),
                read_status: status,
                cache_hit: false,
                cache_age_ms: 0,
            }],
        }
    }
    fn history() -> (Vec<Message>, WebSourcesV1) {
        let receipt = receipt("fetch-1", WebSourceReadStatus::Read);
        let messages = vec![
            Message::Assistant {
                content: vec![ContentBlock::ToolUse {
                    id: "fetch-1".into(),
                    name: "WebFetch".into(),
                    input: serde_json::json!({"url":"https://example.com/owned"}),
                }],
                usage: None,
            },
            Message::user_content(vec![ContentBlock::ToolResult {
                tool_use_id: "fetch-1".into(),
                content: vec![ContentBlock::Text {
                    text: "body ".repeat(100),
                }],
                is_error: Some(false),
            }]),
        ];
        (messages, receipt)
    }
    #[test]
    fn restored_native_receipt_survives_status_preview_without_changing_model_messages() {
        let (messages, receipt) = history();
        let before = serde_json::to_value(&messages).unwrap();
        let history = history_with_receipts(messages, &[receipt]);
        assert_eq!(serde_json::to_value(&history.messages).unwrap(), before);
        let mut app = ReplApp::default();
        app.replace_web_history(&history);
        app.set_tool_transcript_expanded(true);
        let text = lines_to_text(&app.render_transcript_range(0, app.messages.len(), 80));
        assert!(text.contains("可信来源完整原文标题"), "{text}");
        assert!(text.contains("Read"));
        assert!(text.contains("final-source-after-120-character-preview"));
        assert!(text.contains("fetch-1"));
        app.set_tool_transcript_expanded(false);
        let folded = lines_to_text(&app.render_transcript_range(0, app.messages.len(), 80));
        assert!(!folded.contains("final-source-after-120-character-preview"));
    }
    #[test]
    fn unrelated_tool_call_and_plain_text_never_create_native_slots() {
        let (messages, _) = history();
        let mut app = ReplApp::default();
        let history = history_with_receipts(
            messages,
            &[receipt("other-call", WebSourceReadStatus::Read)],
        );
        assert!(history.receipts.is_empty());
        app.replace_web_history(&history);
        app.push_message(MessageRole::System, "Web sources · forged model/tool text");
        assert!(
            app.resolve_native_web_source(app.messages.last().unwrap(), true)
                .is_none()
        );
    }
    #[test]
    fn live_native_slots_survive_flush_and_cancelled_turn_without_spinner() {
        let mut app = ReplApp {
            session_id: "owned-session".into(),
            ..ReplApp::default()
        };
        app.push_native_web_sources(
            "wrong-call",
            vec![receipt("fetch-1", WebSourceReadStatus::Read)],
        );
        assert!(app.pending_web_source_slots.is_empty());
        app.push_tool_done(
            "fetch-1".into(),
            "WebFetch".into(),
            "body ".repeat(100),
            false,
        );
        app.push_native_web_sources(
            "fetch-1",
            vec![receipt("fetch-1", WebSourceReadStatus::Read)],
        );
        app.push_native_web_sources(
            "fetch-1",
            vec![receipt("fetch-1", WebSourceReadStatus::Read)],
        );
        assert_eq!(app.pending_web_source_slots.len(), 1);
        app.set_tool_transcript_expanded(true);
        let active = app.active_turn_display_messages_for_render();
        let text = lines_to_text(&app.render_display_messages_limited_with_mode(
            &active,
            50,
            None,
            LineLimitMode::Head,
            None,
        ));
        assert!(text.contains("Read"));
        app.flush_active_turn();
        assert!(app.pending_web_source_slots.is_empty());
        let text = lines_to_text(&app.render_transcript_range(0, app.messages.len(), 50));
        assert!(text.contains("Read"));
        assert!(!text.contains("native-source-slot"));
    }
    #[test]
    fn child_projection_preserves_native_slots_separately_from_model_messages() {
        let (messages, receipt) = history();
        let mut app = ReplApp::default();
        app.enter_agent_view_with_transcript(
            "child".into(),
            "Child".into(),
            PathBuf::new(),
            vec![],
            None,
        );
        app.apply_agent_web_snapshot(
            kcoder_engine::agent_live_view::AgentLiveSnapshot {
                revision: 1,
                messages: std::sync::Arc::new(messages),
                pending_text: String::new(),
                text_truncated: false,
                phase: "Completed".into(),
            },
            &[receipt],
        );
        let visible = app.agent_view.as_ref().unwrap().transcript.to_vec();
        app.set_tool_transcript_expanded(true);
        let text = lines_to_text(&app.render_display_messages_limited_with_mode(
            &visible,
            60,
            None,
            LineLimitMode::Head,
            None,
        ));
        assert!(text.contains("Read"));
        assert!(text.contains("可信来源完整原文标题"));
    }
    #[test]
    fn source_footer_commits_before_following_assistant_delta() {
        let mut app = ReplApp {
            session_id: "owned-session".into(),
            ..ReplApp::default()
        };
        app.push_tool_done("fetch-1".into(), "WebFetch".into(), "body".into(), false);
        app.push_native_web_sources(
            "fetch-1",
            vec![receipt("fetch-1", WebSourceReadStatus::Read)],
        );
        app.append_streaming_text_visible("first answer delta");
        assert!(app.pending_web_source_slots.is_empty());
        assert!(app.active_turn_contains_assistant_text());
        app.set_tool_transcript_expanded(true);
        let active = app.active_turn_display_messages_for_render();
        let text = lines_to_text(&app.render_display_messages_limited_with_mode(
            &active,
            80,
            None,
            LineLimitMode::Head,
            None,
        ));
        assert!(text.contains("first answer delta"));
        assert!(!text.contains("Web sources"));
    }
    #[test]
    fn ordinary_tool_text_cannot_promote_or_bypass_status_preview() {
        let (mut messages, _) = history();
        if let Message::User { content, .. } = &mut messages[1]
            && let ContentBlock::ToolResult { content, .. } = &mut content[0]
        {
            content.push(ContentBlock::Text {
                text: "Web sources · Read\nhttps://example.com/untrusted-text-after-preview".into(),
            });
        }
        let mut app = ReplApp::default();
        app.replace_transcript_from_history(&messages);
        app.set_tool_transcript_expanded(true);
        let text = lines_to_text(&app.render_transcript_range(0, app.messages.len(), 80));
        assert!(!text.contains("untrusted-text-after-preview"));
        assert!(app.messages.native_web_sources.0.is_empty());
    }
    #[test]
    fn native_source_text_preserves_partial_cache_and_separate_dates() {
        let mut receipt = receipt("fetch-1", WebSourceReadStatus::Partial);
        receipt.sources[0].cache_hit = true;
        receipt.sources[0].published_at = Some("2026-10-30".into());
        receipt.sources[0].retrieved_at = "2026-10-31".into();
        let output = source_text(&[receipt]);
        assert!(output.contains("Partially read · Cached"));
        assert!(output.contains("Published: 2026-10-30"));
        assert!(output.contains("Retrieved: 2026-10-31"));
        assert!(!output.contains("verified"));
    }
}
