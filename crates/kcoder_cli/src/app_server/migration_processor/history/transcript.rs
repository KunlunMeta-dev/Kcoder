//! An archive body's range is selected by native records, never by public offsets or paths.
use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub(in super::super) struct TranscriptCursor {
    key: [u8; 32],
}
impl Default for TranscriptCursor {
    fn default() -> Self {
        let mut key = [0; 32];
        key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        Self { key }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Position {
    job_id: String,
    record: u64,
    block_index: u32,
    offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    part: Option<kcoder_migration::history_search::SearchTextRange>,
}
impl TranscriptCursor {
    pub(super) fn validate_selector(
        &self,
        cursor: &str,
        params: &MigrationTranscriptTextParams,
    ) -> Result<()> {
        Self::decode(cursor, params).map(|_| ())
    }
    pub(super) fn seal_position(
        &self,
        params: &MigrationTranscriptTextParams,
        offset: u64,
        context: &str,
    ) -> Result<String> {
        self.seal(
            &Position {
                job_id: params.job_id.clone(),
                record: params.record,
                block_index: params.block_index,
                offset,
                part: None,
            },
            context,
        )
    }
    pub(super) fn seal_part(
        &self,
        params: &MigrationTranscriptTextParams,
        offset: u64,
        part: Option<kcoder_migration::history_search::SearchTextRange>,
        context: &str,
    ) -> Result<String> {
        if part.is_none() {
            return self.seal_position(params, offset, context);
        }
        self.seal(
            &Position {
                job_id: params.job_id.clone(),
                record: params.record,
                block_index: params.block_index,
                offset,
                part,
            },
            context,
        )
    }
    fn seal(&self, value: &Position, context: &str) -> Result<String> {
        let bytes = serde_json::to_vec(value)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key)
            .map_err(|_| anyhow::anyhow!("history_display_cursor_unavailable"))?;
        mac.update(b"kcoder.history.body/1\0");
        mac.update(context.as_bytes());
        mac.update(&bytes);
        Ok(format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(bytes),
            URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
        ))
    }
    fn decode(
        cursor: &str,
        params: &MigrationTranscriptTextParams,
    ) -> Result<(Position, Vec<u8>, Vec<u8>)> {
        ensure!(cursor.len() <= 1024, "history_display_invalid_cursor");
        let (value, signature) = cursor
            .split_once('.')
            .ok_or_else(|| anyhow::anyhow!("history_display_invalid_cursor"))?;
        let bytes = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| anyhow::anyhow!("history_display_invalid_cursor"))?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| anyhow::anyhow!("history_display_invalid_cursor"))?;
        let position: Position = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("history_display_invalid_cursor"))?;
        ensure!(
            position.job_id == params.job_id
                && position.record == params.record
                && position.block_index == params.block_index,
            "history_display_invalid_cursor"
        );
        Ok((position, bytes, signature))
    }
    #[cfg(test)]
    pub(super) fn open(
        &self,
        cursor: &str,
        params: &MigrationTranscriptTextParams,
        context: &str,
    ) -> Result<u64> {
        let (offset, part) = self.open_body(cursor, params, context)?;
        ensure!(part.is_none(), "history_display_invalid_cursor");
        Ok(offset)
    }
    pub(super) fn open_body(
        &self,
        cursor: &str,
        params: &MigrationTranscriptTextParams,
        context: &str,
    ) -> Result<(
        u64,
        Option<kcoder_migration::history_search::SearchTextRange>,
    )> {
        let (position, bytes, signature) = Self::decode(cursor, params)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.key)
            .map_err(|_| anyhow::anyhow!("history_display_invalid_cursor"))?;
        mac.update(b"kcoder.history.body/1\0");
        mac.update(context.as_bytes());
        mac.update(&bytes);
        mac.verify_slice(&signature)
            .map_err(|_| anyhow::anyhow!("history_display_invalid_cursor"))?;
        Ok((position.offset, position.part))
    }
}

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        method::MIGRATION_HISTORY_TRANSCRIPT
            | method::MIGRATION_HISTORY_BLOCKS
            | method::MIGRATION_HISTORY_TEXT
    )
}
pub(super) fn execute(
    processor: &MigrationProcessor,
    profile: &Path,
    operation: &str,
    params: Value,
) -> Result<Value> {
    let store = HistoryJobStore::open_existing(profile)?
        .ok_or_else(|| anyhow::anyhow!("history_job_not_found"))?;
    if operation == method::MIGRATION_HISTORY_TRANSCRIPT {
        let params: MigrationTranscriptPageParams = decode(params)?;
        let view = store.archive_view(&params.job_id)?;
        return Ok(serde_json::to_value(
            view.page(params.cursor.unwrap_or(0), |_| {
                !processor.history.cancelled()
            })?,
        )?);
    }
    if operation == method::MIGRATION_HISTORY_BLOCKS {
        let params: MigrationTranscriptBlocksParams = decode(params)?;
        let view = store.archive_view(&params.job_id)?;
        return Ok(serde_json::to_value(view.blocks(
            params.record,
            params.cursor.unwrap_or(0),
            |_| !processor.history.cancelled(),
        )?)?);
    }
    let params: MigrationTranscriptTextParams = decode(params)?;
    if let Some(cursor) = &params.cursor {
        TranscriptCursor::decode(cursor, &params)?;
    }
    let view = store.archive_view(&params.job_id)?;
    let context = view.content_identity();
    let (offset, part) = match &params.cursor {
        Some(cursor) => processor
            .transcript_cursor
            .open_body(cursor, &params, &context)?,
        None => (0, None),
    };
    let chunk = if let Some(range) = part.clone() {
        view.text_part(
            params.record,
            kcoder_migration::history_search::SearchPartRead {
                block: params.block_index,
                range,
                offset,
            },
            |_| !processor.history.cancelled(),
        )?
    } else {
        view.text(params.record, params.block_index, offset, |_| {
            !processor.history.cancelled()
        })?
    };
    let next_cursor = chunk
        .next_offset
        .map(|offset| {
            processor.transcript_cursor.seal(
                &Position {
                    job_id: params.job_id,
                    record: params.record,
                    block_index: params.block_index,
                    offset,
                    part: part.clone(),
                },
                &context,
            )
        })
        .transpose()?;
    Ok(serde_json::to_value(MigrationTranscriptTextResult {
        text: chunk.text,
        next_cursor,
        source_bytes: chunk.source_bytes,
        decoded_bytes: chunk.decoded_bytes,
        encoding: chunk.encoding,
    })?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nested_search_body_ranges_are_authenticated_and_cannot_fall_back_to_the_parent() {
        let key = TranscriptCursor::default();
        let params = MigrationTranscriptTextParams {
            job_id: "job".into(),
            record: 1,
            block_index: 2,
            cursor: None,
        };
        let range = kcoder_migration::history_search::SearchTextRange {
            offset: 200,
            bytes: 100,
        };
        let cursor = key
            .seal_part(&params, 1, Some(range.clone()), "archive-one")
            .unwrap();
        let (offset, part) = key.open_body(&cursor, &params, "archive-one").unwrap();
        assert_eq!(offset, 1);
        assert!(part == Some(range));
        assert!(key.open(&cursor, &params, "archive-one").is_err());
        let (payload, signature) = cursor.split_once('.').unwrap();
        let mut position: Position =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        position.part = None;
        let forged = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&position).unwrap()),
            signature
        );
        assert!(key.open_body(&forged, &params, "archive-one").is_err());
        assert!(key.open_body(&cursor, &params, "changed-archive").is_err());
    }

    #[test]
    fn positions_cannot_move_to_another_body_or_connection_or_supply_a_raw_offset() {
        let key = TranscriptCursor::default();
        let position = Position {
            job_id: "job".into(),
            record: 1,
            block_index: 2,
            offset: 65_535,
            part: None,
        };
        let cursor = key.seal(&position, "archive-one").unwrap();
        let mut params = MigrationTranscriptTextParams {
            job_id: "job".into(),
            record: 1,
            block_index: 2,
            cursor: Some(cursor.clone()),
        };
        assert_eq!(key.open(&cursor, &params, "archive-one").unwrap(), 65_535);
        assert!(key.open(&cursor, &params, "changed-archive").is_err());
        assert!(
            TranscriptCursor::default()
                .open(&cursor, &params, "archive-one")
                .is_err()
        );
        params.block_index = 3;
        assert!(key.open(&cursor, &params, "archive-one").is_err());
        params.block_index = 2;
        params.job_id = "other".into();
        assert!(key.open(&cursor, &params, "archive-one").is_err());
        params.job_id = "job".into();
        params.record = 2;
        assert!(key.open(&cursor, &params, "archive-one").is_err());
        assert!(key.open("65535", &params, "archive-one").is_err());
        let changed = cursor.replacen('.', "a.", 1);
        assert!(key.open(&changed, &params, "archive-one").is_err());
    }
}
