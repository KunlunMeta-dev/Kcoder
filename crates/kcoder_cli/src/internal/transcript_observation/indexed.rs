//! Persisted transcript pagination and final wire identity projection.

use anyhow::{Context, Result};
use kcoder_app_protocol::{
    Thread, ThreadMessage, ThreadReadParams, ThreadReadResult, ThreadRunFacts,
    ThreadTranscriptSnapshotUnavailableCodeV1 as SnapshotUnavailable, ThreadTranscriptSnapshotV1,
};
use kcoder_cli_storage::{
    private_files::{ensure_private_artifact_directory, hex_sha256},
    tracked_history_list::candidate_thread_history_path,
};
use kcoder_state::{
    AppState,
    history_index::{TranscriptPageStore, TranscriptReadFence},
};
use kcoder_thread_metadata::{decorate_thread_snapshot_with_metadata, read_thread_metadata};
use kcoder_transcript::transcript_window;
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf};

pub struct ReadSource<'a> {
    pub history_root: PathBuf,
    pub client_root: PathBuf,
    pub workspace: String,
    pub state: &'a AppState,
    pub response_limit: usize,
    pub session_root: PathBuf,
}

#[derive(Clone, Copy)]
pub struct ViewProjection {
    pub negotiated: bool,
    pub facts: Option<ThreadRunFacts>,
}

pub const STORAGE_PROJECTION_VERSION: &str = "final-transcript-v3";
// Capture observations must survive cached and downgraded client projections.
pub const VISIBLE_PROJECTION_VERSION: &str = "final-transcript-v12";

/// Internal source proof travels separately from wire identities until final decoration.
#[derive(Clone)]
pub struct ReadOutcome {
    pub page: ThreadReadResult,
    identity: Option<SnapshotIdentity>,
}

#[derive(Clone)]
enum SnapshotIdentity {
    Proven(String),
    Unavailable(SnapshotUnavailable),
}

impl ReadOutcome {
    pub fn legacy(page: ThreadReadResult, enabled: bool) -> Self {
        Self {
            page,
            identity: enabled.then_some(SnapshotIdentity::Unavailable(
                SnapshotUnavailable::LegacyReader,
            )),
        }
    }

    /// Finish once, after recent-error and runtime decoration. This does not order live events.
    pub fn finish(self, projection: impl Into<ViewProjection>) -> ThreadReadResult {
        self.finish_view(projection.into())
    }

    fn finish_view(mut self, projection: ViewProjection) -> ThreadReadResult {
        self.page.transcript_snapshot_v1 = self.identity.map(|identity| match identity {
            SnapshotIdentity::Proven(snapshot_id) => ThreadTranscriptSnapshotV1::Available {
                snapshot_id,
                view_key: view_key(&self.page.thread, projection),
            },
            SnapshotIdentity::Unavailable(code) => ThreadTranscriptSnapshotV1::Unavailable { code },
        });
        if let Some(observation) = &mut self.page.transcript_observation_v1 {
            observation.view_key = view_key(&self.page.thread, projection);
        }
        self.page
    }
}

pub async fn read_indexed(
    source: &ReadSource<'_>,
    params: &ThreadReadParams,
    running: &HashSet<String>,
    snapshot_enabled: bool,
) -> Result<Option<ReadOutcome>> {
    let history_root = &source.history_root;
    let client_root = &source.client_root;
    let workspace = &source.workspace;
    // Keep storage ownership stable while invalidating old projection receipts.
    let storage_scope =
        serde_json::to_string(&(STORAGE_PROJECTION_VERSION, &workspace, &params.thread_id))?;
    let scope =
        serde_json::to_string(&(VISIBLE_PROJECTION_VERSION, &workspace, &params.thread_id))?;
    let Some(receipt) = TranscriptReadFence::acquire(history_root, client_root, &scope)? else {
        return Ok(None);
    };
    let proof = receipt.proof().to_vec();
    let root = &source.session_root;
    let mut store = TranscriptPageStore::open_existing_recoverable(root, &storage_scope)?;
    let row_limit = source.response_limit - 4096;
    if store
        .as_ref()
        .map(|store| store.declined_generation(&proof, row_limit))
        .transpose()?
        .flatten()
        .is_some()
    {
        return Ok(None);
    }
    let mut generation = store
        .as_ref()
        .map(|store| store.current_generation(&proof))
        .transpose()?
        .flatten();
    let before = if let Some(cursor) = &params.before_cursor {
        anyhow::ensure!(cursor.len() <= 128, "invalid transcript cursor");
        let fields = cursor.split(':').collect::<Vec<_>>();
        anyhow::ensure!(
            fields.len() == 3 && fields[0] == "tp1" && generation.as_deref() == Some(fields[1]),
            "stale transcript cursor"
        );
        Some(
            fields[2]
                .parse::<usize>()?
                .checked_add(1)
                .context("cursor overflow")?,
        )
    } else {
        None
    };
    if generation.is_none() {
        drop(receipt);
        drop(store.take());
        // Source loading never holds the writer fences. Final publication
        // compares a newly acquired receipt to this pre-load observation.
        let path = candidate_thread_history_path(history_root, &params.thread_id)?;
        let metadata = kcoder_state::prepare_session_metadata_bounded(&path, 1024 * 1024)?;
        anyhow::ensure!(
            std::fs::canonicalize(metadata.base_cwd().context("thread workspace is missing")?)?
                == std::fs::canonicalize(source.state.cwd())?,
            "thread workspace mismatch"
        );
        let mut reader = kcoder_state::ProjectedTranscriptReader::open(
            &path,
            128 * 1024 * 1024,
            4 * 1024 * 1024,
            100_000,
        )?;
        let entries = loop {
            let next = reader.step(1024 * 1024)?;
            tokio::task::yield_now().await;
            if let Some(entries) = next {
                break entries;
            }
        };
        let projection = reader
            .take_projection()
            .context("transcript projection unavailable")?;
        drop(reader);
        let (created, updated) = projection.timestamps_ms(&metadata);
        let mut thread = json!({"id":params.thread_id,"cwd":workspace,"sessionMode":metadata.session_mode(),"studioWorkMode":metadata.studio_work_mode(),"workflowDefinitionId":metadata.workflow_definition_id(),"status":"idle",
            "title":projection.first_prompt().map(|text| text.chars().take(80).collect::<String>()),"createdAt":created.to_string(),"updatedAt":updated.to_string()});
        let stored = read_thread_metadata(client_root, &source.state.cwd(), &params.thread_id)?;
        decorate_thread_snapshot_with_metadata(&mut thread, stored.as_ref(), true)?;
        let artifacts = crate::load_artifacts(root, &params.thread_id).await?;
        let mut associations = transcript_window::TranscriptAssociationScan::new(entries);
        loop {
            let complete = associations.step(128)?;
            tokio::task::yield_now().await;
            if complete {
                break;
            }
        }
        let mut turns = associations.finish(artifacts)?;
        ensure_private_artifact_directory(root)?;
        let mut build = TranscriptPageStore::open(root, &storage_scope, true)?
            .context("page store unavailable")?;
        let next = build.begin()?;
        build.append_with_row_limit(&next, &[thread], 1024 * 1024)?;
        let append_rows = |build: &mut TranscriptPageStore, rows: &[Value]| -> Result<()> {
            match build.append_with_row_limit(&next, rows, row_limit) {
                Ok(()) => Ok(()),
                Err(error) => {
                    if error.is::<kcoder_state::history_index::TranscriptRowLimitExceeded>() {
                        // Clear derived rows before reacquiring source fences; only the small
                        // decline header write runs while authority is held.
                        let declined = build.restart_unpublished(&next)?;
                        if let Some(fresh) =
                            TranscriptReadFence::acquire(history_root, client_root, &scope)?
                            && fresh.proof() == proof
                        {
                            build.decline_row_limit(&declined, fresh.proof(), row_limit)?;
                        }
                    }
                    Err(error)
                }
            }
        };
        let mut batch = Vec::with_capacity(8);
        while let Some(messages) = turns.next_turn() {
            for row in messages {
                batch.push(serde_json::to_value(row)?);
                if batch.len() == 8 {
                    append_rows(&mut build, &batch)?;
                    batch.clear();
                    tokio::task::yield_now().await;
                }
            }
            tokio::task::yield_now().await;
        }
        if !batch.is_empty() {
            append_rows(&mut build, &batch)?;
        }
        let final_receipt = TranscriptReadFence::acquire(history_root, client_root, &scope)?
            .context("tracking disabled")?;
        anyhow::ensure!(
            final_receipt.proof() == proof,
            "transcript changed during build"
        );
        build.publish_with_source_observation(
            &next,
            final_receipt.proof(),
            projection.observation(),
        )?;
        store = Some(build);
        generation = Some(next);
        return read_page(
            store.as_ref().unwrap(),
            generation.as_deref().unwrap(),
            final_receipt.proof(),
            params,
            before,
            running,
            snapshot_enabled,
            row_limit,
        )
        .map(Some);
    }
    read_page(
        store.as_ref().unwrap(),
        generation.as_deref().unwrap(),
        receipt.proof(),
        params,
        before,
        running,
        snapshot_enabled,
        row_limit,
    )
    .map(Some)
}

#[expect(
    clippy::too_many_arguments,
    reason = "The storage proof, cursor, run state and byte budget are distinct"
)]
fn read_page(
    store: &TranscriptPageStore,
    generation: &str,
    proof: &[u8],
    params: &ThreadReadParams,
    before: Option<usize>,
    running: &HashSet<String>,
    snapshot_enabled: bool,
    row_limit: usize,
) -> Result<ReadOutcome> {
    let metadata = store.page(generation, proof, Some(1), 1, 1024 * 1024)?;
    let mut thread: Thread = serde_json::from_value(
        metadata
            .rows
            .into_iter()
            .next()
            .context("thread header missing")?,
    )?;
    anyhow::ensure!(thread.id == params.thread_id, "thread header mismatch");
    thread.status = if running.contains(&params.thread_id) {
        kcoder_app_protocol::ThreadStatus::Running
    } else {
        kcoder_app_protocol::ThreadStatus::Idle
    };
    let page = store.page(
        generation,
        proof,
        before,
        params.limit.unwrap_or(50).clamp(1, 100) as usize,
        row_limit,
    )?;
    let start = page.start.saturating_sub(1);
    let end = page.end.saturating_sub(1);
    let messages = page
        .rows
        .into_iter()
        .enumerate()
        .filter(|(index, _)| page.start + index > 0)
        .map(|(_, row)| serde_json::from_value(row))
        .collect::<std::result::Result<Vec<ThreadMessage>, _>>()?;
    // Capability-off reads retain all ordinary page/proof validation without extra identity IO.
    let identity = if snapshot_enabled {
        Some(match store.committed_source_token(generation, proof)? {
            Some(source_token) => SnapshotIdentity::Proven(hex_sha256(&serde_json::to_vec(&(
                "kcoder.transcript-snapshot.v1",
                &params.thread_id,
                STORAGE_PROJECTION_VERSION,
                VISIBLE_PROJECTION_VERSION,
                source_token,
                proof,
                generation,
            ))?)),
            None => SnapshotIdentity::Unavailable(SnapshotUnavailable::UnprovenSource),
        })
    } else {
        None
    };
    Ok(ReadOutcome {
        page: ThreadReadResult {
            thread,
            messages,
            range_start: start,
            range_end: end,
            has_more_before: start > 0,
            before_cursor: (start > 0).then(|| format!("tp1:{generation}:{start}")),
            transcript_snapshot_v1: None,
            transcript_observation_v1: None,
        },
        identity,
    })
}

fn view_key(thread: &Thread, projection: ViewProjection) -> String {
    // Facts affect tool settlement even when the run-summary capability is off.
    let facts = projection.facts.map(|facts| {
        (
            facts.main_turn_running,
            facts.pending_approvals,
            facts.pending_questions,
            facts.active_jobs,
            facts.tasks_pending,
            facts.tasks_running,
            facts.pending_followups,
            facts.pending_goals,
        )
    });
    let mut value = serde_json::to_value((
        "kcoder.transcript-view.v1",
        VISIBLE_PROJECTION_VERSION,
        "inactive-tool-result-unavailable.v1",
        thread,
        projection.negotiated,
        facts,
    ))
    .expect("transcript view serializes");
    canonicalize(&mut value);
    hex_sha256(&serde_json::to_vec(&value).expect("transcript view serializes"))
}

fn canonicalize(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(canonicalize),
        Value::Object(values) => {
            let mut entries = std::mem::take(values).into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            for (key, mut value) in entries {
                canonicalize(&mut value);
                values.insert(key, value);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE_LIMIT: usize = 1_500_000 - 4096;

    fn snapshot_test_page() -> ThreadReadResult {
        serde_json::from_value(json!({
            "thread":{"id":"fixture","cwd":"/tmp","status":"idle","createdAt":"1","updatedAt":"10"},
            "messages":[],"rangeStart":0,"rangeEnd":0,"hasMoreBefore":false
        }))
        .unwrap()
    }

    #[test]
    fn transcript_snapshot_legacy_published_generation_is_readable_but_unproven() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "old-generation", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        store
            .append(
                &generation,
                &[serde_json::to_value(snapshot_test_page().thread).unwrap()],
            )
            .unwrap();
        store.publish(&generation, b"existing-proof").unwrap();
        let page = read_page(
            &store,
            &generation,
            b"existing-proof",
            &ThreadReadParams {
                thread_id: "fixture".into(),
                limit: Some(1),
                before_cursor: None,
            },
            None,
            &HashSet::new(),
            true,
            PAGE_LIMIT,
        )
        .unwrap()
        .finish(ViewProjection {
            negotiated: false,
            facts: None,
        });
        assert!(page.messages.is_empty());
        assert_eq!(
            page.transcript_snapshot_v1,
            Some(ThreadTranscriptSnapshotV1::Unavailable {
                code: SnapshotUnavailable::UnprovenSource
            })
        );
    }

    #[test]
    fn transcript_snapshot_capability_off_keeps_internal_and_wire_identity_absent() {
        let root = tempfile::tempdir().unwrap();
        let mut store = TranscriptPageStore::open(root.path(), "cap-off", true)
            .unwrap()
            .unwrap();
        let generation = store.begin().unwrap();
        store
            .append(
                &generation,
                &[serde_json::to_value(snapshot_test_page().thread).unwrap()],
            )
            .unwrap();
        store.publish(&generation, b"proof").unwrap();
        let outcome = read_page(
            &store,
            &generation,
            b"proof",
            &ThreadReadParams {
                thread_id: "fixture".into(),
                limit: Some(1),
                before_cursor: None,
            },
            None,
            &HashSet::new(),
            false,
            PAGE_LIMIT,
        )
        .unwrap();
        assert!(outcome.identity.is_none());
        assert!(outcome.page.transcript_snapshot_v1.is_none());
        let page = outcome.finish(ViewProjection {
            negotiated: false,
            facts: None,
        });
        assert!(
            serde_json::to_value(page)
                .unwrap()
                .get("transcriptSnapshotV1")
                .is_none()
        );
    }

    #[test]
    fn transcript_snapshot_view_uses_final_thread_and_all_settlement_facts_not_page_rows() {
        let mut outcome = ReadOutcome {
            page: snapshot_test_page(),
            identity: Some(SnapshotIdentity::Proven("a".repeat(64))),
        };
        let projection = ViewProjection {
            negotiated: false,
            facts: None,
        };
        assert!(outcome.page.transcript_snapshot_v1.is_none());
        let base = outcome.clone().finish(projection).transcript_snapshot_v1;
        outcome.page.range_start = 123;
        outcome.page.range_end = 124;
        outcome.page.messages = serde_json::from_value(json!([{"id":"different-page","role":"assistant","content":"other page","timestampMs":10}])).unwrap();
        assert_eq!(
            outcome.clone().finish(projection).transcript_snapshot_v1,
            base
        );
        for facts in [
            kcoder_app_protocol::ThreadRunFacts {
                main_turn_running: Some(false),
                ..Default::default()
            },
            kcoder_app_protocol::ThreadRunFacts {
                pending_approvals: Some(0),
                ..Default::default()
            },
            kcoder_app_protocol::ThreadRunFacts {
                pending_questions: Some(0),
                ..Default::default()
            },
            kcoder_app_protocol::ThreadRunFacts {
                active_jobs: Some(0),
                ..Default::default()
            },
            kcoder_app_protocol::ThreadRunFacts {
                tasks_pending: Some(0),
                ..Default::default()
            },
            kcoder_app_protocol::ThreadRunFacts {
                tasks_running: Some(0),
                ..Default::default()
            },
            kcoder_app_protocol::ThreadRunFacts {
                pending_followups: Some(0),
                ..Default::default()
            },
            kcoder_app_protocol::ThreadRunFacts {
                pending_goals: Some(0),
                ..Default::default()
            },
        ] {
            let page = outcome.clone().finish(ViewProjection {
                negotiated: false,
                facts: Some(facts),
            });
            assert_ne!(
                page.transcript_snapshot_v1, base,
                "facts affect settlement without run-summary opt-in"
            );
            assert!(matches!(&page.transcript_snapshot_v1,
                Some(ThreadTranscriptSnapshotV1::Available { snapshot_id, .. }) if snapshot_id == &"a".repeat(64)));
        }
        outcome.page.thread.title = Some("final decoration".into());
        assert_ne!(
            outcome.clone().finish(projection).transcript_snapshot_v1,
            base
        );
        let mut summary = kcoder_app_protocol::ThreadRunFacts::default().summary();
        outcome.page.thread.run_summary = Some(summary.clone());
        let before_error_decoration = outcome.clone().finish(projection).transcript_snapshot_v1;
        summary.recent_error = Some(Some(kcoder_app_protocol::ThreadRecentError {
            turn_id: "turn-1".into(),
            attempt_id: Some("turn-1".into()),
            kind: kcoder_app_protocol::ThreadRecentErrorKind::Failed,
            source: kcoder_app_protocol::ThreadRecentErrorSource::Provider,
            category: kcoder_app_protocol::ThreadRecentErrorCategory::Network,
            at_ms: 123,
        }));
        outcome.page.thread.run_summary = Some(summary);
        assert!(
            outcome.page.transcript_snapshot_v1.is_none(),
            "no premature wire identity"
        );
        let final_page = outcome.finish(projection);
        assert_ne!(final_page.transcript_snapshot_v1, before_error_decoration);
        let legacy = ReadOutcome::legacy(final_page.clone(), true).finish(projection);
        assert_eq!(
            legacy.transcript_snapshot_v1,
            Some(ThreadTranscriptSnapshotV1::Unavailable {
                code: SnapshotUnavailable::LegacyReader,
            })
        );
        let disabled = ReadOutcome::legacy(final_page, false).finish(projection);
        assert!(disabled.transcript_snapshot_v1.is_none());
    }

    #[test]
    fn runtime_visibility_revision_invalidates_old_rows_without_changing_store_ownership() {
        let root = tempfile::tempdir().unwrap();
        let old_scope =
            serde_json::to_string(&(STORAGE_PROJECTION_VERSION, "workspace", "session")).unwrap();
        let new_scope =
            serde_json::to_string(&(VISIBLE_PROJECTION_VERSION, "workspace", "session")).unwrap();
        // Receipts include the projection scope in their digest. Model that
        // changed proof while retaining the established storage ownership.
        let old_visible_scope =
            serde_json::to_string(&("final-transcript-v6", "workspace", "session")).unwrap();
        let old_proof = old_visible_scope.as_bytes();
        let new_proof = new_scope.as_bytes();
        let mut store = TranscriptPageStore::open(root.path(), &old_scope, true)
            .unwrap()
            .unwrap();
        let old = store.begin().unwrap();
        store
            .append_with_row_limit(&old, &[json!({"content":"[system] private"})], 4096)
            .unwrap();
        store.publish(&old, old_proof).unwrap();
        drop(store);
        let store = TranscriptPageStore::open_existing_recoverable(root.path(), &old_scope)
            .unwrap()
            .unwrap();
        assert_eq!(
            store.current_generation(old_proof).unwrap().as_deref(),
            Some(old.as_str())
        );
        assert!(store.current_generation(new_proof).unwrap().is_none());
        drop(store);
        let mut store = TranscriptPageStore::open(root.path(), &old_scope, true)
            .unwrap()
            .unwrap();
        let next = store.begin().unwrap();
        store
            .append_with_row_limit(&next, &[json!({"content":"visible user"})], 4096)
            .unwrap();
        store.publish(&next, new_proof).unwrap();
        assert_eq!(
            store.current_generation(new_proof).unwrap().as_deref(),
            Some(next.as_str())
        );
        assert!(store.current_generation(old_proof).unwrap().is_none());
    }
}
