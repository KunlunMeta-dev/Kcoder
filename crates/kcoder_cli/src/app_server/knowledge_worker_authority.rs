//! One actual durable Wiki claim, captured through its original Root ticket.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, WikiJob, WikiJobLease,
    integrations::knowledge::CatalogReadLimits,
};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_types::integrations::core::IntegrationScope;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{ffi::OsStr, path::Path};
use tokio_util::sync::CancellationToken;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginalJob {
    library_id: String,
    job_id: String,
    source_id: String,
    source_revision: String,
    recipe_key: String,
}
fn original(library: &str, job: &WikiJob) -> OriginalJob {
    OriginalJob {
        library_id: library.into(),
        job_id: job.id.clone(),
        source_id: job.source_id.clone(),
        source_revision: job.source_revision.clone(),
        recipe_key: job.recipe_key.clone(),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ticket {
    version: u32,
    receipt_id: String,
    sha256: String,
    scope: IntegrationScope,
    workspace_path: std::path::PathBuf,
    job: OriginalJob,
    #[serde(default)]
    current_claim_fingerprint: Option<String>,
}
pub fn authorize_enqueue(
    capture_scope: impl FnOnce() -> Result<NativeIntegrationContext>,
) -> Result<()> {
    if !NativeIntegrationContext::organization_launch_required()? {
        return Ok(());
    }
    let context = capture_scope()?;
    let resource = resource(&context)?;
    for action in ["read", "write"] {
        context.authorize_organization_resource(
            action,
            &resource,
            &uuid::Uuid::new_v4().to_string(),
        )?;
    }
    Ok(())
}
pub fn queued_jobs() -> Result<Option<Vec<(String, String)>>> {
    if !NativeIntegrationContext::organization_launch_required()? {
        return Ok(None);
    }
    let raw = NativeIntegrationContext::wiki_worker_request(json!({"operation":"wiki.jobs"}))?;
    let tickets: Vec<Ticket> = serde_json::from_value(raw["items"].clone())?;
    let mut jobs = Vec::new();
    for ticket in tickets {
        let allowed = NativeIntegrationContext::wiki_worker_request(
            json!({"operation":"wiki.job.preflight","job":ticket.job}),
        );
        if allowed.is_ok() {
            jobs.push((ticket.job.library_id, ticket.job.job_id));
        }
    }
    Ok(Some(jobs))
}
pub fn bind_enqueued(
    capture_scope: impl FnOnce() -> Result<NativeIntegrationContext>,
    library: &str,
    job: &WikiJob,
) -> Result<()> {
    if !NativeIntegrationContext::organization_launch_required()? {
        return Ok(());
    }
    let context = capture_scope()?;
    let resource = resource(&context)?;
    for action in ["read", "write"] {
        context.authorize_organization_resource(
            action,
            &resource,
            &uuid::Uuid::new_v4().to_string(),
        )?;
    }
    context.bind_wiki_job(serde_json::to_value(original(library, job))?)?;
    Ok(())
}
fn resource(context: &NativeIntegrationContext) -> Result<String> {
    use sha2::{Digest, Sha256};
    let s = context.scope();
    Ok(format!(
        "knowledge:{:x}",
        Sha256::digest(serde_json::to_vec(&(
            "native-knowledge-resource-v1",
            "knowledge",
            &s.account_id,
            &s.target_id,
            &s.workspace_id,
            &s.organization_id,
            "current-target"
        ))?)
    ))
}
/// This holder has no serde/Debug surface. A ticket is correlation metadata;
/// only its live Root peer, held directories and actual store claim authorize work.
#[derive(Debug)]
pub(super) struct ResourceAuthorityChanged(anyhow::Error);
impl std::fmt::Display for ResourceAuthorityChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("WIKI_ORGANIZATION_JOB_AUTHORITY_CHANGED")
    }
}
impl std::error::Error for ResourceAuthorityChanged {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}
pub(super) struct WikiJobAuthority<'a> {
    context: NativeIntegrationContext,
    library: String,
    lease: &'a WikiJobLease,
    principal: String,
    ticket_receipt_id: String,
    ticket_sha256: String,
    directory: PrivateDirectory,
}
impl<'a> WikiJobAuthority<'a> {
    pub(super) fn bind_original(
        profile: &Path,
        library: &str,
        lease: &'a WikiJobLease,
    ) -> Result<Option<Self>> {
        if !NativeIntegrationContext::organization_launch_required()? {
            return Ok(None);
        }
        let request = json!({"operation":"wiki.job.open","job":original(library,&lease.job),"claimFingerprint":lease.claim_fingerprint()});
        let raw = NativeIntegrationContext::wiki_worker_request(request)?;
        let ticket: Ticket = serde_json::from_value(raw)?;
        ensure!(
            ticket.version == 1
                && ticket.sha256.len() == 64
                && ticket.sha256.bytes().all(|v| v.is_ascii_hexdigit()),
            "WIKI_ORGANIZATION_JOB_TICKET_INVALID"
        );
        ensure!(
            serde_json::to_value(&ticket.job)?
                == serde_json::to_value(original(library, &lease.job))?,
            "WIKI_ORGANIZATION_JOB_CHANGED"
        );
        let context = NativeIntegrationContext::capture_existing(
            profile,
            &ticket.workspace_path,
            "wiki-worker",
            &ticket.scope.target_revision,
        )?;
        context.validate_scope(&ticket.scope)?;
        let principal =
            uuid::Uuid::parse_str(&std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID")?)?.to_string();
        let directory = context
            .profile()?
            .open_child(OsStr::new("knowledge"), false)?;
        let value = Self {
            context,
            library: library.into(),
            lease,
            principal,
            ticket_receipt_id: ticket.receipt_id,
            ticket_sha256: ticket.sha256,
            directory,
        };
        if let Err(error) = value.check_current() {
            value.record_diagnostic(&error);
            return Err(error);
        }
        Ok(Some(value))
    }
    pub(super) fn context(&self) -> &NativeIntegrationContext {
        &self.context
    }
    /// Persist only a fixed host-authored diagnostic category in the original
    /// held namespace. Error text, model inputs and credentials are excluded.
    pub(super) fn record_diagnostic(&self, error: &anyhow::Error) {
        let category = authority_diagnostic(error);
        let result = (|| -> Result<()> {
            self.context.verify()?;
            ensure!(
                self.context
                    .profile()?
                    .open_child(OsStr::new("knowledge"), false)?
                    .directory_identity()?
                    == self.directory.directory_identity()?,
                "WIKI_ORGANIZATION_JOB_STORE_CHANGED"
            );
            self.directory.atomic_replace(
                OsStr::new("worker-diagnostic.json"),
                json!({"stage":"job_authority","errorType":category})
                    .to_string()
                    .as_bytes(),
            )?;
            Ok(())
        })();
        let _ = result;
    }
    pub(super) fn job(&self) -> &WikiJob {
        &self.lease.job
    }
    pub(super) fn claim_fingerprint(&self) -> String {
        self.lease.claim_fingerprint()
    }
    pub(super) fn ticket_receipt_id(&self) -> &str {
        &self.ticket_receipt_id
    }
    pub(super) fn ticket_sha256(&self) -> &str {
        &self.ticket_sha256
    }
    fn request(&self, operation: &str) -> Result<Ticket> {
        let raw = NativeIntegrationContext::wiki_worker_request(json!({"operation":operation,
            "job":original(&self.library,&self.lease.job),"claimFingerprint":self.claim_fingerprint()}))?;
        let ticket: Ticket = serde_json::from_value(raw)?;
        ensure!(
            ticket.receipt_id == self.ticket_receipt_id && ticket.sha256 == self.ticket_sha256,
            "WIKI_ORGANIZATION_JOB_TICKET_CHANGED"
        );
        self.context.validate_scope(&ticket.scope)?;
        Ok(ticket)
    }
    fn read_claim<T>(
        &self,
        read: impl Fn(&KnowledgeCatalog, &KnowledgeScope) -> Result<T>,
    ) -> Result<T> {
        // A live ordinary SQLite writer can briefly invalidate a readonly
        // snapshot while committing. Re-observe the same held directory; never
        // switch paths, repair storage, renew a claim or infer success.
        retry_source_observation(|| self.read_claim_once(&read))
    }
    fn read_claim_once<T>(
        &self,
        read: &impl Fn(&KnowledgeCatalog, &KnowledgeScope) -> Result<T>,
    ) -> Result<T> {
        self.context.verify()?;
        ensure!(
            self.context
                .profile()?
                .open_child(OsStr::new("knowledge"), false)?
                .directory_identity()?
                == self.directory.directory_identity()?,
            "WIKI_ORGANIZATION_JOB_STORE_CHANGED"
        );
        let reader = KnowledgeCatalog::open_existing_native_directory(
            self.directory.duplicate_handle()?,
            OsStr::new("state.sqlite"),
            OsStr::new("state.objects"),
            &CancellationToken::new(),
            CatalogReadLimits::default(),
        )?;
        let scope = KnowledgeScope::from_authenticated_host(&self.principal, "execution-host")?;
        let (value, _) = reader.with_catalog(|catalog| read(catalog, &scope))?;
        Ok(value)
    }
    pub(super) fn check_original_claim(&self) -> Result<()> {
        self.request("wiki.job.observe")?;
        self.read_claim(|catalog, scope| {
            let job = catalog.read_job(scope, &self.library, &self.lease.job.id)?;
            ensure!(
                job.source_id == self.lease.job.source_id
                    && job.source_revision == self.lease.job.source_revision
                    && job.recipe_key == self.lease.job.recipe_key,
                "WIKI_ORGANIZATION_JOB_CHANGED"
            );
            // The root claim record persists after this worker stops/finishes
            // the lease, allowing only its already dispatched cost observation.
            if job.status == "running" {
                let ticket = self.request("wiki.job.observe")?;
                if ticket.current_claim_fingerprint.as_deref()
                    == Some(self.claim_fingerprint().as_str())
                {
                    catalog.verify_job_lease(scope, &self.library, self.lease)?;
                }
            }
            Ok(())
        })
    }
    pub(super) fn check_current(&self) -> Result<()> {
        (|| -> Result<()> {
            let ticket = self.request("wiki.job.current")?;
            ensure!(
                ticket.current_claim_fingerprint.as_deref()
                    == Some(self.claim_fingerprint().as_str()),
                "WIKI_ORGANIZATION_JOB_CLAIM_CHANGED"
            );
            self.read_claim(|catalog, scope| {
                catalog.verify_job_lease(scope, &self.library, self.lease)
            })?;
            // The source observation may have overlapped a policy update.
            let current = self.request("wiki.job.current")?;
            ensure!(
                current.current_claim_fingerprint.as_deref()
                    == Some(self.claim_fingerprint().as_str()),
                "WIKI_ORGANIZATION_JOB_CLAIM_CHANGED"
            );
            Ok(())
        })()
        .map_err(|error| ResourceAuthorityChanged(error).into())
    }
    pub(super) fn terminal_status(&self) -> Result<Option<String>> {
        self.check_original_claim()?;
        let ticket = self.request("wiki.job.observe")?;
        if ticket.current_claim_fingerprint.as_deref() != Some(self.claim_fingerprint().as_str()) {
            return Ok(None);
        }
        self.read_claim(|catalog, scope| {
            let job = catalog.read_job(scope, &self.library, &self.lease.job.id)?;
            if job.status == "queued" && job.after_chunk > self.lease.job.after_chunk {
                return Ok(Some("batch_completed".into()));
            }
            Ok(matches!(
                job.status.as_str(),
                "completed" | "paused" | "failed" | "cancelled" | "awaiting_review"
            )
            .then_some(job.status))
        })
    }
}

fn retry_source_observation<T>(mut read: impl FnMut() -> Result<T>) -> Result<T> {
    for attempt in 0..5 {
        match read() {
            Ok(value) => return Ok(value),
            Err(error)
                if attempt < 4
                    && matches!(
                        error.to_string().as_str(),
                        "knowledge_catalog_source_busy" | "source_sqlite_recovery_required"
                    ) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the final source observation always returns")
}

fn authority_diagnostic(error: &anyhow::Error) -> &'static str {
    for cause in error.chain() {
        match cause.to_string().as_str() {
            "knowledge_catalog_source_busy" | "source_sqlite_recovery_required" => {
                return "source_snapshot_unavailable";
            }
            "Wiki job lease lost" => return "claim_inactive",
            "WIKI_ORGANIZATION_JOB_CLAIM_CHANGED" => return "claim_changed",
            "ORGANIZATION_RESOURCE_DENIED" | "KNOWLEDGE_RESOURCE_DENIED" => {
                return "resource_denied";
            }
            "WIKI_ORGANIZATION_JOB_STORE_CHANGED" => return "store_changed",
            _ => {}
        }
    }
    "authority_unavailable"
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;
    #[test]
    fn diagnostic_contains_only_fixed_categories() {
        assert_eq!(
            authority_diagnostic(&anyhow::anyhow!("knowledge_catalog_source_busy")),
            "source_snapshot_unavailable"
        );
        assert_eq!(
            authority_diagnostic(&anyhow::anyhow!("Wiki job lease lost")),
            "claim_inactive"
        );
        assert_eq!(
            authority_diagnostic(&anyhow::anyhow!("private-path-or-secret")),
            "authority_unavailable"
        );
    }

    #[test]
    fn snapshot_retry_is_bounded_and_never_retries_an_identity_or_claim_failure() {
        let mut calls = 0;
        let value = retry_source_observation(|| {
            calls += 1;
            if calls < 3 {
                anyhow::bail!("knowledge_catalog_source_busy")
            }
            Ok(17)
        })
        .unwrap();
        assert_eq!(value, 17);
        assert_eq!(calls, 3);
        let mut calls = 0;
        assert!(
            retry_source_observation::<()>(|| {
                calls += 1;
                anyhow::bail!("source_sqlite_recovery_required")
            })
            .is_err()
        );
        assert_eq!(calls, 5);
        for cause in [
            "Wiki job lease lost",
            "WIKI_ORGANIZATION_JOB_STORE_CHANGED",
            "ORGANIZATION_RESOURCE_DENIED",
        ] {
            let mut calls = 0;
            assert!(
                retry_source_observation::<()>(|| {
                    calls += 1;
                    Err(anyhow::anyhow!(cause))
                })
                .is_err()
            );
            assert_eq!(calls, 1);
        }
    }
}
