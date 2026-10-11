//! Private original/response artifacts and fenced, explicitly resumed image extraction.
use crate::{
    KnowledgeCatalog, KnowledgeScope, SourceChunk, SourceRevision, WikiTokenUsage, objects::digest,
};
use anyhow::{Context, Result, ensure};
use kcoder_types::knowledge::WikiImageImport;
use rusqlite::{Connection, OptionalExtension, params};

pub struct ImageImportInput<'a> {
    pub key: &'a str,
    pub title: &'a str,
    pub original: &'a [u8],
    pub mime: &'a str,
    pub source: Option<&'a str>,
    pub expected_revision: Option<&'a str>,
}
#[derive(Clone)]
pub struct ImageImportLease {
    pub id: String,
    pub token: String,
}
pub struct ImageImportOriginal {
    pub key: String,
    pub title: String,
    pub original: Vec<u8>,
    pub mime: String,
    pub source: Option<String>,
    pub expected_revision: Option<String>,
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
impl KnowledgeCatalog {
    pub fn accept_image_import(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        input: &ImageImportInput<'_>,
    ) -> Result<WikiImageImport> {
        ensure!(
            !self.read(scope, library)?.archived,
            "knowledge library is archived"
        );
        ensure!(
            !input.key.is_empty() && input.key.len() <= 128,
            "invalid request key"
        );
        ensure!(
            !input.title.trim().is_empty() && input.title.chars().count() <= 240,
            "invalid source title"
        );
        ensure!(input.original.len() <= 10 * 1024 * 1024, "file_too_large");
        ensure!(
            input.source.is_some() == input.expected_revision.is_some(),
            "source update requires both sourceId and expectedRevision"
        );
        ensure!(
            matches!(input.mime, "image/png" | "image/jpeg" | "image/webp"),
            "unsupported image MIME"
        );
        let raw_hash = digest(input.original);
        let fingerprint = digest(&serde_json::to_vec(&serde_json::json!([
            "image-import-v1",
            library,
            input.title,
            raw_hash,
            input.mime,
            input.source,
            input.expected_revision
        ]))?);
        // Objects are private, fsynced and hash-checked before accepting the durable identity.
        self.objects.put_bytes(library, input.original)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        let previous: Option<(String,String)> = tx.query_row("SELECT id,fingerprint FROM knowledge_image_imports WHERE library_id=?1 AND request_key=?2",params![library,input.key],|row|Ok((row.get(0)?,row.get(1)?))).optional()?;
        let id = if let Some((id, previous)) = previous {
            ensure!(previous == fingerprint, "idempotency conflict");
            id
        } else {
            if let (Some(source), Some(expected)) = (input.source, input.expected_revision) {
                // Earlier releases already committed this request without an import-stage receipt.
                let replayed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_sources s JOIN knowledge_originals o ON s.library_id=o.library_id AND s.source_id=o.source_id AND s.revision_id=o.revision_id WHERE s.library_id=?1 AND s.request_key=?2 AND s.source_id=?3 AND s.title=?4 AND o.raw_hash=?5 AND o.format='image')",params![library,input.key,source,input.title,raw_hash],|row|row.get(0))?;
                if !replayed {
                    crate::source_lifecycle::require_current_source(
                        &tx, library, source, expected,
                    )?;
                }
            }
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute("INSERT INTO knowledge_image_imports(library_id,id,request_key,fingerprint,title,original_hash,mime,source_id,expected_revision,status,phase,updated_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'accepted','interpretation',?10)",params![library,id,input.key,fingerprint,input.title,raw_hash,input.mime,input.source,input.expected_revision,now()])?;
            id
        };
        tx.commit()?;
        self.read_image_import(scope, library, &id)
    }
    pub fn adopt_image_import_result(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
        source: &SourceRevision,
    ) -> Result<()> {
        self.read_image_import(scope, library, id)?;
        self.connection.execute("UPDATE knowledge_image_imports SET status='completed',phase='commit',result_source_id=?3,result_revision_id=?4,updated_at_ms=?5 WHERE library_id=?1 AND id=?2 AND status='accepted'", params![library,id,source.source_id,source.revision_id,now()])?;
        Ok(())
    }
    pub fn reject_image_import(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
        code: &str,
    ) -> Result<()> {
        self.read_image_import(scope, library, id)?;
        self.connection.execute("UPDATE knowledge_image_imports SET status='failed',error_code=?3,updated_at_ms=?4 WHERE library_id=?1 AND id=?2 AND status='accepted'",params![library,id,code,now()])?;
        Ok(())
    }
    pub fn read_image_import(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
    ) -> Result<WikiImageImport> {
        self.read(scope, library)?;
        // Expiry records interruption; it never queues another paid call.
        self.connection.execute("UPDATE knowledge_image_imports SET status='failed',error_code='interrupted',lease_token=NULL,lease_until_ms=0,updated_at_ms=?3 WHERE library_id=?1 AND id=?2 AND status='running' AND lease_until_ms<=?3",params![library,id,now()])?;
        let mut result = self.connection.query_row("SELECT id,title,status,phase,model,result_source_id,result_revision_id,error_code,call_limit,text_bytes,reasoning_bytes,updated_at_ms,request_key FROM knowledge_image_imports WHERE library_id=?1 AND id=?2",params![library,id],|r| Ok(WikiImageImport { id:r.get(0)?,idempotency_key:r.get(12)?,title:r.get(1)?,status:r.get(2)?,phase:r.get(3)?,model:r.get(4)?,source_id:r.get(5)?,revision_id:r.get(6)?,error_code:r.get(7)?,call_limit:r.get(8)?,text_bytes:r.get::<_,i64>(9)? as usize,reasoning_bytes:r.get::<_,i64>(10)? as usize,updated_at_ms:r.get::<_,i64>(11)? as u64,reserved_calls:0,usage_reported_calls:0,unknown_usage_calls:0,input_tokens:None,output_tokens:None })).optional()?.context("image import not found")?;
        let (calls,reported,input,output):(u32,u32,Option<u64>,Option<u64>) = self.connection.query_row("SELECT COUNT(*),COUNT(input_tokens),SUM(input_tokens),SUM(output_tokens) FROM knowledge_image_import_calls WHERE library_id=?1 AND import_id=?2",params![library,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
        result.reserved_calls = calls;
        result.usage_reported_calls = reported;
        result.unknown_usage_calls = calls - reported;
        result.input_tokens = input;
        result.output_tokens = output;
        Ok(result)
    }
    pub fn list_image_imports(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        after: Option<&str>,
    ) -> Result<Vec<WikiImageImport>> {
        self.read(scope, library)?;
        let ids = self.connection.prepare("SELECT id FROM knowledge_image_imports WHERE library_id=?1 AND id>?2 ORDER BY id LIMIT 100")?.query_map(params![library,after.unwrap_or("")],|row|row.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter()
            .map(|id| self.read_image_import(scope, library, id))
            .collect()
    }
    pub fn image_import_original(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
    ) -> Result<ImageImportOriginal> {
        self.read_image_import(scope, library, id)?;
        let (key,title,hash,mime,source,expected):(String,String,String,String,Option<String>,Option<String>) = self.connection.query_row("SELECT request_key,title,original_hash,mime,source_id,expected_revision FROM knowledge_image_imports WHERE library_id=?1 AND id=?2",params![library,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
        Ok(ImageImportOriginal {
            key,
            title,
            original: self.objects.read_bytes(library, &hash)?,
            mime,
            source,
            expected_revision: expected,
        })
    }
    #[allow(clippy::too_many_arguments)]
    pub fn claim_image_import(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
        resume: bool,
        additional_calls: u32,
        model: &str,
        recipe: &str,
    ) -> Result<ImageImportLease> {
        let public = self.read_image_import(scope, library, id)?;
        ensure!(
            matches!(public.status.as_str(), "accepted" | "failed"),
            "image import is running, completed or cancelled"
        );
        ensure!(
            public.status == "accepted" || resume,
            "image_import_resume_required"
        );
        ensure!(
            additional_calls <= 1,
            "authorize at most one additional vision call"
        );
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        crate::pages::require_active(&tx, library)?;
        let (status,response,previous_recipe,source,expected,limit):(String,Option<String>,Option<String>,Option<String>,Option<String>,u32)=tx.query_row("SELECT status,response_hash,recipe,source_id,expected_revision,call_limit FROM knowledge_image_imports WHERE library_id=?1 AND id=?2",params![library,id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?)))?;
        ensure!(status == public.status, "image import owner changed");
        if let (Some(source), Some(expected)) = (source, expected) {
            crate::source_lifecycle::require_current_source(&tx, library, &source, &expected)?;
        }
        let lease = ImageImportLease {
            id: id.into(),
            token: uuid::Uuid::new_v4().to_string(),
        };
        let limit = limit.saturating_add(additional_calls);
        ensure!(limit <= 4096, "image import budget limit exceeded");
        if response.is_none() {
            ensure!(
                previous_recipe
                    .as_deref()
                    .is_none_or(|previous| previous == recipe),
                "image_import_model_changed: retry requires the original vision configuration"
            );
            let used:u32=tx.query_row("SELECT COUNT(*) FROM knowledge_image_import_calls WHERE library_id=?1 AND import_id=?2",params![library,id],|r|r.get(0))?;
            ensure!(used < limit, "image_import_budget_exceeded");
            tx.execute("INSERT INTO knowledge_image_import_calls(library_id,import_id,call_id,lease_token) VALUES(?1,?2,?3,?4)",params![library,id,uuid::Uuid::new_v4().to_string(),lease.token])?;
        }
        tx.execute("UPDATE knowledge_image_imports SET status='running',phase=CASE WHEN response_hash IS NULL THEN 'interpretation' ELSE phase END,model=COALESCE(model,?4),recipe=COALESCE(recipe,?5),lease_token=?3,lease_until_ms=?6,call_limit=?7,error_code=NULL,updated_at_ms=?8 WHERE library_id=?1 AND id=?2",params![library,id,lease.token,model,recipe,now()+150_000,limit,now()])?;
        tx.commit()?;
        Ok(lease)
    }
    pub fn check_image_import_lease(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &ImageImportLease,
    ) -> Result<()> {
        self.read(scope, library)?;
        require_lease(&self.connection, library, lease)
    }
    pub fn progress_image_import(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &ImageImportLease,
        text: usize,
        reasoning: usize,
    ) -> Result<()> {
        self.read(scope, library)?;
        require_lease(&self.connection, library, lease)?;
        self.connection.execute("UPDATE knowledge_image_imports SET text_bytes=?4,reasoning_bytes=?5,updated_at_ms=?6 WHERE library_id=?1 AND id=?2 AND lease_token=?3",params![library,lease.id,lease.token,text as i64,reasoning as i64,now()])?;
        Ok(())
    }
    pub fn receive_image_response(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &ImageImportLease,
        response: &str,
        usage: Option<WikiTokenUsage>,
    ) -> Result<()> {
        self.read(scope, library)?;
        ensure!(
            response.len() <= crate::WIKI_MAX_OUTPUT_BYTES,
            "image response exceeds limit"
        );
        // Durably save the entire completed response before any text/chunk validation.
        let hash = self.objects.put(library, response)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        require_lease(&tx, library, lease)?;
        record_usage(&tx, library, lease, usage)?;
        tx.execute("UPDATE knowledge_image_imports SET response_hash=?4,phase='validation',text_bytes=?5,updated_at_ms=?6 WHERE library_id=?1 AND id=?2 AND lease_token=?3",params![library,lease.id,lease.token,hash,response.len() as i64,now()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn image_response(
        &self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &ImageImportLease,
    ) -> Result<Option<String>> {
        self.read(scope, library)?;
        require_lease(&self.connection, library, lease)?;
        let hash: Option<String> = self.connection.query_row(
            "SELECT response_hash FROM knowledge_image_imports WHERE library_id=?1 AND id=?2",
            params![library, lease.id],
            |r| r.get(0),
        )?;
        hash.map(|hash| self.objects.read(library, &hash))
            .transpose()
    }
    pub fn fail_image_import(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &ImageImportLease,
        code: &str,
        usage: Option<WikiTokenUsage>,
    ) -> Result<()> {
        self.read(scope, library)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        require_lease(&tx, library, lease)?;
        record_usage(&tx, library, lease, usage)?;
        tx.execute("UPDATE knowledge_image_imports SET status='failed',error_code=?4,lease_token=NULL,lease_until_ms=0,updated_at_ms=?5 WHERE library_id=?1 AND id=?2 AND lease_token=?3",params![library,lease.id,lease.token,code,now()])?;
        tx.commit()?;
        Ok(())
    }
    pub fn cancel_image_import(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        id: &str,
    ) -> Result<()> {
        self.read_image_import(scope, library, id)?;
        self.connection.execute("UPDATE knowledge_image_imports SET status='cancelled',error_code='cancelled',lease_token=NULL,lease_until_ms=0,updated_at_ms=?3 WHERE library_id=?1 AND id=?2 AND status!='completed'",params![library,id,now()])?;
        Ok(())
    }
    pub fn pause_image_imports(&mut self, scope: &KnowledgeScope) -> Result<()> {
        self.connection.execute("UPDATE knowledge_image_imports SET status='failed',error_code='organization_disabled',lease_token=NULL,lease_until_ms=0,updated_at_ms=?3 WHERE status IN ('accepted','running') AND library_id IN(SELECT id FROM libraries WHERE principal=?1 AND target=?2)",params![scope.principal,scope.target,now()])?;
        Ok(())
    }
    pub fn commit_image_import(
        &mut self,
        scope: &KnowledgeScope,
        library: &str,
        lease: &ImageImportLease,
        chunks: Vec<SourceChunk>,
        report: &serde_json::Value,
    ) -> Result<SourceRevision> {
        let input = self.image_import_original(scope, library, &lease.id)?;
        require_lease(&self.connection, library, lease)?;
        ensure!(
            self.image_response(scope, library, lease)?.is_some(),
            "image interpretation response not received"
        );
        self.connection.execute("UPDATE knowledge_image_imports SET phase='commit',updated_at_ms=?4 WHERE library_id=?1 AND id=?2 AND lease_token=?3",params![library,lease.id,lease.token,now()])?;
        self.import_source_revision_report_guarded(
            scope,
            library,
            &input.key,
            &input.title,
            &input.original,
            "image",
            chunks,
            input
                .source
                .as_deref()
                .zip(input.expected_revision.as_deref()),
            Some(report),
            Some(lease),
        )
    }
}
pub(crate) fn require_lease(
    connection: &Connection,
    library: &str,
    lease: &ImageImportLease,
) -> Result<()> {
    let valid:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM knowledge_image_imports WHERE library_id=?1 AND id=?2 AND lease_token=?3 AND status='running' AND lease_until_ms>?4)",params![library,lease.id,lease.token,now()],|r|r.get(0))?;
    ensure!(valid, "image import owner changed or was cancelled");
    Ok(())
}
fn record_usage(
    connection: &Connection,
    library: &str,
    lease: &ImageImportLease,
    usage: Option<WikiTokenUsage>,
) -> Result<()> {
    let input = usage
        .as_ref()
        .map(|u| u.input_tokens.min(i64::MAX as u64) as i64);
    let output = usage
        .as_ref()
        .map(|u| u.output_tokens.min(i64::MAX as u64) as i64);
    connection.execute("UPDATE knowledge_image_import_calls SET completed=1,input_tokens=COALESCE(?4,input_tokens),output_tokens=COALESCE(?5,output_tokens) WHERE library_id=?1 AND import_id=?2 AND lease_token=?3",params![library,lease.id,lease.token,input,output])?;
    Ok(())
}
pub(crate) fn finish(
    connection: &Connection,
    library: &str,
    lease: &ImageImportLease,
    source: &SourceRevision,
) -> Result<()> {
    require_lease(connection, library, lease)?;
    connection.execute("UPDATE knowledge_image_imports SET status='completed',phase='commit',lease_token=NULL,lease_until_ms=0,result_source_id=?4,result_revision_id=?5,updated_at_ms=?6 WHERE library_id=?1 AND id=?2 AND lease_token=?3",params![library,lease.id,lease.token,source.source_id,source.revision_id,now()])?;
    Ok(())
}
