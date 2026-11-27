//! Read observation entry point on the selected App Server session.

use super::*;
use kcoder_transcript_observation::observed::{self, parse_cursor};
pub(super) use kcoder_transcript_observation::observed::{
    TranscriptCursorStale, is_observed_cursor,
};

pub(super) async fn read(
    engine: &QueryEngine,
    params: &ThreadReadParams,
    running: &HashSet<String>,
    snapshot_enabled: bool,
) -> Result<Option<indexed_transcript::ReadOutcome>> {
    let cursor = params
        .before_cursor
        .as_deref()
        .map(parse_cursor)
        .transpose()?;
    let source = indexed_transcript::read_source(engine, &params.thread_id)?;
    observed::read(&source, params, running, snapshot_enabled, cursor).await
}
