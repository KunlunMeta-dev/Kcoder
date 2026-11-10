//! Search positions contain no source text and are bound to this connection and exact selection.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use kcoder_migration::{
    history_branches::HistoryBranchStore,
    history_search::{HistorySearchSource, SearchNeedle, SearchPosition},
};
use sha2::{Digest, Sha256};

pub(in super::super) struct SearchCursor([u8; 32]);
impl Default for SearchCursor {
    fn default() -> Self {
        let mut key = [0; 32];
        key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self(key)
    }
}
impl SearchCursor {
    fn seal(&self, position: &SearchPosition, scope: &[u8]) -> Result<String> {
        let bytes = serde_json::to_vec(position)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| anyhow::anyhow!("history_search_cursor_unavailable"))?;
        mac.update(b"kcoder.history.search/1\0");
        mac.update(scope);
        mac.update(&bytes);
        Ok(format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(bytes),
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
    fn open(&self, cursor: &str, scope: &[u8]) -> Result<SearchPosition> {
        ensure!(cursor.len() <= 16384, "history_search_invalid_cursor");
        let (bytes, signature) = cursor
            .split_once('.')
            .ok_or_else(|| anyhow::anyhow!("history_search_invalid_cursor"))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(bytes)
            .map_err(|_| anyhow::anyhow!("history_search_invalid_cursor"))?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| anyhow::anyhow!("history_search_invalid_cursor"))?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0)
            .map_err(|_| anyhow::anyhow!("history_search_invalid_cursor"))?;
        mac.update(b"kcoder.history.search/1\0");
        mac.update(scope);
        mac.update(&bytes);
        mac.verify_slice(&signature)
            .map_err(|_| anyhow::anyhow!("history_search_invalid_cursor"))?;
        serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("history_search_invalid_cursor"))
    }
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    params: Value,
) -> Result<Value> {
    let params: MigrationHistorySearchParams = decode(params)?;
    let needle = SearchNeedle::new(&params.query, params.case_sensitive)?;
    let jobs = HistoryJobStore::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("history_job_not_found"))?;
    let archive;
    let branch;
    let source = if let Some(view_id) = params.view_id.as_deref() {
        branch = HistoryBranchStore::open(profile)?;
        HistorySearchSource::Branch {
            store: &branch,
            root_job: &params.job_id,
            view_id,
        }
    } else {
        archive = jobs.archive_view(&params.job_id)?;
        HistorySearchSource::Archive(&archive)
    };
    let (identity, total) = source.snapshot()?;
    let query_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(&params.query, params.case_sensitive))?)
    );
    let scope =
        serde_json::to_vec(&(&params.job_id, &params.view_id, identity, total, query_hash))?;
    let cursor = params
        .cursor
        .as_deref()
        .map(|value| processor.search_cursor.open(value, &scope))
        .transpose()?
        .unwrap_or_default();
    let page = source.page(&needle, cursor, params.limit.unwrap_or(10), |_| {
        !processor.history.cancelled()
    })?;
    let next_cursor = page
        .next
        .as_ref()
        .map(|position| processor.search_cursor.seal(position, &scope))
        .transpose()?;
    let mut items = Vec::new();
    for hit in page.items {
        let address = MigrationTranscriptTextParams {
            job_id: params.job_id.clone(),
            record: hit.found.position,
            block_index: hit.found.block.index,
            cursor: None,
        };
        let text_identity = match &source {
            HistorySearchSource::Archive(view) => view.content_identity(),
            HistorySearchSource::Branch {
                store,
                root_job,
                view_id,
            } => store.text_identity(root_job, view_id, hit.found.position)?,
        };
        let body_cursor = processor.transcript_cursor.seal_part(
            &address,
            hit.body_start,
            hit.part,
            &text_identity,
        )?;
        items.push(MigrationHistorySearchHit {
            found: hit.found,
            body_cursor,
        });
    }
    Ok(serde_json::to_value(MigrationHistorySearchResult {
        items,
        next_cursor,
        scanned_records: page.scanned_records,
        total_records: page.total_records,
        processed_bytes: page.processed_bytes,
        unsupported_blocks: page.unsupported,
        excluded_blocks: page.excluded,
    })?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_positions_cannot_cross_a_query_selection_source_or_connection() {
        let key = SearchCursor::default();
        let position = SearchPosition {
            position: 9,
            block: 1,
            offset: 64_000,
            previous_offset: Some(0),
            processed_bytes: 1_000_000,
            ..Default::default()
        };
        let cursor = key.seal(&position, b"bound-query-and-source").unwrap();
        assert!(key.open(&cursor, b"bound-query-and-source").unwrap() == position);
        assert!(key.open(&cursor, b"different-query-or-source").is_err());
        assert!(
            SearchCursor::default()
                .open(&cursor, b"bound-query-and-source")
                .is_err()
        );
        assert!(key.open("64000", b"bound-query-and-source").is_err());
    }
}
