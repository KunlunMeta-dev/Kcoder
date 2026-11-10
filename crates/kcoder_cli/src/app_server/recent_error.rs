//! Bounded derived pointer into the authoritative attempt ledger, never a second error log.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::{
    ThreadRecentError, ThreadRecentErrorCategory as Category, ThreadRecentErrorKind as Kind,
    ThreadRecentErrorSource as Source,
};
use kcoder_cli_storage::private_files::{error_is_not_found, write_private_artifact_file};
use kcoder_engine::QueryEngine;
use kcoder_state::turn_attempt_store::TurnAttemptStore;
use kcoder_types::{ProviderFailureCategory, TurnAttemptIdentity, TurnAttemptStatus};
use std::io::Read;

#[path = "recent_error/latest_attempt.rs"]
mod latest_attempt;

const INDEX: &str = "recent-turn-error.json";
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Pointer {
    version: u32,
    identity: Option<TurnAttemptIdentity>,
}

pub fn before_finish(
    engine: &QueryEngine,
    identity: &TurnAttemptIdentity,
    status: TurnAttemptStatus,
) -> Result<()> {
    if !matches!(
        status,
        TurnAttemptStatus::Completed | TurnAttemptStatus::Failed | TurnAttemptStatus::Interrupted
    ) {
        return Ok(());
    }
    // Point at every terminal attempt, including success, so a later completed
    // turn supersedes the previous error. Write before its source commits. A crash is unknown,
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

pub fn initialize_empty(engine: &QueryEngine, thread_id: &str) -> Result<()> {
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

fn read(
    engine: &QueryEngine,
    thread_id: &str,
) -> Result<(
    Option<ThreadRecentError>,
    Option<kcoder_app_protocol::TurnStatus>,
)> {
    let root = engine.session_storage_dir_for(thread_id);
    let directory = kcoder_config::PrivateDirectory::open_existing(&root)?;
    let mut bytes = Vec::new();
    let pointer_file = match directory.open_regular_file(std::ffi::OsStr::new(INDEX)) {
        Ok(file) => Some(file),
        Err(error) if error_is_not_found(&error) => None,
        Err(error) => return Err(error),
    };
    let pointer_exists = pointer_file.is_some();
    if let Some(file) = pointer_file {
        file.take(4097).read_to_end(&mut bytes)?;
    }
    ensure!(
        bytes.len() <= 4096,
        "recent error pointer exceeds its limit"
    );
    let identity = if pointer_exists {
        let pointer: Pointer = serde_json::from_slice(&bytes)?;
        ensure!(pointer.version == 1, "unsupported recent error pointer");
        pointer.identity
    } else {
        None
    };
    let Some(store) = TurnAttemptStore::open_existing(&root, thread_id)? else {
        ensure!(
            pointer_exists && identity.is_none(),
            "attempt ledger missing"
        );
        return Ok((None, None));
    };
    if let Some(pointer_identity) = identity {
        ensure!(
            pointer_identity.thread_id == thread_id,
            "recent error thread mismatch"
        );
        store
            .load(&pointer_identity)?
            .context("recent error source missing")?;
    }
    let Some(identity) = latest_attempt::identity(&store)? else {
        return Ok((None, None));
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
    let record = store
        .load(&identity)?
        .context("recent error source missing")?;
    let completion = record
        .completion
        .context("recent error source is not committed")?;
    let kind = match completion.status {
        TurnAttemptStatus::Failed => Kind::Failed,
        TurnAttemptStatus::Interrupted => Kind::Interrupted,
        TurnAttemptStatus::Completed => {
            return Ok((None, Some(kcoder_app_protocol::TurnStatus::Completed)));
        }
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
    let status = match kind {
        Kind::Failed => kcoder_app_protocol::TurnStatus::Failed,
        Kind::Interrupted => kcoder_app_protocol::TurnStatus::Interrupted,
    };
    Ok((
        Some(ThreadRecentError {
            turn_id: identity.turn_id,
            attempt_id: Some(identity.attempt_id),
            kind,
            source,
            category,
            at_ms: completion.finished_at_ms,
        }),
        Some(status),
    ))
}

pub fn decorate(engine: &QueryEngine, thread: &mut kcoder_app_protocol::Thread, negotiated: bool) {
    if !negotiated {
        return;
    }
    let summary = thread
        .run_summary
        .get_or_insert_with(|| kcoder_app_protocol::ThreadRunFacts::default().summary());
    let observation = read(engine, &thread.id).ok();
    summary.recent_error = observation.as_ref().map(|(error, _)| error.clone());
    summary.latest_turn_status = observation.and_then(|(_, status)| status);
}
