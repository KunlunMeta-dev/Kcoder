use super::*;
use crate::{UserInputCommit, UserInputStart};
use tempfile::TempDir;

struct Fixture {
    _root: TempDir,
    state: AppState,
    owner: AppStateLifecycleIdentity,
}

fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let session_dir = root.path().join("session");
    let _directory = PrivateDirectory::open_or_create(&session_dir).unwrap();
    let state = AppState::new(root.path());
    {
        let mut inner = state.write_inner();
        inner.session_id = "async-question-session".into();
        inner.session_state_path = Some(session_dir.join("state.json"));
    }
    let owner = state.inspection_lifecycle_identity();
    Fixture {
        _root: root,
        state,
        owner,
    }
}

fn request(tool_call_id: &str) -> AsyncQuestionRequest {
    AsyncQuestionRequest {
        source_turn_id: "turn-source-1".into(),
        tool_call_id: tool_call_id.into(),
        questions: vec![AsyncQuestionItemDraft {
            header: "Format".into(),
            question: "Which output format should I use?".into(),
            options: vec![
                AsyncQuestionOptionDraft {
                    label: "JSON".into(),
                    description: "Machine-readable".into(),
                },
                AsyncQuestionOptionDraft {
                    label: "Markdown".into(),
                    description: "Readable text".into(),
                },
            ],
            multi_select: false,
        }],
    }
}

fn large_request(tool_call_id: &str) -> AsyncQuestionRequest {
    AsyncQuestionRequest {
        source_turn_id: "turn-large-budget".into(),
        tool_call_id: tool_call_id.into(),
        questions: vec![AsyncQuestionItemDraft {
            header: "Large question".into(),
            question: "q".repeat(15_000),
            options: (0..ASYNC_QUESTION_MAX_OPTIONS)
                .map(|index| AsyncQuestionOptionDraft {
                    label: format!("Choice {index}"),
                    description: "d".repeat(2_000),
                })
                .collect(),
            multi_select: false,
        }],
    }
}

fn answer(
    record: &AsyncQuestionRecord,
    option_index: usize,
) -> BTreeMap<String, AsyncQuestionAnswerValue> {
    let item = &record.questions[0];
    BTreeMap::from([(
        item.id.clone(),
        AsyncQuestionAnswerValue {
            selected_option_ids: vec![item.options[option_index].id.clone()],
            text: None,
        },
    )])
}

fn restore_like(fixture: &Fixture) -> (AppState, AppStateLifecycleIdentity) {
    let state = AppState::new(fixture._root.path());
    {
        let mut inner = state.write_inner();
        inner.session_id = fixture.state.session_id();
        inner.session_state_path = fixture.state.session_state_path();
    }
    let owner = state.inspection_lifecycle_identity();
    (state, owner)
}

#[test]
fn registration_is_durable_idempotent_by_tool_identity_and_rejects_content_reuse() {
    let fixture = fixture();
    let first = fixture
        .state
        .register_async_question(&fixture.owner, request("tool-call-1"))
        .unwrap();
    let (restored, restored_owner) = restore_like(&fixture);
    let repeated = restored
        .register_async_question(&restored_owner, request("tool-call-1"))
        .unwrap();
    assert!(first.accepted && repeated.accepted);
    assert_eq!(first.question.question_id, repeated.question.question_id);
    assert_eq!(
        first.question.questions[0].id,
        repeated.question.questions[0].id
    );
    assert_eq!(
        first.question.questions[0].options[0].id,
        repeated.question.questions[0].options[0].id
    );

    let mut changed = request("tool-call-1");
    changed.questions[0].question = "Changed content under the same tool identity".into();
    assert!(
        fixture
            .state
            .register_async_question(&fixture.owner, changed)
            .is_err()
    );

    let records = fixture
        .state
        .list_async_questions(&fixture.owner, false)
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].question_id, first.question.question_id);
}

#[test]
fn total_ledger_budget_rejects_overflow_without_replacing_prior_records() {
    let fixture = fixture();
    let mut accepted_count = 0;
    let mut rejected = false;
    for index in 0..ASYNC_QUESTION_MAX_RECORDS {
        match fixture.state.register_async_question(
            &fixture.owner,
            large_request(&format!("large-tool-{index}")),
        ) {
            Ok(_) => accepted_count += 1,
            Err(_) => {
                rejected = true;
                break;
            }
        }
    }
    assert!(
        rejected,
        "large requests must eventually exhaust the ledger budget"
    );
    assert!(accepted_count > 1);
    let records = fixture
        .state
        .list_async_questions(&fixture.owner, true)
        .unwrap();
    assert_eq!(records.len(), accepted_count);
    assert!(records.len() < ASYNC_QUESTION_MAX_RECORDS);
}

#[tokio::test]
async fn accepted_answer_reserves_capacity_through_unknown_and_applied_receipts() {
    let fixture = fixture();
    let history_path = fixture
        ._root
        .path()
        .join("session")
        .join("async-question-session.jsonl");
    fixture.state.with_history_path(&history_path);
    let owner = fixture.state.inspection_lifecycle_identity();
    let record = fixture
        .state
        .register_async_question(&owner, request("tool-call-reserved-delivery"))
        .unwrap()
        .question;
    fixture
        .state
        .answer_async_question(
            &owner,
            &record.question_id,
            record.revision,
            "submission-reserved-delivery",
            answer(&record, 0),
        )
        .unwrap();

    let mut filled_records = 0;
    let mut hit_budget = false;
    for index in 0..ASYNC_QUESTION_MAX_RECORDS {
        match fixture
            .state
            .register_async_question(&owner, large_request(&format!("fill-ledger-{index}")))
        {
            Ok(_) => filled_records += 1,
            Err(_) => {
                hit_budget = true;
                break;
            }
        }
    }
    assert!(
        hit_budget,
        "the bounded session ledger should reach its budget"
    );
    assert!(filled_records > 0);

    let claim_id = "\0".repeat(256);
    let claim = fixture
        .state
        .claim_async_question_delivery(&owner, &record.question_id, &claim_id)
        .unwrap()
        .unwrap();
    let pending = match fixture.state.try_begin_user_input_identified(
        &owner,
        claim.message.clone(),
        &claim.message_id,
    ) {
        UserInputStart::Accepted(pending) => pending,
        UserInputStart::Unknown {
            pending: Some(pending),
            ..
        } => pending,
        UserInputStart::Busy(_) => panic!("history state should be available"),
        UserInputStart::Rejected { error, .. } | UserInputStart::Unknown { error, .. } => {
            panic!("identified input was not admitted: {error}")
        }
    };
    let committed = pending.wait_with_witness().await.unwrap();
    assert_eq!(committed.outcome(), UserInputCommit::Durable);

    let maximum_escaped_error = "\0".repeat(MAX_DELIVERY_ERROR_BYTES);
    let unknown = fixture
        .state
        .mark_async_question_delivery_unknown(&owner, &claim, &maximum_escaped_error)
        .unwrap();
    assert_eq!(unknown.status, AsyncQuestionStatus::DeliveryUnknown);

    let applied = fixture
        .state
        .reconcile_async_question_context_applied(
            &owner,
            &claim.question_id,
            &claim.submission_id,
            &committed,
        )
        .unwrap();
    assert_eq!(applied.status, AsyncQuestionStatus::ContextApplied);
    let entries = crate::load_history(&history_path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(claim.message_id.as_str()));
}

#[test]
fn first_valid_answer_wins_and_submission_replay_returns_authoritative_receipt() {
    let fixture = fixture();
    let accepted = fixture
        .state
        .register_async_question(&fixture.owner, request("tool-call-1"))
        .unwrap();
    let record = accepted.question;
    let first_answer = answer(&record, 0);

    let first = fixture
        .state
        .answer_async_question(
            &fixture.owner,
            &record.question_id,
            record.revision,
            "submission-first",
            first_answer.clone(),
        )
        .unwrap();
    assert!(first.accepted);
    assert!(!first.duplicate);
    assert_eq!(first.question.status, AsyncQuestionStatus::Queued);

    let competing = fixture
        .state
        .answer_async_question(
            &fixture.owner,
            &record.question_id,
            record.revision,
            "submission-second",
            answer(&record, 1),
        )
        .unwrap();
    assert!(!competing.accepted);
    assert!(!competing.duplicate);
    assert_eq!(
        competing.question.answer.as_ref().unwrap().submission_id,
        "submission-first"
    );

    let replay = fixture
        .state
        .answer_async_question(
            &fixture.owner,
            &record.question_id,
            record.revision,
            "submission-first",
            first_answer,
        )
        .unwrap();
    assert!(replay.accepted);
    assert!(replay.duplicate);
    assert_eq!(replay.question.revision, first.question.revision);
}

#[test]
fn simultaneous_answer_submissions_have_one_durable_winner() {
    let fixture = fixture();
    let record = fixture
        .state
        .register_async_question(&fixture.owner, request("tool-call-1"))
        .unwrap()
        .question;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let (first_state, first_owner) = restore_like(&fixture);
    let first_barrier = std::sync::Arc::clone(&barrier);
    let first_record = record.clone();
    let first = std::thread::spawn(move || {
        first_barrier.wait();
        let answers = answer(&first_record, 0);
        for _ in 0..1_000 {
            match first_state.answer_async_question(
                &first_owner,
                &first_record.question_id,
                first_record.revision,
                "submission-a",
                answers.clone(),
            ) {
                Ok(receipt) => return receipt,
                Err(error) if error.to_string().contains("ledger is busy") => {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(error) => panic!("answer submission failed: {error:#}"),
            }
        }
        panic!("answer submission remained busy after bounded retries")
    });
    let (second_state, second_owner) = restore_like(&fixture);
    let second_barrier = std::sync::Arc::clone(&barrier);
    let second_record = record.clone();
    let second = std::thread::spawn(move || {
        second_barrier.wait();
        let answers = answer(&second_record, 1);
        for _ in 0..1_000 {
            match second_state.answer_async_question(
                &second_owner,
                &second_record.question_id,
                second_record.revision,
                "submission-b",
                answers.clone(),
            ) {
                Ok(receipt) => return receipt,
                Err(error) if error.to_string().contains("ledger is busy") => {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(error) => panic!("answer submission failed: {error:#}"),
            }
        }
        panic!("answer submission remained busy after bounded retries")
    });
    barrier.wait();
    let first = first.join().unwrap();
    let second = second.join().unwrap();
    assert_ne!(first.accepted, second.accepted);
    assert!(!first.duplicate && !second.duplicate);
    let authoritative = fixture
        .state
        .list_async_questions(&fixture.owner, false)
        .unwrap()
        .pop()
        .unwrap();
    let winning_submission = authoritative.answer.unwrap().submission_id;
    assert!(winning_submission == "submission-a" || winning_submission == "submission-b");
}

#[test]
fn restart_restores_answer_and_claim_is_never_reissued_after_recovery() {
    let fixture = fixture();
    let record = fixture
        .state
        .register_async_question(&fixture.owner, request("tool-call-1"))
        .unwrap()
        .question;
    fixture
        .state
        .answer_async_question(
            &fixture.owner,
            &record.question_id,
            record.revision,
            "submission-1",
            answer(&record, 0),
        )
        .unwrap();

    let (restored, restored_owner) = restore_like(&fixture);
    let restored_record = restored
        .list_async_questions(&restored_owner, true)
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(restored_record.status, AsyncQuestionStatus::Queued);
    assert_eq!(
        restored_record.answer.as_ref().unwrap().submission_id,
        "submission-1"
    );

    let claim = restored
        .claim_async_question_delivery(&restored_owner, &record.question_id, "claim-owner-a")
        .unwrap()
        .unwrap();
    assert_eq!(
        claim.message_id,
        stable_uuid(
            "async-question-answer-message-v1",
            &[
                &restored_record.thread_id,
                &record.question_id,
                "submission-1"
            ]
        )
        .unwrap()
    );
    assert!(matches!(&claim.message, Message::User { .. }));
    let repeated_claim = restored
        .claim_async_question_delivery(&restored_owner, &record.question_id, "claim-owner-a")
        .unwrap();
    assert!(repeated_claim.is_none());
    assert!(
        restored
            .claim_async_question_delivery(&restored_owner, &record.question_id, "claim-owner-b")
            .unwrap()
            .is_none()
    );
    let recovered = restored
        .get_async_question_delivery_claim(&restored_owner, &record.question_id)
        .unwrap()
        .unwrap();
    assert_eq!(claim.message_id, recovered.message_id);
    assert_eq!(claim.claim_id, recovered.claim_id);

    restored
        .mark_async_question_delivery_unknown(&restored_owner, &claim, "writer result was lost")
        .unwrap();
    assert!(
        restored
            .claim_async_question_delivery(&restored_owner, &record.question_id, "claim-owner-c")
            .unwrap()
            .is_none()
    );
    let status = restored
        .list_async_questions(&restored_owner, false)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(status.status, AsyncQuestionStatus::DeliveryUnknown);
    assert_eq!(
        status.delivery_error.as_deref(),
        Some("writer result was lost")
    );
    assert!(
        restored
            .cancel_async_question(&restored_owner, &record.question_id, status.revision)
            .is_err(),
        "unknown delivery cannot be reported as withdrawn"
    );
}

#[tokio::test]
async fn unknown_delivery_reconciles_exact_history_receipt_without_reappending() {
    let fixture = fixture();
    let history_path = fixture
        ._root
        .path()
        .join("session")
        .join("async-question-session.jsonl");
    fixture.state.with_history_path(&history_path);
    let owner = fixture.state.inspection_lifecycle_identity();
    let record = fixture
        .state
        .register_async_question(&owner, request("tool-call-history"))
        .unwrap()
        .question;
    fixture
        .state
        .answer_async_question(
            &owner,
            &record.question_id,
            record.revision,
            "submission-history",
            answer(&record, 0),
        )
        .unwrap();
    let claim = fixture
        .state
        .claim_async_question_delivery(&owner, &record.question_id, "claim-history")
        .unwrap()
        .unwrap();
    let pending = match fixture.state.try_begin_user_input_identified(
        &owner,
        claim.message.clone(),
        &claim.message_id,
    ) {
        UserInputStart::Accepted(pending) => pending,
        UserInputStart::Unknown {
            pending: Some(pending),
            ..
        } => pending,
        UserInputStart::Busy(_) => panic!("history state should be available"),
        UserInputStart::Rejected { error, .. } | UserInputStart::Unknown { error, .. } => {
            panic!("identified input was not admitted: {error}")
        }
    };
    let committed = pending.wait_with_witness().await.unwrap();
    assert_eq!(committed.outcome(), UserInputCommit::Durable);
    fixture
        .state
        .mark_async_question_delivery_unknown(&owner, &claim, "writer reply was lost")
        .unwrap();

    let recovered = fixture
        .state
        .find_committed_user_input_identified(&owner, &claim.message_id, &claim.message)
        .await
        .unwrap()
        .unwrap();
    let applied = fixture
        .state
        .reconcile_async_question_context_applied(
            &owner,
            &claim.question_id,
            &claim.submission_id,
            &recovered,
        )
        .unwrap();
    assert_eq!(applied.status, AsyncQuestionStatus::ContextApplied);
    let ledger_path = fixture
        .state
        .session_state_path()
        .unwrap()
        .parent()
        .unwrap()
        .join(LEDGER_FILE);
    let bytes = std::fs::read(&ledger_path).unwrap();
    // Hold the original file open so atomic replacement cannot reuse its identity.
    let held = File::open(&ledger_path).unwrap();
    for _ in 0..4 {
        let duplicate = fixture
            .state
            .reconcile_async_question_context_applied(
                &owner,
                &claim.question_id,
                &claim.submission_id,
                &recovered,
            )
            .unwrap();
        assert_eq!(duplicate.status, AsyncQuestionStatus::ContextApplied);
        assert_eq!(duplicate.revision, applied.revision);
        let repeated = fixture
            .state
            .mark_async_question_context_applied(&owner, &claim, &recovered)
            .unwrap();
        assert_eq!(repeated.revision, applied.revision);
        assert_eq!(std::fs::read(&ledger_path).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(
                held.metadata().unwrap().ino(),
                std::fs::metadata(&ledger_path).unwrap().ino(),
                "rechecking applied delivery must not rewrite/fsync the ledger"
            );
        }
    }
    drop(held);

    // An idempotent receipt is not a cached authorization or integrity verdict.
    std::fs::write(&ledger_path, b"{").unwrap();
    assert!(
        fixture
            .state
            .reconcile_async_question_context_applied(
                &owner,
                &claim.question_id,
                &claim.submission_id,
                &recovered
            )
            .is_err()
    );
    assert!(
        fixture
            .state
            .mark_async_question_context_applied(&owner, &claim, &recovered)
            .is_err()
    );
    assert_eq!(std::fs::read(&ledger_path).unwrap(), b"{");
    std::fs::write(&ledger_path, &bytes).unwrap();
    fixture.state.write_inner().session_id = "another-session".into();
    assert!(
        fixture
            .state
            .reconcile_async_question_context_applied(
                &owner,
                &claim.question_id,
                &claim.submission_id,
                &recovered
            )
            .is_err()
    );
    assert!(
        fixture
            .state
            .mark_async_question_context_applied(&owner, &claim, &recovered)
            .is_err()
    );
    assert_eq!(std::fs::read(&ledger_path).unwrap(), bytes);

    let entries = crate::load_history(&history_path).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].uuid.as_deref(), Some(claim.message_id.as_str()));
    assert_eq!(entries[0].message, claim.message);
}

#[test]
fn invalid_answers_are_rejected_before_the_first_answer_is_saved() {
    let fixture = fixture();
    let record = fixture
        .state
        .register_async_question(&fixture.owner, request("tool-call-1"))
        .unwrap()
        .question;
    let item = &record.questions[0];
    let unknown_option = BTreeMap::from([(
        item.id.clone(),
        AsyncQuestionAnswerValue {
            selected_option_ids: vec!["not-a-real-option".into()],
            text: None,
        },
    )]);
    assert!(
        fixture
            .state
            .answer_async_question(
                &fixture.owner,
                &record.question_id,
                record.revision,
                "submission-invalid",
                unknown_option,
            )
            .is_err()
    );

    let incomplete = BTreeMap::from([(
        "not-a-question-item".into(),
        AsyncQuestionAnswerValue {
            selected_option_ids: Vec::new(),
            text: Some("some text".into()),
        },
    )]);
    assert!(
        fixture
            .state
            .answer_async_question(
                &fixture.owner,
                &record.question_id,
                record.revision,
                "submission-incomplete",
                incomplete,
            )
            .is_err()
    );

    let unchanged = fixture
        .state
        .list_async_questions(&fixture.owner, false)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(unchanged.status, AsyncQuestionStatus::Pending);
    assert!(unchanged.answer.is_none());
}

#[test]
fn stale_or_cancelled_questions_cannot_be_answered_or_claimed() {
    let fixture = fixture();
    let pending = fixture
        .state
        .register_async_question(&fixture.owner, request("tool-call-1"))
        .unwrap()
        .question;
    fixture
        .state
        .mark_async_questions_stale_for_turn(&fixture.owner, &pending.source_turn_id)
        .unwrap();
    assert!(
        fixture
            .state
            .answer_async_question(
                &fixture.owner,
                &pending.question_id,
                pending.revision,
                "late-answer",
                answer(&pending, 0),
            )
            .is_err()
    );
    assert_eq!(
        fixture
            .state
            .list_async_questions(&fixture.owner, true)
            .unwrap()[0]
            .status,
        AsyncQuestionStatus::Stale
    );

    let cancellable = fixture
        .state
        .register_async_question(&fixture.owner, request("tool-call-2"))
        .unwrap()
        .question;
    let cancelled = fixture
        .state
        .cancel_async_question(
            &fixture.owner,
            &cancellable.question_id,
            cancellable.revision,
        )
        .unwrap();
    assert_eq!(cancelled.status, AsyncQuestionStatus::Cancelled);
    assert!(
        fixture
            .state
            .answer_async_question(
                &fixture.owner,
                &cancellable.question_id,
                cancellable.revision,
                "late-answer-2",
                answer(&cancellable, 0),
            )
            .is_err()
    );

    let claimed = fixture
        .state
        .register_async_question(&fixture.owner, request("tool-call-3"))
        .unwrap()
        .question;
    let answered = fixture
        .state
        .answer_async_question(
            &fixture.owner,
            &claimed.question_id,
            claimed.revision,
            "submission-claimed",
            answer(&claimed, 0),
        )
        .unwrap()
        .question;
    fixture
        .state
        .claim_async_question_delivery(&fixture.owner, &claimed.question_id, "claim-in-flight")
        .unwrap()
        .unwrap();
    assert!(
        fixture
            .state
            .cancel_async_question(&fixture.owner, &claimed.question_id, answered.revision)
            .is_err(),
        "a claimed history commit cannot be reported as withdrawn"
    );
    assert_eq!(
        fixture
            .state
            .list_async_questions(&fixture.owner, true)
            .unwrap()
            .into_iter()
            .find(|record| record.question_id == claimed.question_id)
            .unwrap()
            .status,
        AsyncQuestionStatus::Queued
    );
}

#[tokio::test]
async fn task_interrupt_stales_unconsumed_questions_across_source_turns() {
    let fixture = fixture();
    let history_path = fixture
        ._root
        .path()
        .join("session")
        .join("async-question-session.jsonl");
    fixture.state.with_history_path(&history_path);
    let owner = fixture.state.inspection_lifecycle_identity();

    let mut source_a_pending_request = request("tool-call-source-a-pending");
    source_a_pending_request.source_turn_id = "turn-source-a".into();
    let source_a_pending = fixture
        .state
        .register_async_question(&owner, source_a_pending_request)
        .unwrap()
        .question;

    let mut source_a_queued_request = request("tool-call-source-a-queued");
    source_a_queued_request.source_turn_id = "turn-source-a".into();
    let source_a_queued = fixture
        .state
        .register_async_question(&owner, source_a_queued_request)
        .unwrap()
        .question;
    fixture
        .state
        .answer_async_question(
            &owner,
            &source_a_queued.question_id,
            source_a_queued.revision,
            "submission-source-a-queued",
            answer(&source_a_queued, 0),
        )
        .unwrap();

    let mut source_b_pending_request = request("tool-call-source-b-pending");
    source_b_pending_request.source_turn_id = "turn-source-b".into();
    let source_b_pending = fixture
        .state
        .register_async_question(&owner, source_b_pending_request)
        .unwrap()
        .question;

    let mut applied_request = request("tool-call-already-applied");
    applied_request.source_turn_id = "turn-source-completed".into();
    let applied_question = fixture
        .state
        .register_async_question(&owner, applied_request)
        .unwrap()
        .question;
    fixture
        .state
        .answer_async_question(
            &owner,
            &applied_question.question_id,
            applied_question.revision,
            "submission-already-applied",
            answer(&applied_question, 0),
        )
        .unwrap();
    let applied_claim = fixture
        .state
        .claim_async_question_delivery(
            &owner,
            &applied_question.question_id,
            "claim-already-applied",
        )
        .unwrap()
        .unwrap();
    let pending = match fixture.state.try_begin_user_input_identified(
        &owner,
        applied_claim.message.clone(),
        &applied_claim.message_id,
    ) {
        UserInputStart::Accepted(pending) => pending,
        UserInputStart::Unknown {
            pending: Some(pending),
            ..
        } => pending,
        UserInputStart::Busy(_) => panic!("history state should be available"),
        UserInputStart::Rejected { error, .. } | UserInputStart::Unknown { error, .. } => {
            panic!("identified input was not admitted: {error}")
        }
    };
    let committed = pending.wait_with_witness().await.unwrap();
    fixture
        .state
        .mark_async_question_context_applied(&owner, &applied_claim, &committed)
        .unwrap();

    let changed = fixture
        .state
        .mark_async_questions_stale_for_task(&owner)
        .unwrap();
    let changed_ids = changed
        .iter()
        .map(|record| record.question_id.clone())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(changed.len(), 3);
    assert_eq!(
        changed_ids,
        std::collections::BTreeSet::from([
            source_a_pending.question_id.clone(),
            source_a_queued.question_id.clone(),
            source_b_pending.question_id.clone(),
        ])
    );
    assert!(
        changed
            .iter()
            .all(|record| record.status == AsyncQuestionStatus::Stale)
    );
    assert!(
        fixture
            .state
            .answer_async_question(
                &owner,
                &source_a_pending.question_id,
                source_a_pending.revision,
                "late-answer-after-task-interrupt",
                answer(&source_a_pending, 0),
            )
            .is_err()
    );
    assert!(
        fixture
            .state
            .claim_async_question_delivery(
                &owner,
                &source_a_queued.question_id,
                "claim-after-task-interrupt",
            )
            .unwrap()
            .is_none()
    );
    let records = fixture.state.list_async_questions(&owner, true).unwrap();
    assert_eq!(
        records
            .iter()
            .find(|record| record.question_id == applied_question.question_id)
            .unwrap()
            .status,
        AsyncQuestionStatus::ContextApplied
    );
}

#[test]
fn a_busy_cross_process_lock_fails_closed_without_acking_registration() {
    let fixture = fixture();
    let session_dir = fixture
        .state
        .session_state_path()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let directory = PrivateDirectory::open_existing(&session_dir).unwrap();
    let _lock = directory
        .try_exclusive_lock(OsStr::new(LOCK_FILE))
        .unwrap()
        .unwrap();
    assert!(
        fixture
            .state
            .register_async_question(&fixture.owner, request("tool-call-1"))
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn repeating_an_unknown_receipt_preserves_the_durable_ledger() {
    use std::os::unix::fs::MetadataExt;

    let fixture = fixture();
    let record = fixture
        .state
        .register_async_question(&fixture.owner, request("idempotent-unknown"))
        .unwrap()
        .question;
    fixture
        .state
        .answer_async_question(
            &fixture.owner,
            &record.question_id,
            record.revision,
            "submission-idempotent",
            answer(&record, 0),
        )
        .unwrap();
    let claim = fixture
        .state
        .claim_async_question_delivery(&fixture.owner, &record.question_id, "claim-idempotent")
        .unwrap()
        .unwrap();
    let first = fixture
        .state
        .mark_async_question_delivery_unknown(&fixture.owner, &claim, "receipt lost")
        .unwrap();
    let path = fixture._root.path().join("session").join(LEDGER_FILE);
    let before = std::fs::metadata(&path).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    // Keep the original inode live: replacement cannot accidentally reuse it.
    let held = std::fs::File::open(&path).unwrap();
    let duplicate = fixture
        .state
        .mark_async_question_delivery_unknown(&fixture.owner, &claim, "still unknown")
        .unwrap();
    let after = std::fs::metadata(&path).unwrap();
    assert_eq!(duplicate.revision, first.revision);
    assert_eq!(
        before.ino(),
        after.ino(),
        "an unchanged receipt must not rewrite/fsync"
    );
    assert_eq!(before.mtime_nsec(), after.mtime_nsec());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    drop(held);
}
