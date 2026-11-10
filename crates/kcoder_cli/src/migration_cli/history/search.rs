//! Private host cursors live only for one command; paging never copies or decodes them locally.
use super::*;
use kcoder_app_protocol::{
    MigrationBranchTextParams, MigrationHistorySearchParams, MigrationHistorySearchResult,
    MigrationTranscriptTextParams, MigrationTranscriptTextResult, method,
};
use std::time::{Duration, Instant};

pub(super) fn handles(action: &HistoryAction) -> bool {
    matches!(action, HistoryAction::Search { .. })
}

pub(super) fn run(
    action: &HistoryAction,
    context: &Context,
    overlays: &[PathBuf],
    cancelled: &AtomicBool,
) -> Result<()> {
    let HistoryAction::Search {
        job_id,
        view_id,
        query,
        case_sensitive,
        page,
        limit,
        read_hit,
        body_page,
    } = action
    else {
        anyhow::bail!("migration_unknown_operation")
    };
    let mut client = rpc::Client::start(context, overlays)?;
    client.require_capability("migrationHistorySearchV1")?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let active = || -> Result<()> {
        ensure!(
            !cancelled.load(Ordering::Acquire),
            "migration_search_cancelled"
        );
        ensure!(Instant::now() < deadline, "migration_search_wait_expired");
        Ok(())
    };
    let mut params = MigrationHistorySearchParams {
        job_id: job_id.clone(),
        view_id: view_id.clone(),
        query: query.clone(),
        case_sensitive: *case_sensitive,
        cursor: None,
        limit: Some(*limit),
    };
    let mut result: Option<MigrationHistorySearchResult> = None;
    for index in 0..=*page {
        active()?;
        if index > 0 {
            params.cursor = Some(
                result
                    .as_ref()
                    .and_then(|page| page.next_cursor.clone())
                    .context("history_search_page_out_of_range")?,
            );
        }
        result = Some(serde_json::from_value(client.call(
            method::MIGRATION_HISTORY_SEARCH,
            serde_json::to_value(&params)?,
        )?)?);
    }
    let result = result.context("history_search_page_unavailable")?;
    let mut body = None;
    if let Some(number) = read_hit {
        client.require_capability(if view_id.is_some() {
            "migrationHistoryBranchesV1"
        } else {
            "migrationHistoryReadV1"
        })?;
        let hit = result
            .items
            .get(usize::from(*number) - 1)
            .context("history_search_hit_not_on_page")?;
        let mut cursor = hit.body_cursor.clone();
        for index in 0..=*body_page {
            active()?;
            let value = if let Some(view) = view_id {
                client.call(
                    method::MIGRATION_BRANCH_TEXT,
                    serde_json::to_value(MigrationBranchTextParams {
                        job_id: job_id.clone(),
                        view_id: view.clone(),
                        position: hit.found.position,
                        block_index: hit.found.block.index,
                        cursor: Some(cursor),
                    })?,
                )?
            } else {
                client.call(
                    method::MIGRATION_HISTORY_TEXT,
                    serde_json::to_value(MigrationTranscriptTextParams {
                        job_id: job_id.clone(),
                        record: hit.found.position,
                        block_index: hit.found.block.index,
                        cursor: Some(cursor),
                    })?,
                )?
            };
            let chunk: MigrationTranscriptTextResult = serde_json::from_value(value)?;
            if index == *body_page {
                body = Some(
                    json!({"hit":number,"page":body_page,"text":chunk.text,"hasNextPage":chunk.next_cursor.is_some(),"sourceBytes":chunk.source_bytes,"decodedBytes":chunk.decoded_bytes,"encoding":chunk.encoding}),
                );
                break;
            }
            cursor = chunk
                .next_cursor
                .context("history_search_body_page_out_of_range")?;
        }
    }
    // Export page coordinates instead of connection-private bearer cursors that expire on exit.
    let items = result
        .items
        .into_iter()
        .map(|hit| serde_json::to_value(hit.found))
        .collect::<Result<Vec<_>, _>>()?;
    super::super::batch::print(&json!({
        "page":page,"limit":limit,"items":items,"hasNextPage":result.next_cursor.is_some(),
        "scannedRecords":result.scanned_records,"totalRecords":result.total_records,"processedBytes":result.processed_bytes,
        "unsupportedBlocks":result.unsupported_blocks,"excludedBlocks":result.excluded_blocks,
        "cursorScope":"connection","body":body,
    }))
}
