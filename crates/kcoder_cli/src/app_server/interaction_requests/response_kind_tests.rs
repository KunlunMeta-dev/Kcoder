use super::*;

#[test]
fn question_response_rejects_foreign_approval_identity() {
    check_response_kind(true);
}

#[test]
fn approval_response_rejects_foreign_question_identity() {
    check_response_kind(false);
}

fn check_response_kind(question: bool) {
    let field = if question { "questionId" } else { "approvalId" };
    let other_field = if question { "approvalId" } else { "questionId" };
    for require_binding in [false, true] {
        for foreign in [
            json!("foreign"),
            json!(""),
            json!(" "),
            json!(7),
            json!(false),
            json!({}),
            json!([]),
        ] {
            let pending_approvals = Arc::new(StdMutex::new(HashMap::new()));
            let pending_questions = Arc::new(StdMutex::new(HashMap::new()));
            let (approval_tx, mut approval_rx) = oneshot::channel();
            let (question_tx, mut question_rx) = oneshot::channel();
            if question {
                pending_questions.lock().unwrap().insert(508, question_tx);
            } else {
                pending_approvals.lock().unwrap().insert(508, approval_tx);
            }
            let receipts = Arc::new(StdMutex::new(InteractionReceipts::default()));
            receipts.lock().unwrap().track_request(
                508,
                InteractionBinding {
                    interaction_id: "original".into(),
                    server_id: "server".into(),
                    thread_id: "thread".into(),
                    turn_id: "turn".into(),
                    kind: if question {
                        kcoder_app_protocol::InteractionStatusKindV1::Question
                    } else {
                        kcoder_app_protocol::InteractionStatusKindV1::Approval
                    },
                },
                json!({"params":{"questions":[{"id":"item"}]}}),
            );
            let mut result = if question {
                json!({"answers":{"item":{"answers":["original answer"]}}})
            } else {
                json!({"decision":"accept"})
            };
            result[field] = json!("original");
            result["threadId"] = json!("thread");
            result["turnId"] = json!("turn");
            result[other_field] = foreign;
            assert!(
                matches!(
                    resolve_server_response(
                        &json!({"id":508,"result":result}),
                        &pending_approvals,
                        &pending_questions,
                        &receipts,
                        require_binding,
                    ),
                    InteractionReply::Misattributed
                ),
                "foreign interaction kind consumed the original waiter: {result}"
            );
            if question {
                assert!(pending_questions.lock().unwrap().contains_key(&508));
                assert!(matches!(
                    question_rx.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ));
            } else {
                assert!(pending_approvals.lock().unwrap().contains_key(&508));
                assert!(matches!(
                    approval_rx.try_recv(),
                    Err(oneshot::error::TryRecvError::Empty)
                ));
            }
            // Null and omission preserve the existing optional-field contract.
            if require_binding {
                result[other_field] = Value::Null;
            } else {
                result.as_object_mut().unwrap().remove(other_field);
            }
            assert!(matches!(
                resolve_server_response(
                    &json!({"id":508,"result":result}),
                    &pending_approvals,
                    &pending_questions,
                    &receipts,
                    require_binding,
                ),
                InteractionReply::Delivered
            ));
            if question {
                assert_eq!(
                    question_rx.try_recv().unwrap().unwrap().answers["item"].answers,
                    ["original answer"]
                );
            } else {
                assert_eq!(
                    approval_rx.try_recv().unwrap().unwrap().decision,
                    ApprovalDecision::Accept
                );
            }
            assert!(
                matches!(
                    resolve_server_response(
                        &json!({"id":508,"result":result}),
                        &pending_approvals,
                        &pending_questions,
                        &receipts,
                        require_binding,
                    ),
                    InteractionReply::Unmatched
                ),
                "repeated input must not be delivered twice"
            );
        }
    }
}
