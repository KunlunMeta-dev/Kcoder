//! Select the original App Server owner and finalize transcript views.

use super::*;
pub(super) use kcoder_transcript_observation::indexed::ReadOutcome;
use kcoder_transcript_observation::indexed::{ReadSource, ViewProjection, read_indexed};

impl From<ThreadRunProjection> for ViewProjection {
    fn from(value: ThreadRunProjection) -> Self {
        Self {
            negotiated: value.negotiated,
            facts: value.facts,
        }
    }
}

/// Both transports use the original reader and the owning manager's projection.
pub(super) async fn original_response(
    target: &QueryEngine,
    params: ThreadReadParams,
    running: &HashSet<String>,
    projection: ThreadRunProjection,
    snapshot: bool,
    observation: bool,
    id: Value,
) -> Value {
    match read(target, params, running, projection, snapshot, observation).await {
        Ok(mut result) => {
            recent_error::decorate(target, &mut result.page.thread, projection.negotiated);
            success_response(
                id,
                serde_json::to_value(result.finish(projection)).expect("transcript serializes"),
            )
        }
        Err(error) => error_response(
            id,
            if error.is::<super::observed_transcript::TranscriptCursorStale>() {
                kcoder_app_protocol::TRANSCRIPT_CURSOR_STALE_CODE.into()
            } else {
                -32021
            },
            &error.to_string(),
        ),
    }
}

pub(super) async fn read(
    engine: &QueryEngine,
    params: ThreadReadParams,
    running: &HashSet<String>,
    run_projection: ThreadRunProjection,
    snapshot_enabled: bool,
    observation_enabled: bool,
) -> Result<ReadOutcome> {
    let opaque = params
        .before_cursor
        .as_deref()
        .is_some_and(|cursor| cursor.starts_with("tp1:"));
    if params.before_cursor.is_some() && !opaque {
        return super::thread_transcript(engine, params, running, run_projection)
            .await
            .map(|page| ReadOutcome::legacy(page, snapshot_enabled));
    }
    if params.thread_id == engine.session_id() {
        engine.state.flush_history().await?;
    }
    let observed_cursor = params
        .before_cursor
        .as_deref()
        .is_some_and(super::observed_transcript::is_observed_cursor);
    let candidate = if observed_cursor {
        if !observation_enabled {
            return Err(super::observed_transcript::TranscriptCursorStale.into());
        }
        super::observed_transcript::read(engine, &params, running, snapshot_enabled).await
    } else {
        try_indexed(engine, &params, running, snapshot_enabled).await
    };
    let candidate = match candidate {
        Ok(Some(outcome)) => Ok(Some(outcome)),
        _ if opaque => return Err(super::observed_transcript::TranscriptCursorStale.into()),
        _ if observation_enabled => {
            super::observed_transcript::read(engine, &params, running, snapshot_enabled).await
        }
        _ => Ok(None),
    };
    match candidate {
        Ok(Some(mut outcome)) => {
            let page = &mut outcome.page;
            if params.thread_id == engine.session_id() && page.transcript_observation_v1.is_none() {
                page.thread = serde_json::from_value(thread_snapshot(
                    engine,
                    running.contains(&params.thread_id),
                ))?;
            }
            run_projection.apply_thread(&mut page.thread);
            super::transcript_tool_recovery::settle_inactive_tools(
                &page.thread,
                &mut page.messages,
                run_projection.facts,
            );
            Ok(outcome)
        }
        _ if opaque => Err(super::observed_transcript::TranscriptCursorStale.into()),
        // Legacy callers retain their existing tolerant behavior when an index
        // cannot be built. An opaque cursor must never enter this fallback.
        _ => super::thread_transcript(engine, params, running, run_projection)
            .await
            .map(|page| ReadOutcome::legacy(page, snapshot_enabled)),
    }
}

async fn try_indexed(
    engine: &QueryEngine,
    params: &ThreadReadParams,
    running: &HashSet<String>,
    snapshot_enabled: bool,
) -> Result<Option<ReadOutcome>> {
    let source = read_source(engine, &params.thread_id)?;
    read_indexed(&source, params, running, snapshot_enabled).await
}

pub(super) fn read_source<'a>(engine: &'a QueryEngine, thread_id: &str) -> Result<ReadSource<'a>> {
    validate_thread_id(thread_id)?;
    let history = engine.state.history_path().context("history disabled")?;
    let history_root = history.parent().context("history root missing")?.to_owned();
    let client_root = engine.client_storage_root();
    let workspace = canonical_workspace(engine)?;
    Ok(ReadSource {
        history_root,
        client_root,
        workspace,
        state: &engine.state,
        response_limit: MAX_TRANSCRIPT_RESPONSE_BYTES,
        session_root: engine.session_storage_dir_for(thread_id),
    })
}
