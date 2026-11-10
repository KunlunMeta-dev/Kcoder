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
        indexed_transcript::read(
            engine,
            params,
            &running,
            projection,
            state.transcript_snapshot_v1,
            state.transcript_observation_v1,
        )
        .await
    } else {
        thread_transcript(engine, params, &running, projection)
            .await
            .map(|page| indexed_transcript::ReadOutcome::legacy(page, state.transcript_snapshot_v1))
    };
    let result = match page {
        Ok(mut page) => {
            recent_error::decorate(engine, &mut page.page.thread, projection.negotiated);
            let page = page.finish(projection);
            serde_json::to_value(ThreadResumeResult::from(page))?
        }
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

    fn enable_snapshot_tracking(engine: &QueryEngine, history_path: &Path) {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        let client = engine.client_storage_root();
        ensure_private_artifact_directory(&client).unwrap();
        for (root, domain) in [
            (history_path.parent().unwrap(), JournalDomain::History),
            (client.as_path(), JournalDomain::ClientMetadata),
        ] {
            JournalFence::try_acquire(root, domain)
                .unwrap()
                .activate()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn transcript_snapshot_indexed_pages_and_inline_resume_share_proven_identity() {
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = engine_with_history(root.path());
        enable_snapshot_tracking(&engine, &path);
        let manager = ThreadManager::default();
        let projection = ThreadRunProjection::for_thread(&manager, false, &engine.session_id());
        let params = |before_cursor| ThreadReadParams {
            thread_id: engine.session_id(),
            limit: Some(2),
            before_cursor,
        };
        let first = indexed_transcript::read(
            &engine,
            params(None),
            &HashSet::new(),
            projection,
            true,
            false,
        )
        .await
        .unwrap()
        .finish(projection);
        assert!(matches!(
            first.transcript_snapshot_v1,
            Some(kcoder_app_protocol::ThreadTranscriptSnapshotV1::Available { .. })
        ));
        let older = indexed_transcript::read(
            &engine,
            params(first.before_cursor.clone()),
            &HashSet::new(),
            projection,
            true,
            false,
        )
        .await
        .unwrap()
        .finish(projection);
        assert_eq!(first.transcript_snapshot_v1, older.transcript_snapshot_v1);
        assert_eq!(first.range_start, older.range_end);
        let state = ConnectionState {
            transcript_snapshot_v1: true,
            ..ConnectionState::default()
        };
        let inline = response(
            json!(1),
            &engine,
            &manager,
            &state,
            thread_snapshot(&engine, false),
            Some(&ThreadResumeHistoryOptionsV1 {
                limit: Some(2),
                indexed: true,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            inline["result"]["history"]["page"]["transcriptSnapshotV1"],
            serde_json::to_value(&first.transcript_snapshot_v1).unwrap()
        );
        let legacy = response(
            json!(2),
            &engine,
            &manager,
            &state,
            thread_snapshot(&engine, false),
            Some(&ThreadResumeHistoryOptionsV1 {
                limit: Some(2),
                indexed: false,
            }),
        )
        .await
        .unwrap();
        assert_eq!(
            legacy["result"]["history"]["page"]["transcriptSnapshotV1"],
            json!({"status":"unavailable","code":"legacyReader"})
        );
        let unnegotiated = response(
            json!(3),
            &engine,
            &manager,
            &ConnectionState::default(),
            thread_snapshot(&engine, false),
            Some(&ThreadResumeHistoryOptionsV1 {
                limit: Some(2),
                indexed: true,
            }),
        )
        .await
        .unwrap();
        assert!(
            unnegotiated["result"]["history"]["page"]
                .get("transcriptSnapshotV1")
                .is_none()
        );
    }

    #[tokio::test]
    async fn transcript_snapshot_history_and_client_metadata_independently_invalidate_old_pages() {
        use kcoder_state::history_index::journal::{JournalDomain, JournalFence};
        let root = tempfile::tempdir().unwrap();
        let (engine, path) = engine_with_history(root.path());
        enable_snapshot_tracking(&engine, &path);
        let projection = ThreadRunProjection {
            negotiated: false,
            facts: None,
        };
        let params = |before_cursor| ThreadReadParams {
            thread_id: engine.session_id(),
            limit: Some(2),
            before_cursor,
        };
        let mut previous = indexed_transcript::read(
            &engine,
            params(None),
            &HashSet::new(),
            projection,
            true,
            false,
        )
        .await
        .unwrap()
        .finish(projection);
        for domain in [JournalDomain::History, JournalDomain::ClientMetadata] {
            match domain {
                JournalDomain::History => {
                    engine
                        .state
                        .add_message(kcoder_types::Message::user_text("new committed body"));
                    engine.state.save_history().unwrap();
                }
                JournalDomain::ClientMetadata => {
                    let client = engine.client_storage_root();
                    let mut fence = JournalFence::try_acquire(&client, domain).unwrap();
                    fence.begin(&engine.session_id()).unwrap().finish().unwrap();
                }
            }
            assert!(
                indexed_transcript::read(
                    &engine,
                    params(previous.before_cursor.clone()),
                    &HashSet::new(),
                    projection,
                    true,
                    false,
                )
                .await
                .is_err()
            );
            let next = indexed_transcript::read(
                &engine,
                params(None),
                &HashSet::new(),
                projection,
                true,
                false,
            )
            .await
            .unwrap()
            .finish(projection);
            match (
                &previous.transcript_snapshot_v1,
                &next.transcript_snapshot_v1,
            ) {
                (
                    Some(kcoder_app_protocol::ThreadTranscriptSnapshotV1::Available {
                        snapshot_id: old,
                        ..
                    }),
                    Some(kcoder_app_protocol::ThreadTranscriptSnapshotV1::Available {
                        snapshot_id: new,
                        ..
                    }),
                ) => assert_ne!(old, new),
                other => panic!("tracked committed source must remain proven: {other:?}"),
            }
            previous = next;
        }
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
                indexed_transcript::read(
                    &engine,
                    params,
                    &HashSet::new(),
                    projection,
                    state.transcript_snapshot_v1,
                    state.transcript_observation_v1,
                )
                .await
            } else {
                thread_transcript(&engine, params, &HashSet::new(), projection)
                    .await
                    .map(|page| {
                        indexed_transcript::ReadOutcome::legacy(page, state.transcript_snapshot_v1)
                    })
            }
            .unwrap()
            .finish(projection);
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
                state.transcript_snapshot_v1,
                state.transcript_observation_v1,
            )
            .await
            .unwrap()
            .finish(projection);
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
                file_changes_capture: None,
                review_evidence: None,
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
            transcript_snapshot_v1: None,
            transcript_observation_v1: None,
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
                    stream_context: None,
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
                stream_context: None,
                history: None,
            },
            1,
        )
        .unwrap();
        assert_eq!(baseline["error"]["code"], OUTBOUND_FRAME_LIMIT_CODE);
    }
}
