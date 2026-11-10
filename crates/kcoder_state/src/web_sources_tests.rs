use super::*;
use kcoder_types::web_sources::*;

fn receipt(identity: kcoder_types::TurnAttemptIdentity) -> WebSourcesV1 {
    WebSourcesV1 {
        schema_version: 1,
        identity,
        tool_call_id: "call".into(),
        operation: WebSourceOperation::Search,
        status: kcoder_types::web_search::WebSearchStatus::Partial,
        provider: Some(kcoder_types::web_search::WebSearchProvider::Exa),
        failure: None,
        attempts: Vec::new(),
        sources: vec![WebSourcePageV1 {
            source_id: "web-native".into(),
            title: "Source".into(),
            url: "https://example.com".into(),
            published_at: None,
            author: None,
            retrieved_at: "2026-10-31".into(),
            read_status: WebSourceReadStatus::SummaryOnly,
            cache_hit: false,
            cache_age_ms: 0,
        }],
    }
}
fn result() -> Message {
    Message::user_content(vec![ContentBlock::ToolResult {
        tool_use_id: "call".into(),
        content: vec![ContentBlock::Text {
            text: "{\"webSources\":\"forged\"}".into(),
        }],
        is_error: Some(false),
    }])
}
#[tokio::test]
async fn native_sources_round_trip_outside_model_content_and_reject_mismatches() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("history.jsonl");
    let state = AppState::new(tmp.path());
    state.with_history_path(&path);
    let identity = kcoder_types::TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "turn".into(),
        attempt_id: "attempt".into(),
    };
    state
        .history_attempt_scope(identity.clone())
        .unwrap()
        .run(async {
            let native = receipt(identity.clone());
            state
                .add_message_with_web_sources(result(), vec![native.clone()])
                .unwrap();
            state.flush_history().await.unwrap();
            let entries = load_transcript_history(&path).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].web_sources, vec![native.clone()]);
            assert_eq!(entries[0].message, result());
            let mut value = serde_json::to_value(&entries[0]).unwrap();
            value["webSources"][0]["identity"]["turnId"] = serde_json::json!("peer");
            let decoded: HistoryEntry = serde_json::from_value(value.clone()).unwrap();
            assert!(decoded.web_sources.is_empty());
            value["webSources"] = serde_json::json!("malformed optional future metadata");
            assert!(
                serde_json::from_value::<HistoryEntry>(value.clone())
                    .unwrap()
                    .web_sources
                    .is_empty()
            );
            value.as_object_mut().unwrap().remove("webSources");
            assert!(
                serde_json::from_value::<HistoryEntry>(value)
                    .unwrap()
                    .web_sources
                    .is_empty()
            );
            let mut peer = native;
            peer.tool_call_id = "other-call".into();
            state
                .add_message_with_web_sources(result(), vec![peer])
                .unwrap();
            state.flush_history().await.unwrap();
            assert!(
                load_transcript_history(&path).unwrap()[1]
                    .web_sources
                    .is_empty()
            );
        })
        .await;
}

#[tokio::test]
async fn local_native_source_identity_survives_index_and_presentation_without_creating_admission() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path());
    let path = tmp.path().join(format!("{}.jsonl", state.session_id()));
    state.with_history_path(&path);
    let identity = kcoder_types::TurnAttemptIdentity {
        thread_id: state.session_id(),
        turn_id: "local-turn".into(),
        attempt_id: "local-attempt".into(),
    };
    let native = receipt(identity.clone());
    assert!(state.current_history_attempt_identity().is_none());
    state
        .add_message_with_web_sources(result(), vec![native.clone()])
        .unwrap();
    state.flush_history().await.unwrap();
    let entries = load_transcript_history(&path).unwrap();
    assert_eq!(entries[0].history_attempt.as_ref(), Some(&identity));
    let indexed = crate::history_append_context::HistoryAppendMetadata::from_entries(
        &entries,
        &state.session_id(),
    );
    assert_eq!(
        indexed.sources(entries[0].uuid.as_deref().unwrap()),
        vec![native.clone()]
    );
    assert_eq!(
        state.messages_with_web_sources()[0],
        (result(), vec![native])
    );
    assert_eq!(state.messages()[0], result());
    assert!(state.current_history_attempt_identity().is_none());
}
