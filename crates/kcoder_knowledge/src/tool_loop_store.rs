//! Private, lease-bound persistence of file-contract tool-loop steps. A step is
//! stored as `received` immediately after a complete provider response (before
//! any parsing) and becomes `applied` after its tools ran deterministically.
//! Steps never appear in public job/pipeline records.
use crate::{KnowledgeCatalog, KnowledgeScope, WikiJobLease, WikiToolStep};
use anyhow::{Result, ensure};
use rusqlite::params;

const MAX_STEP_BYTES: usize = crate::WIKI_MAX_OUTPUT_BYTES;
const MAX_STEPS_PER_LOOP: usize = 64;
const MAX_JOB_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
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
    pub fn tool_steps_load(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        loop_key: &str,
    ) -> Result<Vec<WikiToolStep>> {
        self.read(scope, library)?;
        check_lease(&self.connection, library, lease)?;
        let mut query = self.connection.prepare("SELECT step,input_fingerprint,response_json,response_hash,tool_results_json,tree_hash,read_revisions_json,status FROM knowledge_tool_loop_steps WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND loop_key=?4 ORDER BY step")?;
        let steps = query
            .query_map(
                params![
                    library,
                    lease.job.id,
                    lease.job.after_chunk as i64,
                    loop_key
                ],
                |row| {
                    Ok(WikiToolStep {
                        loop_key: loop_key.to_owned(),
                        step: row.get::<_, i64>(0)? as usize,
                        input_fingerprint: row.get(1)?,
                        response_json: row.get(2)?,
                        response_hash: row.get(3)?,
                        tool_results_json: row.get(4)?,
                        tree_hash: row.get(5)?,
                        read_revisions_json: row.get(6)?,
                        applied: row.get::<_, String>(7)? == "applied",
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        // A corrupt or reordered row is never replayed; recovery stops before it.
        let mut valid = Vec::new();
        for (expected, step) in steps.into_iter().enumerate() {
            if step.step != expected
                || crate::objects::digest(step.response_json.as_bytes()) != step.response_hash
            {
                break;
            }
            valid.push(step);
        }
        Ok(valid)
    }

    pub fn tool_step_save(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        step: &WikiToolStep,
    ) -> Result<()> {
        self.read(scope, library)?;
        ensure!(
            !step.loop_key.is_empty()
                && step.loop_key.len() <= 128
                && step.step < MAX_STEPS_PER_LOOP
                && valid_hash(&step.input_fingerprint)
                && valid_hash(&step.response_hash)
                && step.tree_hash.as_deref().is_none_or(valid_hash)
                && crate::objects::digest(step.response_json.as_bytes()) == step.response_hash,
            "invalid Wiki tool step"
        );
        ensure!(
            step.response_json.len() <= MAX_STEP_BYTES
                && step
                    .tool_results_json
                    .as_ref()
                    .is_none_or(|value| value.len() <= MAX_STEP_BYTES)
                && step.read_revisions_json.len() <= 64 * 1024,
            "Wiki tool step exceeds limit"
        );
        ensure!(
            step.applied == step.tool_results_json.is_some(),
            "Wiki tool step state mismatch"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        check_lease(&tx, library, lease)?;
        let batch = lease.job.after_chunk as i64;
        let previous: i64 = tx.query_row(
            "SELECT count(*) FROM knowledge_tool_loop_steps WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND loop_key=?4 AND step<?5",
            params![library, lease.job.id, batch, step.loop_key, step.step as i64],
            |row| row.get(0),
        )?;
        ensure!(
            previous as usize == step.step,
            "Wiki tool step is not contiguous"
        );
        let stages: i64 = tx.query_row("SELECT coalesce(sum(coalesce(length(CAST(raw_response AS BLOB)),0)+coalesce(length(CAST(output_json AS BLOB)),0)),0) FROM knowledge_pipeline_stages WHERE library_id=?1 AND job_id=?2",params![library,lease.job.id],|row|row.get(0))?;
        let steps: i64 = tx.query_row("SELECT coalesce(sum(length(CAST(response_json AS BLOB))+coalesce(length(CAST(tool_results_json AS BLOB)),0)),0) FROM knowledge_tool_loop_steps WHERE library_id=?1 AND job_id=?2 AND NOT (batch=?3 AND loop_key=?4 AND step=?5)",params![library,lease.job.id,batch,step.loop_key,step.step as i64],|row|row.get(0))?;
        let own = step.response_json.len() + step.tool_results_json.as_ref().map_or(0, String::len);
        ensure!(
            (stages as usize)
                .saturating_add(steps as usize)
                .saturating_add(own)
                <= MAX_JOB_ARTIFACT_BYTES,
            "Wiki job artifacts exceed limit"
        );
        tx.execute("INSERT INTO knowledge_tool_loop_steps(library_id,job_id,batch,loop_key,step,input_fingerprint,response_json,response_hash,tool_results_json,tree_hash,read_revisions_json,status,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) ON CONFLICT(library_id,job_id,batch,loop_key,step) DO UPDATE SET input_fingerprint=excluded.input_fingerprint,response_json=excluded.response_json,response_hash=excluded.response_hash,tool_results_json=excluded.tool_results_json,tree_hash=excluded.tree_hash,read_revisions_json=excluded.read_revisions_json,status=excluded.status,updated_at_ms=excluded.updated_at_ms",params![library,lease.job.id,batch,step.loop_key,step.step as i64,step.input_fingerprint,step.response_json,step.response_hash,step.tool_results_json,step.tree_hash,step.read_revisions_json,if step.applied {"applied"} else {"received"},crate::jobs::now_ms()?])?;
        tx.commit()?;
        Ok(())
    }

    pub fn tool_steps_discard(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        loop_key: &str,
        from_step: usize,
    ) -> Result<()> {
        self.read(scope, library)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        check_lease(&tx, library, lease)?;
        tx.execute("DELETE FROM knowledge_tool_loop_steps WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND loop_key=?4 AND step>=?5",params![library,lease.job.id,lease.job.after_chunk as i64,loop_key,from_step as i64])?;
        tx.commit()?;
        Ok(())
    }

    /// Public counters on the generation stage record of the current batch.
    pub fn stage_record_tool_counters(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &WikiJobLease,
        stage_key: &str,
        turns: u32,
        calls: u32,
    ) -> Result<()> {
        self.read(scope, library)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        check_lease(&tx, library, lease)?;
        let rows: Vec<(String, String)> = tx
            .prepare("SELECT unit_key,record_json FROM knowledge_pipeline_stages WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4")?
            .query_map(params![library,lease.job.id,lease.job.after_chunk as i64,stage_key],|row|Ok((row.get(0)?,row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (unit, raw) in rows {
            let mut record: kcoder_types::wiki_pipeline::WikiPipelineStageRecord =
                serde_json::from_str(&raw)?;
            record.tool_turns = Some(turns);
            record.tool_calls = Some(calls);
            tx.execute("UPDATE knowledge_pipeline_stages SET record_json=?6 WHERE library_id=?1 AND job_id=?2 AND batch=?3 AND stage_key=?4 AND unit_key=?5",params![library,lease.job.id,lease.job.after_chunk as i64,stage_key,unit,serde_json::to_string(&record)?])?;
        }
        tx.commit()?;
        Ok(())
    }
}
