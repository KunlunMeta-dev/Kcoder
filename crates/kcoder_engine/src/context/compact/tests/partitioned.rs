use super::*;

struct PartitionRecordingProvider {
    requests: Arc<Mutex<Vec<MessagesRequest>>>,
    always_overflow: bool,
    fail_on_request: Option<usize>,
}

impl Provider for PartitionRecordingProvider {
    fn name(&self) -> &'static str {
        "partition-recording"
    }

    fn stream_messages(
        &self,
        request: MessagesRequest,
    ) -> std::result::Result<kcoder_api::ProviderStream, kcoder_api::ApiErrorKind> {
        let prompt = request.messages[0].preview(usize::MAX);
        self.requests.lock().unwrap().push(request);
        if self.fail_on_request == Some(self.requests.lock().unwrap().len()) {
            return Err(kcoder_api::ApiErrorKind::SseStream {
                error_type: "sse_stream_error".into(),
                message: "fixture transport interruption".into(),
                kind: kcoder_api::SseErrorKind::Transport(kcoder_api::NonHttpErrorClass::Transient),
            });
        }
        if self.always_overflow || !prompt.contains("Historical conversation fragment.") {
            return Err(kcoder_api::ApiErrorKind::Api {
                error_type: "context_length_exceeded".into(),
                message: "summary input exceeds context".into(),
            });
        }
        let mut facts = (0..12)
            .map(|index| format!("FACT_{index:02}"))
            .filter(|fact| prompt.contains(fact))
            .collect::<Vec<_>>()
            .join(" ");
        if prompt.contains("PRIOR_BOUNDARY_FACT") {
            facts.push_str(" PRIOR_BOUNDARY_FACT");
        }
        Ok(Box::pin(futures::stream::iter(
            complete_text_events(format!("<summary>Historical facts {facts}</summary>"))
                .into_iter()
                .map(Ok),
        )))
    }
}

#[tokio::test]
async fn partitioned_compaction_covers_every_old_fact_and_preserves_recent_input() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(PartitionRecordingProvider {
        requests: requests.clone(),
        always_overflow: false,
        fail_on_request: None,
    }));
    let mut messages = Vec::new();
    messages.push(Message::compaction_text(format_compact_summary_message(
        "PRIOR_BOUNDARY_FACT must survive all recovery levels",
    )));
    for index in 0..12 {
        messages.push(Message::user_text(format!(
            "FACT_{index:02} {}",
            "历史依据与约束。".repeat(40)
        )));
        messages.push(Message::assistant_text("recorded result"));
    }
    messages.extend([
        Message::user_text("recent request one"),
        Message::assistant_text("recent response one"),
        Message::user_text("current request stays exact"),
        Message::assistant_text("current response stays exact"),
    ]);
    let result = compactor
        .compact(test_compaction_request(messages), 50_000)
        .await
        .unwrap();
    for index in 0..12 {
        assert!(result.summary.contains(&format!("FACT_{index:02}")));
    }
    assert!(result.summary.contains("PRIOR_BOUNDARY_FACT"));
    assert_eq!(
        result.messages.last().unwrap().preview(200),
        "current response stays exact"
    );
    assert!(
        result
            .messages
            .iter()
            .any(|message| message.preview(200) == "current request stays exact")
    );
    assert_eq!(requests.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn unrecoverable_partition_never_returns_a_partial_summary() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(PartitionRecordingProvider {
        requests: requests.clone(),
        always_overflow: true,
        fail_on_request: None,
    }));
    let source = (0..12)
        .flat_map(|index| {
            [
                Message::user_text(format!("FACT_{index:02}")),
                Message::assistant_text("result"),
            ]
        })
        .collect();
    let error = compactor
        .compact(test_compaction_request(source), 50_000)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("original context retained"));
    assert!(requests.lock().unwrap().len() <= 1 + super::super::partitioned::MAX_RECOVERY_CALLS);
}

#[tokio::test]
async fn partitioned_retry_reuses_completed_fragments_with_one_shared_budget() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let compactor = test_compactor(Arc::new(PartitionRecordingProvider {
        requests: requests.clone(),
        always_overflow: false,
        fail_on_request: Some(3),
    }));
    let source = (0..12)
        .flat_map(|index| {
            [
                Message::user_text(format!("FACT_{index:02} {}", "original detail ".repeat(30))),
                Message::assistant_text("result"),
            ]
        })
        .collect();
    let result = compactor
        .compact(test_compaction_request(source), 50_000)
        .await
        .unwrap();
    assert_eq!(result.provider_retries.len(), 1);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[2].messages, requests[3].messages);
    assert_ne!(requests[1].messages, requests[3].messages);
}
