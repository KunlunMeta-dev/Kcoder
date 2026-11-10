use super::*;
use kcoder_types::async_user_questions::*;
use std::collections::BTreeMap;

#[test]
fn stale_claim_cannot_append_an_answer_to_history() {
    crate::test_support::owned_case::run_owned_case(
        concat!(module_path!(), "::async_answer_owned_dispatcher"),
        "stale_claim",
    );
}

#[test]
fn modified_claim_cannot_append_an_answer_to_history() {
    crate::test_support::owned_case::run_owned_case(
        concat!(module_path!(), "::async_answer_owned_dispatcher"),
        "modified_claim",
    );
}

#[test]
fn current_claim_appends_the_original_answer_once() {
    crate::test_support::owned_case::run_owned_case(
        concat!(module_path!(), "::async_answer_owned_dispatcher"),
        "current_claim",
    );
}

#[test]
#[ignore = "private dispatcher launched by the owned parent test"]
fn async_answer_owned_dispatcher() {
    let case = crate::test_support::owned_case::owned_case();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = crate::test_support::owned_case::owned_tempdir();
            let engine = crate::test_support::engine_builder::TestEngineBuilder::new(root.path())
                .owned_test_fixture()
                .build_with_profile_directory();
            let history = root.path().join("history.jsonl");
            engine.state.with_history_path(&history);
            let owner = engine.state.inspection_lifecycle_identity();
            let record = engine
                .state
                .register_async_question(
                    &owner,
                    AsyncQuestionRequest {
                        source_turn_id: "source-turn".into(),
                        tool_call_id: "question-tool".into(),
                        questions: vec![AsyncQuestionItemDraft {
                            header: "Format".into(),
                            question: "Which format?".into(),
                            options: vec![
                                AsyncQuestionOptionDraft {
                                    label: "JSON".into(),
                                    description: "Structured".into(),
                                },
                                AsyncQuestionOptionDraft {
                                    label: "Text".into(),
                                    description: "Readable".into(),
                                },
                            ],
                            multi_select: false,
                        }],
                    },
                )
                .unwrap()
                .question;
            engine
                .state
                .answer_async_question(
                    &owner,
                    &record.question_id,
                    record.revision,
                    "submission",
                    BTreeMap::from([(
                        record.questions[0].id.clone(),
                        AsyncQuestionAnswerValue {
                            selected_option_ids: vec![record.questions[0].options[0].id.clone()],
                            text: None,
                        },
                    )]),
                )
                .unwrap();
            let mut claim = engine
                .state
                .claim_async_question_delivery(&owner, &record.question_id, "claim")
                .unwrap()
                .unwrap();
            if case == "current_claim" {
                assert!(
                    commit_async_question_answer(&engine, &owner, &claim)
                        .await
                        .is_ok()
                );
                assert!(
                    commit_async_question_answer(&engine, &owner, &claim)
                        .await
                        .is_ok()
                );
                assert_eq!(engine.state.messages(), vec![claim.message.clone()]);
                assert_eq!(kcoder_state::load_history(&history).unwrap().len(), 1);
                assert_eq!(
                    engine.state.list_async_questions(&owner, true).unwrap()[0].status,
                    AsyncQuestionStatus::ContextApplied
                );
                return;
            }
            if case == "stale_claim" {
                engine
                    .state
                    .mark_async_questions_stale_for_task(&owner)
                    .unwrap();
            } else {
                assert_eq!(case, "modified_claim");
                claim.message = Message::user_text("an answer belonging to another question");
            }
            assert!(
                commit_async_question_answer(&engine, &owner, &claim)
                    .await
                    .is_err()
            );
            assert!(
                engine.state.messages().is_empty(),
                "an invalid claim must be rejected before appending input"
            );
            if history.exists() {
                assert!(kcoder_state::load_history(&history).unwrap().is_empty());
            }
            if case == "stale_claim" {
                assert_eq!(
                    engine.state.list_async_questions(&owner, true).unwrap()[0].status,
                    AsyncQuestionStatus::Stale
                );
            }
        });
}
