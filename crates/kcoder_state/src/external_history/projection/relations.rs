//! Indexed source identities are lookups, not an automatically selected active branch.
use super::*;
use rusqlite::OptionalExtension;

impl HistoricalProjectionStore {
    /// The immutable interpretation identity bound to these rows and their source fingerprint.
    pub fn adapter_revision(&self) -> &str {
        &self.adapter_revision
    }

    pub fn source_kind(&self) -> kcoder_types::migration::MigrationSourceKind {
        self.source_kind
    }

    pub fn source_fingerprint(&self) -> String {
        hash(
            &serde_json::to_vec(&(
                &self.archive_id,
                &self.source_sha256,
                &self.adapter_revision,
            ))
            .expect("history scope serializes"),
        )
    }

    pub fn canonical_source_record(&self, source_id: &str) -> Result<Option<HistoricalRecord>> {
        ensure!(
            self.relations_indexed,
            "history_projection_relations_not_indexed"
        );
        ensure!(
            !source_id.is_empty() && source_id.len() <= 4096,
            "history_projection_invalid_source_id"
        );
        let transaction = self.connection.unchecked_transaction()?;
        let progress = self.header(&transaction)?.progress;
        ensure!(
            progress.normalization_complete,
            "history_projection_normalization_incomplete"
        );
        let ordinal:Option<u64>=transaction.query_row("SELECT ordinal FROM projection_rows WHERE json_extract(CAST(body AS TEXT),'$.sourceId')=?1 AND ordinal<?2 ORDER BY ordinal DESC LIMIT 1",params![source_id,progress.normalized_records],|row|row.get(0)).optional()?;
        let record = ordinal
            .map(|id| self.read_record(&transaction, id, progress.normalized_records))
            .transpose()?;
        ensure!(
            record
                .as_ref()
                .is_none_or(|value| value.source_id.as_deref() == Some(source_id)),
            "history_projection_source_index_changed"
        );
        transaction.commit()?;
        Ok(record)
    }

    /// Canonical UUIDs use the latest file record. A terminal has no canonical child;
    /// progress/system entries remain in this index so the source chain stays intact.
    pub fn source_nodes(
        &self,
        cursor: u64,
        limit: u32,
        terminals_only: bool,
    ) -> Result<HistoricalSourceNodePage> {
        ensure!(
            self.relations_indexed,
            "history_projection_relations_not_indexed"
        );
        ensure!(
            (1..=10).contains(&limit),
            "history_projection_invalid_page_limit"
        );
        let transaction = self.connection.unchecked_transaction()?;
        let progress = self.header(&transaction)?.progress;
        ensure!(
            progress.normalization_complete && cursor <= progress.normalized_records,
            "history_projection_normalization_incomplete_or_invalid_cursor"
        );
        let mut statement=transaction.prepare("SELECT n.ordinal FROM projection_rows AS n WHERE n.ordinal>=?1 AND n.ordinal<?2 AND json_extract(CAST(n.body AS TEXT),'$.sourceId') IS NOT NULL AND json_extract(CAST(n.body AS TEXT),'$.sourceId')!='' AND n.ordinal=(SELECT max(h.ordinal) FROM projection_rows AS h WHERE json_extract(CAST(h.body AS TEXT),'$.sourceId')=json_extract(CAST(n.body AS TEXT),'$.sourceId') AND h.ordinal<?2) AND (?3=0 OR NOT EXISTS(SELECT 1 FROM projection_rows AS c WHERE json_extract(CAST(c.body AS TEXT),'$.parentId')=json_extract(CAST(n.body AS TEXT),'$.sourceId') AND c.ordinal<?2 AND c.ordinal=(SELECT max(ch.ordinal) FROM projection_rows AS ch WHERE json_extract(CAST(ch.body AS TEXT),'$.sourceId')=json_extract(CAST(c.body AS TEXT),'$.sourceId') AND ch.ordinal<?2))) ORDER BY n.ordinal LIMIT ?4")?;
        let ordinals: Vec<u64> = statement
            .query_map(
                params![
                    cursor,
                    progress.normalized_records,
                    terminals_only,
                    limit + 1
                ],
                |row| row.get(0),
            )?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        let has_more = ordinals.len() > limit as usize;
        let mut nodes = Vec::new();
        for ordinal in ordinals.into_iter().take(limit as usize) {
            let record = self.read_record(&transaction, ordinal, progress.normalized_records)?;
            let source_id = record
                .source_id
                .context("history_projection_source_index_changed")?;
            ensure!(
                !source_id.is_empty(),
                "history_projection_source_index_changed"
            );
            nodes.push(HistoricalSourceNode {
                record: ordinal,
                source_id,
                parent_id: record.parent_id,
                is_message: matches!(record.data, HistoricalRecordData::Message { .. }),
                hidden: record.hidden,
                sidechain: record.sidechain,
            });
        }
        let next_cursor = has_more.then(|| nodes.last().unwrap().record + 1);
        transaction.commit()?;
        Ok(HistoricalSourceNodePage { nodes, next_cursor })
    }
}
