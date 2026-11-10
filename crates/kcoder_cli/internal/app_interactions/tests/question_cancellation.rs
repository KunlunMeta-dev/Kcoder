use kcoder_app_interactions::{
    AppServerQuestioner, InteractionReceipts, InteractionReply, PendingApprovalResponses,
    QuestionContext, interaction_requests::resolve_server_response,
};
use kcoder_tools::{Question, QuestionOption, UserQuestionRequest, UserQuestioner};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, atomic::AtomicU64},
    time::Duration,
};
use tokio::sync::mpsc;

fn fixture() -> (AppServerQuestioner, mpsc::Receiver<Value>) {
    let (outbound_tx, outbound_rx) = mpsc::channel(8);
    let mut receipts = InteractionReceipts::default();
    receipts.app_server_epoch = "original-epoch".into();
    (
        AppServerQuestioner {
            outbound_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            receipts: Arc::new(Mutex::new(receipts)),
            next_id: Arc::new(AtomicU64::new(42)),
            context: Arc::new(Mutex::new(Some(QuestionContext {
                server_id: "server".into(),
                thread_id: "thread".into(),
                turn_id: "turn".into(),
            }))),
        },
        outbound_rx,
    )
}

fn request() -> UserQuestionRequest {
    UserQuestionRequest {
        questions: vec![Question {
            question: "Which source?".into(),
            header: "Source".into(),
            multi_select: false,
            options: vec![
                QuestionOption {
                    label: "Original".into(),
                    description: "Use the original source".into(),
                    preview: None,
                },
                QuestionOption {
                    label: "Updated".into(),
                    description: "Use the updated source".into(),
                    preview: None,
                },
            ],
        }],
        answers: HashMap::new(),
        annotations: None,
    }
}

#[tokio::test]
async fn dropping_an_ordinary_question_retires_only_its_waiter_and_keeps_its_receipt() {
    let (host, mut outbound) = fixture();
    let first_host = host.clone();
    let first = tokio::spawn(async move { first_host.ask(request()).await });
    let first_prompt = outbound.recv().await.unwrap();
    let second_host = host.clone();
    let second = tokio::spawn(async move { second_host.ask(request()).await });
    let second_prompt = outbound.recv().await.unwrap();
    let first_id = first_prompt["id"].as_u64().unwrap();
    let second_id = second_prompt["id"].as_u64().unwrap();
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    {
        let pending = host.pending.lock().unwrap();
        assert!(
            !pending.contains_key(&first_id),
            "the dropped ordinary question retained its waiter"
        );
        assert!(
            pending.contains_key(&second_id),
            "the peer question must remain answerable"
        );
    }
    let cancelled = outbound.recv().await.unwrap();
    assert_eq!(cancelled["method"], "question/resolved");
    assert_eq!(cancelled["params"]["requestId"], first_id);
    assert_eq!(
        cancelled["params"]["questionId"],
        first_prompt["params"]["questionId"]
    );
    assert_eq!(cancelled["params"]["appServerEpoch"], "original-epoch");
    assert_eq!(cancelled["params"]["reason"], "cancelled");
    assert_eq!(
        host.receipts.lock().unwrap().replay(first_id),
        Some(cancelled)
    );
    let approvals: PendingApprovalResponses = Arc::new(Mutex::new(HashMap::new()));
    assert!(matches!(
        resolve_server_response(
            &json!({"id":first_id,"result":{"answers":{"question-1":{"answers":["late"]}}}}),
            &approvals,
            &host.pending,
            &host.receipts,
            false,
        ),
        InteractionReply::Unmatched
    ));
    assert!(matches!(
        resolve_server_response(
            &json!({"id":second_id,"result":{"answers":{"question-1":{"answers":["Original"]}}}}),
            &approvals,
            &host.pending,
            &host.receipts,
            false,
        ),
        InteractionReply::Delivered
    ));
    assert_eq!(
        second.await.unwrap().unwrap().answers["Which source?"],
        "Original"
    );
    let resolved = outbound.recv().await.unwrap();
    assert_eq!(resolved["params"]["requestId"], second_id);
    assert_eq!(resolved["params"]["reason"], "client_response");
    assert!(host.pending.lock().unwrap().is_empty());
    assert!(
        outbound.try_recv().is_err(),
        "normal completion must not emit another cancellation"
    );
}

#[tokio::test]
async fn an_ordinary_question_tool_timeout_retires_its_waiter() {
    let (host, mut outbound) = fixture();
    assert!(
        tokio::time::timeout(Duration::from_millis(50), host.ask(request()))
            .await
            .is_err()
    );
    let prompt = outbound.recv().await.unwrap();
    assert!(
        host.pending.lock().unwrap().is_empty(),
        "a tool timeout left a dead question pending in the running task"
    );
    let resolved = outbound.recv().await.unwrap();
    assert_eq!(resolved["params"]["requestId"], prompt["id"]);
    assert_eq!(resolved["params"]["reason"], "cancelled");
}

#[tokio::test]
async fn dropping_a_question_after_reply_handoff_still_records_its_terminal_receipt() {
    let (host, mut outbound) = fixture();
    let mut question = Box::pin(host.ask(request()));
    let prompt = tokio::select! {
        result = &mut question => panic!("question completed without an answer: {result:?}"),
        frame = outbound.recv() => frame.unwrap(),
    };
    let request_id = prompt["id"].as_u64().unwrap();
    let approvals: PendingApprovalResponses = Arc::new(Mutex::new(HashMap::new()));
    assert!(matches!(
        resolve_server_response(
            &json!({"id":request_id,"result":{"answers":{"question-1":{"answers":["Original"]}}}}),
            &approvals,
            &host.pending,
            &host.receipts,
            false,
        ),
        InteractionReply::Delivered
    ));
    assert!(host.pending.lock().unwrap().is_empty());
    // The sender has handed off the reply, but the tool has not consumed it.
    drop(question);
    let resolved = host.receipts.lock().unwrap().replay(request_id);
    assert!(
        resolved.is_some(),
        "cancellation between reply handoff and consumption lost the terminal receipt"
    );
    let resolved = resolved.unwrap();
    assert_eq!(resolved["params"]["reason"], "cancelled");
    assert_eq!(outbound.recv().await.unwrap(), resolved);
}
