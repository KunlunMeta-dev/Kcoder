//! Resume's optional first page, after all existing activation/ownership gates.
use super::*;
use kcoder_app_protocol::{ThreadResumeHistoryOptionsV1, ThreadResumeResult};
#[cfg(test)]
use kcoder_app_protocol::{ThreadResumeHistoryUnavailableCodeV1, ThreadResumeHistoryV1};

pub(super) async fn response(
    id: Value,
    engine: &QueryEngine,
    manager: &ThreadManager,
    state: &ConnectionState,
    thread: Value,
    options: Option<&ThreadResumeHistoryOptionsV1>,
) -> Result<Value> {
    let Some(options) = options else {
        return Ok(success_response(id, json!({ "thread": thread })));
    };
    let thread_id = engine.session_id();
    let running = manager.running_thread_ids();
    let projection = ThreadRunProjection::for_thread(manager, state.run_summary_v1, &thread_id);
    let params = ThreadReadParams {
        thread_id,
        limit: options.limit,
        before_cursor: None,
    };
    let page = if options.indexed {
        indexed_transcript::read(engine, params, &running, projection).await
    } else {
        thread_transcript(engine, params, &running, projection).await
    };
    let result = match page {
        Ok(page) => serde_json::to_value(ThreadResumeResult::from(page))?,
        // Preserve the normal activation projection, including compatible
        // snapshot extensions not modeled by the typed transcript Thread.
        Err(_) => json!({"thread":thread,"history":{
            "status":"unavailable","code":"readFailed"
        }}),
    };
    bounded_value_response(id, result, OUTBOUND_FRAME_LIMIT_BYTES)
}

/// Account for the full JSON-RPC envelope, including Thread and request id.
/// The existing writer remains the final transport bound for all responses.
#[cfg(test)]
pub(super) fn bounded_response(
    id: Value,
    result: ThreadResumeResult,
    limit: usize,
) -> Result<Value> {
    bounded_value_response(id, serde_json::to_value(result)?, limit)
}

fn bounded_value_response(id: Value, mut result: Value, limit: usize) -> Result<Value> {
    let mut response = success_response(id.clone(), result.clone());
    if serde_json::to_vec(&response)?.len() > limit && result["history"]["status"] == "ready" {
        result["history"] = json!({"status":"unavailable","code":"responseBudgetExceeded"});
        response = success_response(id.clone(), result.clone());
    }
    if serde_json::to_vec(&response)?.len() > limit && result.get("history").is_some() {
        // Metadata itself can exceed the remaining budget. Preserve the
        // legacy successful Thread; the negotiated client reads once.
        result
            .as_object_mut()
            .expect("resume result is an object")
            .remove("history");
        response = success_response(id.clone(), result);
    }
    if serde_json::to_vec(&response)?.len() > limit {
        // A Thread-only projection can itself be oversized. Preserve the
        // existing frame failure instead of truncating Thread or page cursors.
        return Ok(error_response(
            id,
            OUTBOUND_FRAME_LIMIT_CODE,
            "app-server response exceeds the transport frame limit",
        ));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_with_history(root: &Path) -> (QueryEngine, PathBuf) {
        let engine = super::super::tests::catalog_list_test_engine(root);
        let path = root.join(format!("{}.jsonl", engine.session_id()));
        engine.state.with_history_path(&path);
        for index in 0..4 {
            engine
                .state
                .add_message(kcoder_types::Message::user_text(format!("问题{index}")));
            engine
                .state
                .add_message(kcoder_types::Message::assistant_text(format!(
                    "答案{index}"
                )));
        }
        engine.state.save_history().unwrap();
        (engine, path)
    }

    #[tokio::test]
    async fn resume_history_page_reuses_both_existing_projections_and_cursors() {
        let root = tempfile::tempdir().unwrap();
        let (engine, _) = engine_with_history(root.path());
        let manager = ThreadManager::default();
        let state = ConnectionState {
            run_summary_v1: true,
            ..ConnectionState::default()
        };
        for indexed in [false, true] {
            let options = ThreadResumeHistoryOptionsV1 {
                limit: Some(2),
                indexed,
            };
            let actual = response(
                json!(10),
                &engine,
                &manager,
                &state,
                thread_snapshot(&engine, false),
                Some(&options),
            )
            .await
            .unwrap();
            let params = ThreadReadParams {
                thread_id: engine.session_id(),
                limit: Some(2),
                before_cursor: None,
            };
            let projection = ThreadRunProjection::for_thread(&manager, true, &engine.session_id());
            let expected = if indexed {
                indexed_transcript::read(&engine, params, &HashSet::new(), projection).await
            } else {
                thread_transcript(&engine, params, &HashSet::new(), projection).await
            }
            .unwrap();
            assert_eq!(
                actual["result"],
                serde_json::to_value(ThreadResumeResult::from(expected)).unwrap()
            );
            assert_eq!(actual["result"]["history"]["status"], "ready");
            assert!(actual["result"]["history"]["page"].get("thread").is_none());
            assert!(
                actual["result"]["history"]["page"]["hasMoreBefore"]
                    .as_bool()
                    .unwrap()
            );
            let cursor = actual["result"]["history"]["page"]["beforeCursor"]
                .as_str()
                .unwrap();
            let older = indexed_transcript::read(
                &engine,
                ThreadReadParams {
                    thread_id: engine.session_id(),
                    limit: Some(2),
                    before_cursor: Some(cursor.into()),
                },
                &HashSet::new(),
                projection,
            )
            .await
            .unwrap();
            assert!(
                older.range_end
                    <= actual["result"]["history"]["page"]["rangeStart"]
                        .as_u64()
                        .unwrap() as usize
            );
        }
    }

    #[tokio::test]
    async fn resume_history_read_failure_preserves_successful_thread_and_no_request_keeps_legacy() {
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = engine_with_history(root.path());
        let manager = ThreadManager::default();
        let state = ConnectionState::default();
        let snapshot = thread_snapshot(&engine, false);
        let old = response(json!(2), &engine, &manager, &state, snapshot.clone(), None)
            .await
            .unwrap();
        assert_eq!(old, success_response(json!(2), json!({"thread":snapshot})));
        std::fs::write(&path, b"\xff\n").unwrap();
        let new = response(
            json!(3),
            &engine,
            &manager,
            &state,
            snapshot.clone(),
            Some(&ThreadResumeHistoryOptionsV1 {
                limit: Some(50),
                indexed: false,
            }),
        )
        .await
        .unwrap();
        assert_eq!(new["result"]["thread"], snapshot);
        assert_eq!(
            new["result"]["history"],
            json!({"status":"unavailable","code":"readFailed"})
        );
        assert!(new.get("error").is_none());
        assert!(new["result"]["history"].get("page").is_none());
        assert_eq!(std::fs::read(path).unwrap(), b"\xff\n");
    }

    #[test]
    fn resume_history_total_frame_budget_counts_unicode_id_and_one_thread() {
        let root = tempfile::tempdir().unwrap();
        let (engine, _) = engine_with_history(root.path());
        let thread: Thread = serde_json::from_value(thread_snapshot(&engine, false)).unwrap();
        let result = ThreadResumeResult::from(ThreadReadResult {
            thread,
            messages: vec![ThreadMessage {
                id: "message-1".into(),
                client_message_id: None,
                turn_id: None,
                attempt_id: None,
                continued_by_attempt_id: None,
                role: "user".into(),
                content: "日本語".repeat(2000),
                status: None,
                error: None,
                error_type: None,
                provider_failure: None,
                blocks: vec![],
                timestamp_ms: 1,
                content_truncated: false,
                content_original_chars: None,
            }],
            range_start: 0,
            range_end: 1,
            has_more_before: false,
            before_cursor: None,
        });
        let id = json!("请求身份".repeat(100));
        let size = serde_json::to_vec(&success_response(
            id.clone(),
            serde_json::to_value(&result).unwrap(),
        ))
        .unwrap()
        .len();
        let exact = bounded_response(id.clone(), result.clone(), size).unwrap();
        assert_eq!(exact["result"]["history"]["status"], "ready");
        let fallback = bounded_response(id.clone(), result.clone(), size - 1).unwrap();
        assert_eq!(fallback["id"], id);
        assert_eq!(
            fallback["result"]["thread"],
            serde_json::to_value(&result.thread).unwrap()
        );
        assert_eq!(
            fallback["result"]["history"],
            json!({"status":"unavailable","code":"responseBudgetExceeded"})
        );
        assert!(fallback.get("error").is_none());
        assert!(serde_json::to_vec(&fallback).unwrap().len() < size);
        assert!(fallback["result"]["history"].get("page").is_none());
        let thread_only = success_response(id.clone(), json!({"thread":result.thread}));
        let narrow_limit = serde_json::to_vec(&thread_only).unwrap().len();
        for history in [
            result.history.clone(),
            Some(ThreadResumeHistoryV1::Unavailable {
                code: ThreadResumeHistoryUnavailableCodeV1::ReadFailed,
            }),
        ] {
            let narrow = bounded_response(
                id.clone(),
                ThreadResumeResult {
                    thread: result.thread.clone(),
                    history,
                },
                narrow_limit,
            )
            .unwrap();
            assert_eq!(narrow, thread_only);
            assert!(narrow.get("error").is_none());
            assert!(narrow["result"].get("history").is_none());
        }
        let baseline = bounded_response(
            json!(1),
            ThreadResumeResult {
                thread: result.thread,
                history: None,
            },
            1,
        )
        .unwrap();
        assert_eq!(baseline["error"]["code"], OUTBOUND_FRAME_LIMIT_CODE);
    }
}
