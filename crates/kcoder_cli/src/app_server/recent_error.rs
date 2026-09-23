//! Bounded derived pointer into the authoritative attempt ledger, never a second error log.
use super::*;
use kcoder_app_protocol::{
    ThreadRecentError, ThreadRecentErrorCategory as Category, ThreadRecentErrorKind as Kind,
    ThreadRecentErrorSource as Source,
};
use kcoder_state::turn_attempt_store::TurnAttemptStore;
use kcoder_types::{ProviderFailureCategory, TurnAttemptIdentity, TurnAttemptStatus};
use std::io::Read;

const INDEX: &str = "recent-turn-error.json";
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Pointer {
    version: u32,
    identity: Option<TurnAttemptIdentity>,
}

pub(super) fn before_finish(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    status: TurnAttemptStatus,
) -> Result<()> {
    if !matches!(
        status,
        TurnAttemptStatus::Failed | TurnAttemptStatus::Interrupted
    ) {
        return Ok(());
    }
    // Write the pointer before its source commits. A crash in between is unknown,
    // never an invented failure or a falsely successful outcome.
    write_private_artifact_file(
        &engine
            .session_storage_dir_for(&identity.thread_id)
            .join(INDEX),
        &serde_json::to_vec(&Pointer {
            version: 1,
            identity: Some(identity.clone()),
        })?,
    )
}

pub(super) fn initialize_empty(engine: &QueryEngine, thread_id: &str) -> Result<()> {
    if engine.state.message_count() != 0 {
        return Ok(());
    }
    let directory = kcoder_config::PrivateDirectory::open_or_create(
        &engine.session_storage_dir_for(thread_id),
    )?;
    match directory.open_regular_file(std::ffi::OsStr::new(INDEX)) {
        Ok(_) => Ok(()),
        Err(error) if error_is_not_found(&error) => directory.atomic_replace(
            std::ffi::OsStr::new(INDEX),
            &serde_json::to_vec(&Pointer {
                version: 1,
                identity: None,
            })?,
        ),
        Err(error) => Err(error),
    }
}

fn read(engine: &QueryEngine, thread_id: &str) -> Result<Option<ThreadRecentError>> {
    let root = engine.session_storage_dir_for(thread_id);
    let directory = kcoder_config::PrivateDirectory::open_existing(&root)?;
    let mut bytes = Vec::new();
    directory
        .open_regular_file(std::ffi::OsStr::new(INDEX))?
        .take(4097)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 4096,
        "recent error pointer exceeds its limit"
    );
    let pointer: Pointer = serde_json::from_slice(&bytes)?;
    ensure!(pointer.version == 1, "unsupported recent error pointer");
    let Some(identity) = pointer.identity else {
        return Ok(None);
    };
    ensure!(
        identity.thread_id == thread_id,
        "recent error thread mismatch"
    );
    ensure!(
        identity
            .turn_id
            .strip_prefix("turn-")
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|value| value > 0),
        "invalid recent error turn identity"
    );
    let store =
        TurnAttemptStore::open_existing(&root, thread_id)?.context("attempt ledger missing")?;
    let record = store
        .load(&identity)?
        .context("recent error source missing")?;
    let completion = record
        .completion
        .context("recent error source is not committed")?;
    let kind = match completion.status {
        TurnAttemptStatus::Failed => Kind::Failed,
        TurnAttemptStatus::Interrupted => Kind::Interrupted,
        _ => anyhow::bail!("recent error source is not a failure"),
    };
    let (source, category) = match completion
        .provider_failure
        .as_ref()
        .map(|value| value.category)
    {
        Some(ProviderFailureCategory::AuthenticationError | ProviderFailureCategory::Forbidden) => {
            (Source::Provider, Category::Authentication)
        }
        Some(ProviderFailureCategory::RateLimit | ProviderFailureCategory::QuotaExceeded) => {
            (Source::Provider, Category::RateLimit)
        }
        Some(ProviderFailureCategory::NetworkError | ProviderFailureCategory::TimeoutError) => {
            (Source::Provider, Category::Network)
        }
        Some(_) => (Source::Provider, Category::Provider),
        None => (Source::Execution, Category::Execution),
    };
    Ok(Some(ThreadRecentError {
        turn_id: identity.turn_id,
        attempt_id: Some(identity.attempt_id),
        kind,
        source,
        category,
        at_ms: completion.finished_at_ms,
    }))
}

pub(super) fn decorate(
    engine: &QueryEngine,
    thread: &mut kcoder_app_protocol::Thread,
    negotiated: bool,
) {
    if !negotiated {
        return;
    }
    let summary = thread
        .run_summary
        .get_or_insert_with(|| kcoder_app_protocol::ThreadRunFacts::default().summary());
    summary.recent_error = read(engine, &thread.id).ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_server::thread_runtime::test_support::test_runtime;

    fn thread(id: &str) -> kcoder_app_protocol::Thread {
        serde_json::from_value(
            json!({ "id": id, "status": "idle", "createdAt": "1", "updatedAt": "1" }),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn projection_reads_committed_attempt_without_exposing_private_exception_text() {
        let root = tempfile::tempdir().unwrap();
        let runtime = test_runtime("recent-error", &root.path().join("history.jsonl"));
        let engine = runtime.engine();
        let id = engine.session_id();
        let identity = TurnAttemptIdentity {
            thread_id: id.clone(),
            turn_id: "turn-1".into(),
            attempt_id: "turn-1".into(),
        };
        let mut value = thread(&id);
        decorate(&engine, &mut value, true);
        assert_eq!(
            value.run_summary.as_ref().unwrap().recent_error,
            None,
            "legacy/missing pointer is unknown"
        );
        turn_attempts::begin(
            &engine,
            &identity,
            false,
            None,
            hex_sha256(b"fixture-fence"),
            hex_sha256(b"fixture-request"),
        )
        .unwrap();
        decorate(&engine, &mut value, true);
        assert_eq!(value.run_summary.as_ref().unwrap().recent_error, Some(None));
        before_finish(&engine, &identity, TurnAttemptStatus::Failed).unwrap();
        decorate(&engine, &mut value, true);
        assert_eq!(
            value.run_summary.as_ref().unwrap().recent_error,
            None,
            "uncommitted source is unknown"
        );
        turn_attempts::finish(
            &engine,
            &identity,
            "failed",
            Some("private prompt Authorization: Bearer hidden-secret"),
            None,
            &turn_attempts::PartialOutput::default(),
        )
        .unwrap();
        decorate(&engine, &mut value, true);
        let error = value
            .run_summary
            .as_ref()
            .unwrap()
            .recent_error
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap();
        assert_eq!(error.kind, Kind::Failed);
        assert_eq!(error.category, Category::Execution);
        let encoded = serde_json::to_string(&value).unwrap();
        for secret in ["private prompt", "Authorization", "hidden-secret"] {
            assert!(!encoded.contains(secret));
        }
        let mut legacy = thread(&id);
        decorate(&engine, &mut legacy, false);
        assert!(legacy.run_summary.is_none());
        write_private_artifact_file(
            &engine.session_storage_dir_for(&id).join(INDEX),
            b"{corrupt",
        )
        .unwrap();
        decorate(&engine, &mut value, true);
        assert_eq!(value.run_summary.unwrap().recent_error, None);
    }
}
