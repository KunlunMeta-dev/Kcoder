//! Job-owned stage checkpoints. Received bytes remain private and never certify
//! a candidate; only the host's typed/evidence checks advance validation.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiJobLease};
use anyhow::{Result, ensure};
use kcoder_types::wiki_pipeline::{
    WikiPipelineProgress, WikiPipelineStageAddress, WikiPipelineStageKind as Kind,
    WikiPipelineStageRecord as Record, WikiPipelineStageStatus as Status,
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_STAGE_ROWS: usize = 256;
const MAX_JOB_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiStagePageRevision {
    pub page_id: String,
    pub revision_id: String,
}

/// Authored from actual host state, never deserialized from an RPC/model reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiStageBinding {
    pub address: WikiPipelineStageAddress,
    pub purpose_hash: String,
    pub recipe_key: String,
    pub model_fingerprint: String,
    pub dependency_hashes: Vec<String>,
    pub input_page_revisions: Vec<WikiStagePageRevision>,
}

#[derive(Debug, Clone)]
pub struct WikiStageInput {
    pub binding: WikiStageBinding,
    pub input_fingerprint: String,
    pub unit_label: Option<String>,
    pub unit_index: Option<usize>,
    pub total_units: Option<usize>,
}

struct Saved {
    input: String,
    binding: WikiStageBinding,
    record: Record,
    raw: Option<String>,
    raw_hash: Option<String>,
    output: Option<String>,
    output_hash: Option<String>,
}

fn now() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}
fn hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn order(kind: Kind) -> u8 {
    match kind {
        Kind::Extract => 0,
        Kind::Analyze => 1,
        Kind::Retrieve => 2,
        Kind::Generate => 3,
        Kind::Verify => 4,
        Kind::Coverage => 5,
        Kind::Commit => 6,
    }
}
fn check_input(input: &WikiStageInput, lease: &WikiJobLease) -> Result<()> {
    let binding = &input.binding;
    ensure!(
        binding.address.batch == lease.job.after_chunk
            && binding.address.source_revision == lease.job.source_revision
            && binding.recipe_key == lease.job.recipe_key,
        "Wiki stage binding mismatch"
    );
    ensure!(
        !binding.address.stage_key.is_empty()
            && binding.address.stage_key.len() <= 128
            && binding.address.unit_key.len() <= 256,
        "invalid Wiki stage address"
    );
    ensure!(
        hash(&input.input_fingerprint)
            && hash(&binding.purpose_hash)
            && hash(&binding.model_fingerprint),
        "invalid Wiki stage fingerprint"
    );
    ensure!(
        binding.dependency_hashes.len() <= 256
            && binding.dependency_hashes.iter().all(|value| hash(value)),
        "invalid Wiki stage dependencies"
    );
    ensure!(
        binding.input_page_revisions.len() <= 64
            && binding
                .input_page_revisions
                .iter()
                .all(|page| !page.page_id.is_empty()
                    && page.page_id.len() <= 256
                    && !page.revision_id.is_empty()
                    && page.revision_id.len() <= 256),
        "invalid Wiki page bindings"
    );
    ensure!(
        input
            .unit_label
            .as_ref()
            .is_none_or(|label| label.len() <= 1024)
            && input.total_units.is_none_or(|total| total <= 4096),
        "invalid Wiki stage progress facts"
    );
    ensure!(
        input
            .unit_index
            .zip(input.total_units)
            .is_none_or(|(index, total)| index < total),
        "invalid Wiki stage unit ordinal"
    );
    Ok(())
}
fn read_saved(
    connection: &rusqlite::Connection,
    library: &str,
    job: &str,
    address: &WikiPipelineStageAddress,
) -> Result<Option<Saved>> {
    type StoredStageRow = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let row: Option<StoredStageRow>=connection.query_row(
        "SELECT input_fingerprint,binding_json,record_json,raw_response,raw_hash,output_json,output_hash FROM knowledge_pipeline_stages WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",
        params![library,job,address.batch as i64,address.stage_key,address.unit_key], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?;
    row.map(
        |(input, binding, record, raw, raw_hash, output, output_hash)| {
            Ok(Saved {
                input,
                binding: serde_json::from_str(&binding)?,
                record: serde_json::from_str(&record)?,
                raw,
                raw_hash,
                output,
                output_hash,
            })
        },
    )
    .transpose()
}
fn matches(saved: &Saved, input: &WikiStageInput) -> bool {
    saved.input == input.input_fingerprint && saved.binding == input.binding
}
fn write_record(
    connection: &rusqlite::Connection,
    library: &str,
    job: &str,
    record: &Record,
) -> Result<()> {
    connection.execute("UPDATE knowledge_pipeline_stages SET record_json=?6 WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,job,record.address.batch as i64,record.address.stage_key,record.address.unit_key,serde_json::to_string(record)?])?;
    Ok(())
}
fn check_lease(
    connection: &rusqlite::Connection,
    library: &str,
    lease: &WikiJobLease,
) -> Result<()> {
    crate::jobs::require_lease(connection, library, lease)?;
    crate::pages::require_active(connection, library)?;
    crate::source_lifecycle::require_current_source(
        connection,
        library,
        &lease.job.source_id,
        &lease.job.source_revision,
    )
}

impl KnowledgeCatalog {
    /// Rebind only host-recognized prior contract inputs under the same exact
    /// job/evidence/model/page binding. Payloads are still parsed and validated
    /// by current code; this operation never marks an artifact approved.
    pub fn stage_rebind_compatible_input(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        current: &WikiStageInput,
        compatible: &[WikiStageInput],
    ) -> Result<bool> {
        self.read(scope, library)?;
        check_input(current, lease)?;
        ensure!(
            compatible.len() <= 8,
            "too many Wiki contract compatibility inputs"
        );
        for old in compatible {
            check_input(old, lease)?;
        }
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        check_lease(&tx, library, lease)?;
        let purpose: String = tx.query_row(
            "SELECT purpose FROM libraries WHERE id=?1",
            [library],
            |row| row.get(0),
        )?;
        if crate::objects::digest(purpose.as_bytes()) != current.binding.purpose_hash {
            return Ok(false);
        }
        for page in &current.binding.input_page_revisions {
            let revision:Option<String>=tx.query_row("SELECT current_revision FROM knowledge_pages WHERE library_id=?1 AND page_id=?2",params![library,page.page_id],|row|row.get(0)).optional()?;
            if revision.as_deref() != Some(page.revision_id.as_str()) {
                return Ok(false);
            }
        }
        let Some(mut saved) = read_saved(&tx, library, &lease.job.id, &current.binding.address)?
        else {
            return Ok(false);
        };
        if saved.binding != current.binding
            || !(matches(&saved, current)
                || compatible
                    .iter()
                    .any(|old| old.binding == current.binding && matches(&saved, old)))
        {
            return Ok(false);
        }
        let failed = matches!(saved.record.status, Status::Failed | Status::Paused);
        if failed {
            let eligible = matches!(
                saved.record.error_code.as_deref(),
                Some(
                    "wiki_json_schema"
                        | "wiki_json_syntax"
                        | "wiki_json_type"
                        | "wiki_json_eof"
                        | "wiki_evidence_quote_span"
                        | "wiki_evidence_ref_not_supplied"
                        | "wiki_evidence_ref_conflict"
                        | "wiki_evidence_locator_required"
                        | "wiki_evidence_locator_bounds"
                        | "wiki_evidence_locator_conflict"
                )
            );
            if !eligible {
                return Ok(false);
            }
        } else if !matches!(
            saved.record.status,
            Status::Received | Status::Validated | Status::Completed | Status::Running
        ) {
            return Ok(false);
        }
        if let (Some(raw), Some(hash)) = (&saved.raw, &saved.raw_hash) {
            ensure!(
                raw.len() <= crate::WIKI_MAX_OUTPUT_BYTES
                    && crate::objects::digest(raw.as_bytes()) == *hash,
                "Wiki received artifact integrity failure"
            );
            if crate::ingest::complete_json_response(raw).is_err() {
                return Ok(false);
            }
        } else if failed || saved.raw.is_some() != saved.raw_hash.is_some() {
            return Ok(false);
        }
        if let (Some(output), Some(hash)) = (&saved.output, &saved.output_hash) {
            ensure!(
                output.len() <= crate::ingest::WIKI_MAX_PROPOSAL_BYTES
                    && crate::objects::digest(output.as_bytes()) == *hash,
                "Wiki validated artifact integrity failure"
            );
            serde_json::from_str::<serde_json::Value>(output)?;
        } else if saved.output.is_some() != saved.output_hash.is_some() {
            return Ok(false);
        }
        if saved.raw.is_none() && saved.output.is_none() {
            return Ok(false);
        }
        if saved.input == current.input_fingerprint && !failed {
            return Ok(false);
        }
        if failed {
            if let Some(hash) = &saved.output_hash {
                invalidate_descendants(
                    &tx,
                    library,
                    &lease.job.id,
                    current.binding.address.batch,
                    hash,
                    now()?,
                )?;
            }
            tx.execute("UPDATE knowledge_pipeline_stages SET output_json=NULL,output_hash=NULL WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,lease.job.id,current.binding.address.batch as i64,current.binding.address.stage_key,current.binding.address.unit_key])?;
            saved.record.status = Status::Received;
            saved.record.completed_at_ms = None;
            saved.record.completed_units = None;
            saved.record.error_code = None;
            saved.record.error_detail = None;
            saved.record.artifact_hash = saved.raw_hash.clone();
        }
        tx.execute("UPDATE knowledge_pipeline_stages SET input_fingerprint=?6 WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,lease.job.id,current.binding.address.batch as i64,current.binding.address.stage_key,current.binding.address.unit_key,current.input_fingerprint])?;
        saved.record.reused = true;
        saved.record.updated_at_ms = now()?;
        write_record(&tx, library, &lease.job.id, &saved.record)?;
        tx.commit()?;
        Ok(true)
    }
    pub fn job_pipeline_enabled(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
    ) -> Result<bool> {
        self.read(scope, library)?;
        let version: u8 = self.connection.query_row(
            "SELECT pipeline_version FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",
            params![library, job],
            |row| row.get(0),
        )?;
        ensure!(version <= 1, "unsupported Wiki pipeline version");
        Ok(version == 1)
    }
    pub fn stage_begin(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
    ) -> Result<Record> {
        self.read(scope, library)?;
        check_input(input, lease)?;
        let actual_purpose = crate::objects::digest(self.read(scope, library)?.purpose.as_bytes());
        ensure!(
            input.binding.purpose_hash == actual_purpose,
            "Wiki stage purpose changed"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        check_lease(&tx, library, lease)?;
        let old = read_saved(&tx, library, &lease.job.id, &input.binding.address)?;
        let stamp = now()?;
        let mut record = Record {
            address: input.binding.address.clone(),
            status: Status::Running,
            attempt: 1,
            reused: false,
            unit_label: input.unit_label.clone(),
            unit_index: input.unit_index,
            completed_units: None,
            total_units: input.total_units,
            started_at_ms: Some(stamp),
            completed_at_ms: None,
            updated_at_ms: stamp,
            artifact_hash: None,
            error_code: None,
            error_detail: None,
        };
        if let Some(old) = &old {
            record.attempt = old.record.attempt.saturating_add(1);
            if matches(old, input) {
                record = old.record.clone();
                if matches!(record.status, Status::Failed | Status::Paused) {
                    tx.execute("UPDATE knowledge_pipeline_stages SET raw_response=NULL,raw_hash=NULL,output_json=NULL,output_hash=NULL WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,lease.job.id,record.address.batch as i64,record.address.stage_key,record.address.unit_key])?;
                    record.artifact_hash = None;
                    record.completed_units = None;
                }
                record.reused = old.output.is_some()
                    && matches!(record.status, Status::Validated | Status::Completed);
                if !record.reused {
                    record.status = Status::Running;
                    record.attempt = record.attempt.saturating_add(1);
                    record.started_at_ms = Some(stamp);
                    record.completed_at_ms = None;
                    record.error_code = None;
                    record.error_detail = None;
                }
                record.updated_at_ms = stamp;
            } else if let Some(output) = &old.output_hash {
                invalidate_descendants(
                    &tx,
                    library,
                    &lease.job.id,
                    input.binding.address.batch,
                    output,
                    stamp,
                )?;
            }
        } else {
            let count:usize=tx.query_row("SELECT count(*) FROM knowledge_pipeline_stages WHERE library_id=?1 AND job_id=?2 AND batch=?3",params![library,lease.job.id,input.binding.address.batch as i64],|r|r.get(0))?;
            ensure!(count < MAX_STAGE_ROWS, "Wiki stage count exceeds limit");
        }
        if old.as_ref().is_some_and(|saved| matches(saved, input)) {
            write_record(&tx, library, &lease.job.id, &record)?;
        } else {
            tx.execute("INSERT INTO knowledge_pipeline_stages(library_id,job_id,batch,stage_key,unit_key,input_fingerprint,binding_json,record_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(library_id,job_id,batch,stage_key,unit_key) DO UPDATE SET input_fingerprint=excluded.input_fingerprint,binding_json=excluded.binding_json,record_json=excluded.record_json,raw_response=NULL,raw_hash=NULL,output_json=NULL,output_hash=NULL",params![library,lease.job.id,record.address.batch as i64,record.address.stage_key,record.address.unit_key,input.input_fingerprint,serde_json::to_string(&input.binding)?,serde_json::to_string(&record)?])?;
        }
        tx.commit()?;
        Ok(record)
    }

    pub fn stage_received_response(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
    ) -> Result<Option<String>> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let library_info = self.read(scope, library)?;
        if crate::objects::digest(library_info.purpose.as_bytes()) != input.binding.purpose_hash {
            return Ok(None);
        }
        for page in &input.binding.input_page_revisions {
            let revision: Option<String> = tx.query_row(
                "SELECT current_revision FROM knowledge_pages WHERE library_id=?1 AND page_id=?2",
                params![library, page.page_id], |row| row.get(0),
            ).optional()?;
            if revision.as_deref() != Some(page.revision_id.as_str()) {
                return Ok(None);
            }
        }
        check_input(input, lease)?;
        check_lease(&tx, library, lease)?;
        let Some(mut saved) = read_saved(&tx, library, &lease.job.id, &input.binding.address)?
            .filter(|saved| {
                matches(saved, input)
                    && !matches!(
                        saved.record.status,
                        Status::Failed | Status::Paused | Status::NeedsReview
                    )
            })
        else {
            return Ok(None);
        };
        match (saved.raw, saved.raw_hash) {
            (Some(raw), Some(hash)) => {
                ensure!(
                    raw.len() <= crate::WIKI_MAX_OUTPUT_BYTES
                        && crate::objects::digest(raw.as_bytes()) == hash,
                    "Wiki received artifact integrity failure"
                );
                saved.record.reused = true;
                write_record(&tx, library, &lease.job.id, &saved.record)?;
                tx.commit()?;
                Ok(Some(raw))
            }
            (None, None) => Ok(None),
            _ => anyhow::bail!("Wiki received artifact incomplete"),
        }
    }

    pub fn stage_validated_output(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
    ) -> Result<Option<String>> {
        let tx = rusqlite::Transaction::new_unchecked(
            &self.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let library_info = self.read(scope, library)?;
        if crate::objects::digest(library_info.purpose.as_bytes()) != input.binding.purpose_hash {
            return Ok(None);
        }
        for page in &input.binding.input_page_revisions {
            let revision: Option<String> = tx.query_row(
                "SELECT current_revision FROM knowledge_pages WHERE library_id=?1 AND page_id=?2",
                params![library, page.page_id], |row| row.get(0),
            ).optional()?;
            if revision.as_deref() != Some(page.revision_id.as_str()) {
                return Ok(None);
            }
        }
        check_input(input, lease)?;
        check_lease(&tx, library, lease)?;
        let Some(mut saved) = read_saved(&tx, library, &lease.job.id, &input.binding.address)?
            .filter(|saved| {
                matches(saved, input)
                    && matches!(saved.record.status, Status::Validated | Status::Completed)
            })
        else {
            return Ok(None);
        };
        match (saved.output, saved.output_hash) {
            (Some(raw), Some(hash)) => {
                ensure!(
                    raw.len() <= crate::ingest::WIKI_MAX_PROPOSAL_BYTES
                        && crate::objects::digest(raw.as_bytes()) == hash,
                    "Wiki validated artifact integrity failure"
                );
                serde_json::from_str::<serde_json::Value>(&raw)?;
                saved.record.reused = true;
                write_record(&tx, library, &lease.job.id, &saved.record)?;
                tx.commit()?;
                Ok(Some(raw))
            }
            _ => anyhow::bail!("Wiki validated artifact incomplete"),
        }
    }

    /// A successful, non-truncated Provider return can still have invalid JSON.
    /// Keep its exact bytes for a later private repair, without approving them.
    pub fn stage_remember_received(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
        raw: &str,
    ) -> Result<()> {
        self.stage_write_artifact(scope, library, lease, input, raw, Status::Received)
    }
    pub fn stage_mark_validated(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
        raw: &str,
    ) -> Result<()> {
        self.stage_write_artifact(scope, library, lease, input, raw, Status::Validated)
    }
    pub fn stage_mark_completed(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
        raw: &str,
    ) -> Result<()> {
        self.stage_write_artifact(scope, library, lease, input, raw, Status::Completed)
    }
    fn stage_write_artifact(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
        raw: &str,
        status: Status,
    ) -> Result<()> {
        self.read(scope, library)?;
        check_input(input, lease)?;
        ensure!(
            raw.len()
                <= if status == Status::Received {
                    crate::WIKI_MAX_OUTPUT_BYTES
                } else {
                    crate::ingest::WIKI_MAX_PROPOSAL_BYTES
                },
            "Wiki stage artifact exceeds limit"
        );
        if status != Status::Received {
            serde_json::from_str::<serde_json::Value>(raw)?;
        }
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        check_lease(&tx, library, lease)?;
        let mut saved = read_saved(&tx, library, &lease.job.id, &input.binding.address)?
            .filter(|saved| {
                matches(saved, input)
                    && !matches!(
                        saved.record.status,
                        Status::Failed | Status::Paused | Status::NeedsReview
                    )
            })
            .ok_or_else(|| anyhow::anyhow!("Wiki stage input changed or not begun"))?;
        let used:usize=tx.query_row("SELECT coalesce(sum(coalesce(length(CAST(raw_response AS BLOB)),0)+coalesce(length(CAST(output_json AS BLOB)),0)),0) FROM knowledge_pipeline_stages WHERE library_id=?1 AND job_id=?2",params![library,lease.job.id],|r|r.get(0))?;
        let replacing = if status == Status::Received {
            saved.raw.as_ref().map_or(0, String::len)
        } else {
            saved.output.as_ref().map_or(0, String::len)
        };
        ensure!(
            used.saturating_sub(replacing).saturating_add(raw.len()) <= MAX_JOB_ARTIFACT_BYTES,
            "Wiki job artifacts exceed limit"
        );
        let digest = crate::objects::digest(raw.as_bytes());
        if status == Status::Received {
            ensure!(
                !matches!(saved.record.status, Status::Completed | Status::Validated),
                "validated stage cannot regress to received"
            );
            tx.execute("UPDATE knowledge_pipeline_stages SET raw_response=?6,raw_hash=?7 WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,lease.job.id,saved.record.address.batch as i64,saved.record.address.stage_key,saved.record.address.unit_key,raw,digest])?;
        } else {
            tx.execute("UPDATE knowledge_pipeline_stages SET output_json=?6,output_hash=?7 WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,lease.job.id,saved.record.address.batch as i64,saved.record.address.stage_key,saved.record.address.unit_key,raw,digest])?;
        }
        saved.record.status = status;
        saved.record.updated_at_ms = now()?;
        saved.record.artifact_hash = Some(digest);
        if status == Status::Completed {
            saved.record.completed_at_ms = Some(saved.record.updated_at_ms);
            saved.record.completed_units = Some(if input.unit_index.is_some() {
                1
            } else {
                input.total_units.unwrap_or(1)
            });
        }
        write_record(&tx, library, &lease.job.id, &saved.record)?;
        tx.commit()?;
        Ok(())
    }

    pub fn stage_mark_failed(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
        code: &str,
        field: &str,
    ) -> Result<()> {
        ensure!(
            code.len() <= 128
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                && field.len() <= 1024
                && (field.is_empty() || field.starts_with('/')),
            "invalid Wiki stage failure diagnostic"
        );
        self.stage_status(
            scope,
            library,
            lease,
            input,
            Status::Failed,
            Some(code),
            Some(field),
        )
    }
    pub fn stage_mark_waiting(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
    ) -> Result<()> {
        self.stage_status(scope, library, lease, input, Status::Waiting, None, None)
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep owner, stage, evidence, and safe diagnostic fields independently bound"
    )]
    pub fn stage_mark_needs_review(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
        canonical: &str,
        code: &str,
        field: &str,
    ) -> Result<()> {
        ensure!(
            code.len() <= 128
                && code
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                && field.len() <= 1024
                && (field.is_empty() || field.starts_with('/')),
            "invalid Wiki review diagnostic"
        );
        self.stage_write_artifact(scope, library, lease, input, canonical, Status::NeedsReview)?;
        self.stage_status(
            scope,
            library,
            lease,
            input,
            Status::NeedsReview,
            Some(code),
            Some(field),
        )
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep owner, stage, and safe status diagnostics independently bound"
    )]
    fn stage_status(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
        status: Status,
        code: Option<&str>,
        field: Option<&str>,
    ) -> Result<()> {
        self.read(scope, library)?;
        check_input(input, lease)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        check_lease(&tx, library, lease)?;
        let mut saved = read_saved(&tx, library, &lease.job.id, &input.binding.address)?
            .filter(|saved| matches(saved, input))
            .ok_or_else(|| anyhow::anyhow!("Wiki stage input changed or not begun"))?;
        saved.record.status = status;
        if status == Status::Failed && saved.record.reused {
            // A complete cached response that failed current checks is not an
            // endless free retry. Drop it so a later resume can ask for a new
            // response instead of blindly replaying the same rejected bytes.
            if let Some(hash) = &saved.output_hash {
                invalidate_descendants(
                    &tx,
                    library,
                    &lease.job.id,
                    input.binding.address.batch,
                    hash,
                    now()?,
                )?;
            }
            tx.execute("UPDATE knowledge_pipeline_stages SET raw_response=NULL,raw_hash=NULL,output_json=NULL,output_hash=NULL WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,lease.job.id,input.binding.address.batch as i64,input.binding.address.stage_key,input.binding.address.unit_key])?;
            saved.record.artifact_hash = None;
            saved.record.completed_at_ms = None;
            saved.record.completed_units = None;
        }
        saved.record.updated_at_ms = now()?;
        saved.record.reused = false;
        saved.record.error_code = code.map(String::from);
        saved.record.error_detail = field.filter(|value| !value.is_empty()).map(String::from);
        write_record(&tx, library, &lease.job.id, &saved.record)?;
        tx.commit()?;
        Ok(())
    }
    pub fn stage_invalidate_artifacts(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        input: &WikiStageInput,
    ) -> Result<()> {
        self.read(scope, library)?;
        check_input(input, lease)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        check_lease(&tx, library, lease)?;
        if let Some(mut saved) = read_saved(&tx, library, &lease.job.id, &input.binding.address)?
            .filter(|saved| matches(saved, input))
        {
            if let Some(hash) = &saved.output_hash {
                invalidate_descendants(
                    &tx,
                    library,
                    &lease.job.id,
                    input.binding.address.batch,
                    hash,
                    now()?,
                )?;
            }
            saved.record.artifact_hash = None;
            saved.record.reused = false;
            tx.execute("UPDATE knowledge_pipeline_stages SET raw_response=NULL,raw_hash=NULL,output_json=NULL,output_hash=NULL WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,lease.job.id,input.binding.address.batch as i64,input.binding.address.stage_key,input.binding.address.unit_key])?;
            write_record(&tx, library, &lease.job.id, &saved.record)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn pipeline_progress(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        job: &str,
    ) -> Result<Option<WikiPipelineProgress>> {
        self.read(scope, library)?;
        let (source_revision,status,after): (String,String,usize)=self.connection.query_row("SELECT source_revision,status,after_chunk FROM knowledge_jobs WHERE library_id=?1 AND job_id=?2",params![library,job],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let batch: Option<usize> = self.connection.query_row(
            "SELECT max(batch) FROM knowledge_pipeline_stages WHERE library_id=?1 AND job_id=?2",
            params![library, job],
            |r| r.get(0),
        )?;
        let Some(batch) = batch else { return Ok(None) };
        let mut query=self.connection.prepare("SELECT record_json FROM knowledge_pipeline_stages WHERE library_id=?1 AND job_id=?2 AND batch=?3")?;
        let raws = query
            .query_map(params![library, job, batch as i64], |r| {
                r.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            raws.len() <= MAX_STAGE_ROWS,
            "Wiki pipeline record count exceeds limit"
        );
        let mut records = raws
            .into_iter()
            .map(|raw| serde_json::from_str::<Record>(&raw))
            .collect::<serde_json::Result<Vec<_>>>()?;
        records.sort_by_key(|record| {
            (
                order(record.address.stage),
                record.unit_index.unwrap_or(0),
                record.address.stage_key.clone(),
                record.address.unit_key.clone(),
            )
        });
        // A stopped/reclaimed job cannot have a currently running stage, even
        // when cancellation happened before its stage failure was recorded.
        if !matches!(status.as_str(), "running" | "queued") || after > batch {
            for record in &mut records {
                if matches!(
                    record.status,
                    Status::Running | Status::Waiting | Status::Received | Status::Validated
                ) {
                    record.status = match status.as_str() {
                        "failed" => Status::Failed,
                        "awaiting_review" => Status::NeedsReview,
                        _ => Status::Paused,
                    };
                }
            }
        }
        let resume = records
            .iter()
            .find(|record| record.status == Status::Failed)
            .or_else(|| {
                records.iter().find(|record| {
                    matches!(
                        record.status,
                        Status::NeedsReview
                            | Status::Paused
                            | Status::Running
                            | Status::Waiting
                            | Status::Received
                            | Status::Validated
                    )
                })
            });
        let current_stage = resume
            .map(|record| record.address.stage)
            .or_else(|| records.last().map(|record| record.address.stage));
        Ok(Some(WikiPipelineProgress {
            version: 1,
            batch,
            source_revision,
            current_stage,
            resume_stage: resume.map(|record| record.address.clone()),
            records,
        }))
    }
}

fn invalidate_descendants(
    connection: &rusqlite::Connection,
    library: &str,
    job: &str,
    batch: usize,
    changed: &str,
    stamp: u64,
) -> Result<()> {
    let mut query=connection.prepare("SELECT binding_json,record_json,output_hash FROM knowledge_pipeline_stages WHERE library_id=?1 AND job_id=?2 AND batch=?3")?;
    let rows = query
        .query_map(params![library, job, batch as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    let mut changed = BTreeSet::from([changed.to_owned()]);
    let mut invalidated = BTreeSet::new();
    loop {
        let mut advanced = false;
        for (binding, record, output) in &rows {
            let binding: WikiStageBinding = serde_json::from_str(binding)?;
            let key = (
                binding.address.stage_key.clone(),
                binding.address.unit_key.clone(),
            );
            if invalidated.contains(&key)
                || !binding
                    .dependency_hashes
                    .iter()
                    .any(|hash| changed.contains(hash))
            {
                continue;
            }
            let mut record: Record = serde_json::from_str(record)?;
            record.status = Status::Waiting;
            record.reused = false;
            record.completed_at_ms = None;
            record.completed_units = None;
            record.artifact_hash = None;
            record.updated_at_ms = stamp;
            record.error_code = None;
            record.error_detail = None;
            write_record(connection, library, job, &record)?;
            connection.execute("UPDATE knowledge_pipeline_stages SET raw_response=NULL,raw_hash=NULL,output_json=NULL,output_hash=NULL WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,job,batch as i64,key.0,key.1])?;
            invalidated.insert(key);
            if let Some(hash) = output {
                changed.insert(hash.clone());
            }
            advanced = true;
        }
        if !advanced {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod contract_recovery_tests {
    use super::*;
    fn fixture() -> Result<(
        tempfile::TempDir,
        KnowledgeCatalog,
        KnowledgeScope,
        String,
        WikiJobLease,
        WikiStageInput,
    )> {
        let root = tempfile::tempdir()?;
        let mut store = KnowledgeCatalog::open(&root.path().join("wiki.sqlite"))?;
        let scope = KnowledgeScope::from_authenticated_host("owned-contract", "local")?;
        let library = store.create(&scope, "create", "Wiki", "Keep source facts")?;
        let source = store.import_text(
            &scope,
            &library.id,
            "source",
            "Source",
            "Actual immutable evidence",
        )?;
        let job = store.enqueue_ingest(
            &scope,
            &library.id,
            "job",
            &source.source_id,
            &source.revision_id,
            "recipe-0311",
            "en",
        )?;
        let lease = store.claim_job(&scope, &library.id, &job.id)?.unwrap();
        let input = WikiStageInput {
            binding: WikiStageBinding {
                address: WikiPipelineStageAddress {
                    batch: 0,
                    source_revision: source.revision_id,
                    stage_key: "generation".into(),
                    stage: Kind::Generate,
                    unit_key: "topic".into(),
                },
                purpose_hash: crate::objects::digest(library.purpose.as_bytes()),
                recipe_key: lease.job.recipe_key.clone(),
                model_fingerprint: "c".repeat(64),
                dependency_hashes: vec!["d".repeat(64)],
                input_page_revisions: vec![],
            },
            input_fingerprint: "a".repeat(64),
            unit_label: None,
            unit_index: None,
            total_units: None,
        };
        Ok((root, store, scope, library.id, lease, input))
    }
    #[test]
    fn format_failed_raw_is_rebound_before_begin_and_retried_only_once() -> Result<()> {
        let (_root, mut store, scope, library, lease, old) = fixture()?;
        let raw = r#"{"pages":[{"citations":[{"chunkId":"chunk-1","wholeChunk":true}]}]}"#;
        store.stage_begin(&scope, &library, &lease, &old)?;
        store.stage_remember_received(&scope, &library, &lease, &old, raw)?;
        store.stage_mark_failed(&scope, &library, &lease, &old, "wiki_json_schema", "/pages")?;
        let mut current = old.clone();
        current.input_fingerprint = "b".repeat(64);
        assert!(store.stage_rebind_compatible_input(
            &scope,
            &library,
            &lease,
            &current,
            std::slice::from_ref(&old)
        )?);
        store.stage_begin(&scope, &library, &lease, &current)?;
        assert_eq!(
            store
                .stage_received_response(&scope, &library, &lease, &current)?
                .as_deref(),
            Some(raw)
        );
        assert!(
            store
                .stage_validated_output(&scope, &library, &lease, &current)?
                .is_none()
        );
        store.stage_mark_failed(
            &scope,
            &library,
            &lease,
            &current,
            "wiki_evidence_locator_bounds",
            "/pages",
        )?;
        assert!(!store.stage_rebind_compatible_input(
            &scope,
            &library,
            &lease,
            &current,
            std::slice::from_ref(&old)
        )?);
        assert!(
            store
                .stage_received_response(&scope, &library, &lease, &current)?
                .is_none()
        );
        Ok(())
    }
    #[test]
    fn same_contract_format_failure_can_reparse_but_semantic_and_partial_failures_cannot()
    -> Result<()> {
        for (code, raw, allowed) in [
            ("wiki_evidence_quote_span", r#"{"pages":[]}"#, true),
            ("wiki_json_schema", r#"{"pages":[]}"#, true),
            ("wiki_json_eof", r#"{"pages":["#, false),
            ("wiki_support_coverage", r#"{"units":[]}"#, false),
            (
                "wiki_evidence_revision_not_supplied",
                r#"{"pages":[]}"#,
                false,
            ),
            ("wiki_model_output_truncated", r#"{"pages":[]}"#, false),
        ] {
            let (_root, mut store, scope, library, lease, input) = fixture()?;
            store.stage_begin(&scope, &library, &lease, &input)?;
            store.stage_remember_received(&scope, &library, &lease, &input, raw)?;
            store.stage_mark_failed(&scope, &library, &lease, &input, code, "/")?;
            assert_eq!(
                store.stage_rebind_compatible_input(&scope, &library, &lease, &input, &[])?,
                allowed,
                "{code}"
            );
        }
        Ok(())
    }
    #[test]
    fn exact_binding_and_payload_integrity_remain_required_for_contract_rebinding() -> Result<()> {
        let (_root, mut store, scope, library, lease, old) = fixture()?;
        store.stage_begin(&scope, &library, &lease, &old)?;
        store.stage_remember_received(&scope, &library, &lease, &old, r#"{"pages":[]}"#)?;
        let mut current = old.clone();
        current.input_fingerprint = "b".repeat(64);
        let mut changed = current.clone();
        changed.binding.model_fingerprint = "e".repeat(64);
        assert!(!store.stage_rebind_compatible_input(
            &scope,
            &library,
            &lease,
            &changed,
            std::slice::from_ref(&old)
        )?);
        let mut changed = current.clone();
        changed.binding.dependency_hashes = vec!["f".repeat(64)];
        assert!(!store.stage_rebind_compatible_input(
            &scope,
            &library,
            &lease,
            &changed,
            std::slice::from_ref(&old)
        )?);
        let foreign = KnowledgeScope::from_authenticated_host("foreign", "local")?;
        assert!(
            store
                .stage_rebind_compatible_input(
                    &foreign,
                    &library,
                    &lease,
                    &current,
                    std::slice::from_ref(&old)
                )
                .is_err()
        );
        store.connection.execute(
            "UPDATE knowledge_pipeline_stages SET raw_hash=?1 WHERE library_id=?2",
            params!["0".repeat(64), library],
        )?;
        assert!(
            store
                .stage_rebind_compatible_input(
                    &scope,
                    &library,
                    &lease,
                    &current,
                    std::slice::from_ref(&old)
                )
                .is_err()
        );
        Ok(())
    }
}
