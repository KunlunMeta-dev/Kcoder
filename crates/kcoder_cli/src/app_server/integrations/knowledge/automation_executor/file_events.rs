//! Read-only observations of explicitly selected ordinary files through held native handles.
use super::*;
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use sha2::{Digest, Sha256};
use std::{ffi::OsString, io::Read, time::UNIX_EPOCH};

const MAX_SELECTED_FILES: usize = 32;
const MAX_FILE_BYTES: usize = 1024 * 1024;

struct SelectedFile {
    resource_ref: String,
    name: OsString,
    identity: PortableLeaseIdentity,
}
/// Native configuration only. Paths, file contents and authorization cannot be supplied by RPC.
pub struct ApprovedFileEventSource {
    owner: KnowledgeOwner,
    source_ref: String,
    directory: PrivateDirectory,
    directory_identity: String,
    selected: Vec<SelectedFile>,
}
impl ApprovedFileEventSource {
    pub(crate) fn source_ref(&self) -> &str {
        &self.source_ref
    }
    pub(crate) fn resource_refs(&self) -> impl Iterator<Item = &str> {
        self.selected
            .iter()
            .map(|selected| selected.resource_ref.as_str())
    }
    /// Current native identity only; this does not grant a directory read.
    pub(crate) fn verify_selected_identity(&self, scope: &IntegrationScope) -> Result<()> {
        ensure!(
            self.owner == KnowledgeOwner::from(scope)
                && self.directory.directory_identity()? == self.directory_identity,
            "AUTOMATION_EVENT_SOURCE_CHANGED"
        );
        for selected in &self.selected {
            let file = self
                .directory
                .open_single_link_regular_file(&selected.name)?;
            ensure!(
                PortableLeaseIdentity::from_regular_handle(&file)? == selected.identity,
                "AUTOMATION_EVENT_OBJECT_CHANGED"
            );
        }
        Ok(())
    }
    /// The host must first authorize this held directory and each selected resource reference.
    /// No source directory is created or scanned recursively, and no schedule is installed.
    pub fn from_authorized_files(
        scope: &IntegrationScope,
        source_ref: &str,
        directory: PrivateDirectory,
        selections: Vec<(String, OsString)>,
    ) -> Result<Self> {
        scope.validate()?;
        ensure!(
            !source_ref.trim().is_empty() && source_ref.len() <= 256,
            "AUTOMATION_EVENT_SOURCE_INVALID"
        );
        ensure!(
            !selections.is_empty() && selections.len() <= MAX_SELECTED_FILES,
            "AUTOMATION_EVENT_SOURCE_LIMIT"
        );
        let directory_identity = directory.directory_identity()?;
        let mut selected = Vec::new();
        let mut references = std::collections::BTreeSet::new();
        for (resource_ref, name) in selections {
            ensure!(
                !resource_ref.trim().is_empty()
                    && resource_ref.len() <= 256
                    && references.insert(resource_ref.clone()),
                "AUTOMATION_EVENT_RESOURCE_INVALID"
            );
            let file = directory
                .open_single_link_regular_file(&name)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_EVENT_FILE_UNAVAILABLE"))?;
            let identity = PortableLeaseIdentity::from_regular_handle(&file)
                .map_err(|_| anyhow::anyhow!("AUTOMATION_EVENT_FILE_UNAVAILABLE"))?;
            ensure!(
                file.metadata()?.len() <= MAX_FILE_BYTES as u64,
                "AUTOMATION_EVENT_FILE_TOO_LARGE"
            );
            selected.push(SelectedFile {
                resource_ref,
                name,
                identity,
            });
        }
        Ok(Self {
            owner: scope.into(),
            source_ref: source_ref.into(),
            directory,
            directory_identity,
            selected,
        })
    }

    fn observe(&self, selection: &SelectedFile) -> Result<FileObservation> {
        ensure!(
            self.directory.directory_identity()? == self.directory_identity,
            "AUTOMATION_EVENT_SOURCE_CHANGED"
        );
        let file = self
            .directory
            .open_single_link_regular_file(&selection.name)
            .map_err(|_| anyhow::anyhow!("AUTOMATION_EVENT_FILE_UNAVAILABLE"))?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&file)? == selection.identity,
            "AUTOMATION_EVENT_OBJECT_CHANGED"
        );
        let before = file.metadata()?;
        ensure!(
            before.len() <= MAX_FILE_BYTES as u64,
            "AUTOMATION_EVENT_FILE_TOO_LARGE"
        );
        let modified = before
            .modified()
            .map_err(|_| anyhow::anyhow!("AUTOMATION_EVENT_TIME_UNAVAILABLE"))?;
        let nanos = modified
            .duration_since(UNIX_EPOCH)
            .map_err(|_| anyhow::anyhow!("AUTOMATION_EVENT_TIME_UNAVAILABLE"))?
            .as_nanos();
        let occurred_at_ms = u64::try_from(nanos / 1_000_000)
            .map_err(|_| anyhow::anyhow!("AUTOMATION_EVENT_TIME_UNAVAILABLE"))?;
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_FILE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() <= MAX_FILE_BYTES,
            "AUTOMATION_EVENT_FILE_TOO_LARGE"
        );
        let after = file.metadata()?;
        let current = self
            .directory
            .open_single_link_regular_file(&selection.name)
            .map_err(|_| anyhow::anyhow!("AUTOMATION_EVENT_FILE_UNAVAILABLE"))?;
        ensure!(
            PortableLeaseIdentity::from_regular_handle(&file)? == selection.identity
                && PortableLeaseIdentity::from_regular_handle(&current)? == selection.identity
                && before.len() == after.len()
                && before.len() == bytes.len() as u64
                && after.modified()? == modified,
            "AUTOMATION_EVENT_OBJECT_CHANGED"
        );
        let content_revision = format!("sha256:{:x}", Sha256::digest(&bytes));
        let event_id = format!(
            "file-{:x}",
            Sha256::digest(serde_json::to_vec(&json!({
                "owner":self.owner,"source":self.source_ref,"resource":selection.resource_ref,
                "identity":selection.identity,"modifiedNanos":nanos.to_string(),"revision":content_revision
            }))?)
        );
        Ok(FileObservation {
            event_id,
            occurred_at_ms,
            facts: json!({"kind":"selected_file_revision",
            "sourceRef":self.source_ref,"resourceRef":selection.resource_ref,
            "contentRevision":content_revision,"byteLength":bytes.len(),"occurredAtMs":occurred_at_ms}),
        })
    }
}
struct FileObservation {
    event_id: String,
    occurred_at_ms: u64,
    facts: Value,
}

/// One bounded pass on the existing scheduler tick. The first explicit observation processes
/// the current selected revision; subsequent identical revisions and restart replays are inert.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub async fn process_selected_file_events(
    template: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    workflows: &WorkflowStore,
    port: &dyn KnowledgeDependencyPort,
    source: &ApprovedFileEventSource,
    originating_subscription: Option<&str>,
    causation_depth: u8,
    cancel: &CancellationToken,
) -> Result<Vec<IntegrationReply>> {
    process_selected_file_events_bounded(
        template,
        ctx,
        store,
        workflows,
        port,
        source,
        originating_subscription,
        causation_depth,
        cancel,
        MAX_SELECTED_FILES,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn process_selected_file_events_bounded(
    template: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &AutomationStore,
    workflows: &WorkflowStore,
    port: &dyn KnowledgeDependencyPort,
    source: &ApprovedFileEventSource,
    originating_subscription: Option<&str>,
    causation_depth: u8,
    cancel: &CancellationToken,
    remaining: usize,
) -> Result<Vec<IntegrationReply>> {
    let limit = remaining.min(MAX_SELECTED_FILES);
    if limit == 0 {
        return Ok(vec![]);
    }
    ensure!(
        source.owner == *store.owner() && source.owner == KnowledgeOwner::from(ctx.scope),
        "AUTOMATION_SCOPE_MISMATCH"
    );
    let mut replies = Vec::new();
    let subscriptions = store.event_subscriptions(&source.source_ref)?;
    if subscriptions.is_empty() || cancel.is_cancelled() {
        return Ok(replies);
    }
    for selection in &source.selected {
        if cancel.is_cancelled() || replies.len() >= limit {
            break;
        }
        let resource = KnowledgeResource {
            kind: "automation-file-source",
            id: selection.resource_ref.clone(),
            owner: source.owner.clone(),
        };
        ctx.check(template, false, "automation.event_source.read", &resource)?;
        let observed = source.observe(selection)?;
        ctx.check(template, false, "automation.event_source.read", &resource)?;
        for subscription in &subscriptions {
            if cancel.is_cancelled() || replies.len() >= limit {
                break;
            }
            let Some(sequence) = store.next_event_sequence(
                &subscription.draft.id,
                subscription.revision,
                &source.source_ref,
                &observed.event_id,
            )?
            else {
                continue;
            };
            let proof = ApprovedSubscriptionTrigger::from_native_event(
                ctx.scope,
                subscription,
                &source.source_ref,
                &observed.event_id,
                sequence,
                observed.occurred_at_ms,
                originating_subscription,
                causation_depth,
            )?;
            let payload = serde_json::to_value(proof.params(observed.facts.clone()))?;
            let operation_id = format!(
                "file-trigger-{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    &subscription.owner,
                    &subscription.draft.id,
                    subscription.revision,
                    &observed.event_id
                ))?)
            );
            let request = child_request(template, Some(&operation_id), payload)?;
            let result = trigger_approved_subscription(
                &request, ctx, store, workflows, port, &proof, cancel,
            )
            .await;
            ctx.check(template, false, "automation.event_source.read", &resource)?;
            replies.push(result);
        }
    }
    Ok(replies)
}

#[cfg(test)]
mod tests;
