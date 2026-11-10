mod child;
mod continuation;
mod lease;
mod saved_directory;
use super::super::task_capability_scope_control::{
    NativeTaskCapabilityScopeControlPhase, NativeTaskCapabilityScopeControlReceipt,
};
use super::*;
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, PrivateLeaseMode};
use lease::binding_lease;
use std::{collections::BTreeMap, fs::File, io::Read, sync::Arc};

// These filenames identify existing native scope records and stay stable across the internal rename.
const LOCK: &str = "task-sources.lock";
const HEADER: &str = "task-sources-owner.json";
const INDEX: &str = "task-sources-index.json";
const MAX_RECORD_BYTES: u64 = 512 * 1024;
const MAX_BINDINGS: usize = 512;
const MAX_CHANGES: usize = 256;

#[cfg(test)]
thread_local! {
    static INDEX_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn index_reads() -> usize {
    INDEX_READS.get()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    version: u32,
    owner: IntegrationOwner,
    lock_identity: PortableLeaseIdentity,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    intent: String,
    snapshot: IntegrationTaskCapabilityScopeSnapshot,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Birth {
    operation_id: String,
    intent: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    operation_id: String,
    sources: Vec<IntegrationTaskCapabilitySourceChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    resource_bindings: Option<Vec<IntegrationTaskResourceBinding>>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u32,
    accepted: AcceptedData,
    snapshot: IntegrationTaskCapabilityScopeSnapshot,
    pending: Option<Pending>,
    receipts: BTreeMap<String, Receipt>,
    #[serde(default)]
    children: BTreeMap<String, child::ChildSourceIntent>,
    #[serde(default)]
    controls: BTreeMap<String, NativeTaskCapabilityScopeControlReceipt>,
}

pub(crate) struct NativeTaskCapabilityScopeBindingStore {
    guard: NativeDomainGuard,
    owner: IntegrationOwner,
    lock_identity: PortableLeaseIdentity,
    lock_anchor: File,
}
pub(crate) struct NativeTaskCapabilityScopeBinding {
    pub(super) store: Arc<NativeTaskCapabilityScopeBindingStore>,
    pub(super) accepted: NativeAcceptedTaskIdentity,
}
impl NativeTaskCapabilityScopeBindingStore {
    pub(crate) fn observe(context: &NativeIntegrationContext) -> Result<Option<Self>> {
        let Some(guard) = NativeDomainGuard::observe(
            context.profile()?,
            context.scope(),
            NativeDomain::ConnectivityTaskCapabilityScope,
        )?
        else {
            return Ok(None);
        };
        Self::from_guard(context, guard).map(Some)
    }
    /// Authorized first native metadata write only. No task or model is created.
    pub(crate) fn initialize(
        context: &NativeIntegrationContext,
        operation_id: &str,
    ) -> Result<Self> {
        let (guard, ()) = NativeDomainGuard::initialize(
            context.profile()?,
            context.scope(),
            NativeDomain::ConnectivityTaskCapabilityScope,
            operation_id,
            |directory| {
                let lock = directory.open_read_write_file(OsStr::new(LOCK), true)?;
                lock.sync_all()?;
                directory.atomic_replace(
                    OsStr::new(HEADER),
                    &serde_json::to_vec(&Header {
                        version: 1,
                        owner: IntegrationOwner::from(context.scope()),
                        lock_identity: directory.portable_regular_handle_identity(&lock)?,
                    })?,
                )?;
                directory.atomic_replace(OsStr::new(INDEX), b"{}")
            },
        )?;
        Self::from_guard(context, guard)
    }
    fn from_guard(context: &NativeIntegrationContext, guard: NativeDomainGuard) -> Result<Self> {
        let directory = guard.directory(context.profile()?)?;
        let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
        let lock_identity = directory.portable_regular_handle_identity(&lock_anchor)?;
        let _lease = binding_lease(&directory, &lock_identity, PrivateLeaseMode::Shared)?;
        let header: Header = serde_json::from_slice(
            &read_bytes(&directory, HEADER)?
                .context("TASK_CAPABILITY_SCOPE_BINDING_HEADER_REQUIRED")?,
        )?;
        ensure!(
            header.version == 1
                && header.owner == IntegrationOwner::from(context.scope())
                && header.lock_identity == lock_identity,
            "TASK_CAPABILITY_SCOPE_BINDING_OWNER_CHANGED"
        );
        read_index(&directory)?;
        Ok(Self {
            guard,
            owner: header.owner,
            lock_identity,
            lock_anchor,
        })
    }
    fn directory(&self, context: &NativeIntegrationContext) -> Result<PrivateDirectory> {
        ensure!(
            self.owner == IntegrationOwner::from(context.scope()),
            "TASK_CAPABILITY_SCOPE_BINDING_OWNER_CHANGED"
        );
        let directory = self.guard.directory(context.profile()?)?;
        ensure!(
            directory.portable_regular_handle_identity(&self.lock_anchor)? == self.lock_identity
                && directory.portable_regular_identity(OsStr::new(LOCK))? == self.lock_identity,
            "TASK_CAPABILITY_SCOPE_BINDING_LOCK_CHANGED"
        );
        let header: Header = serde_json::from_slice(
            &read_bytes(&directory, HEADER)?
                .context("TASK_CAPABILITY_SCOPE_BINDING_HEADER_REQUIRED")?,
        )?;
        ensure!(
            header.version == 1
                && header.owner == self.owner
                && header.lock_identity == self.lock_identity,
            "TASK_CAPABILITY_SCOPE_BINDING_OWNER_CHANGED"
        );
        // Record and directory readers validate the index under their shared
        // or exclusive lease; do not reopen it here before that lease exists.
        Ok(directory)
    }
    pub(crate) async fn restore(
        self: &Arc<Self>,
        context: &NativeIntegrationContext,
        key: &str,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<Option<NativeTaskCapabilityScopeBinding>> {
        atom(key)?;
        let directory = self.directory(context)?;
        let _lease = binding_lease(&directory, &self.lock_identity, PrivateLeaseMode::Shared)?;
        let Some(record) = read_record(&directory, key)? else {
            return Ok(None);
        };
        drop(_lease);
        let accepted = NativeAcceptedTaskIdentity::restore(context, record.accepted, facts).await?;
        ensure!(
            accepted.task_key()? == key,
            "TASK_CAPABILITY_SCOPE_BINDING_KEY_CHANGED"
        );
        Ok(Some(NativeTaskCapabilityScopeBinding {
            store: self.clone(),
            accepted,
        }))
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Native Accepted, management/source facts and boundary witnesses stay explicit rather than inferred from request labels"
    )]
    pub(crate) async fn bind_accepted(
        self: &Arc<Self>,
        context: &NativeIntegrationContext,
        accepted: NativeAcceptedTaskIdentity,
        operation_id: &str,
        selection: IntegrationTaskCapabilityScopeSelection,
        catalog: &NativeConnectivitySourceCatalog,
        source_registration: Option<&str>,
        facts: &dyn NativeTaskCapabilityScopeFacts,
        admission: &NativeTaskCapabilityScopeCallback<'_>,
    ) -> Result<NativeTaskCapabilityScopeBinding> {
        atom(operation_id)?;
        selection.validate()?;
        accepted.verify(context, facts).await?;
        facts
            .authorize_selection(context, &accepted, operation_id, &selection)
            .await?;
        let execution = facts
            .execution_for_callback(
                context,
                &accepted,
                admission,
                NativeTaskCapabilityScopeCallbackPurpose::Admission,
            )
            .await?;
        accepted.check_execution(context, admission.session_id, &execution, true)?;
        ensure!(
            execution.current_session_id == accepted.thread_id() && execution.lineage.is_empty(),
            "TASK_CAPABILITY_SCOPE_ROOT_BOUNDARY_REQUIRED"
        );
        facts.verify_safe_boundary(context, &accepted, &execution)?;
        let key = accepted.task_key()?;
        let intent = digest(&serde_json::json!(["initial", key, selection]))?;
        if let Some(old) = self.read_change(context, &key, operation_id, &intent)? {
            ensure!(
                old.thread_id == accepted.thread_id(),
                "TASK_CAPABILITY_SCOPE_BINDING_THREAD_CHANGED"
            );
            return Ok(NativeTaskCapabilityScopeBinding {
                store: self.clone(),
                accepted,
            });
        }
        let source_facts = if selection.mode == IntegrationTaskCapabilityScopeMode::None {
            Vec::new()
        } else {
            facts
                .sources(context)
                .await
                .context("TASK_CAPABILITY_SCOPE_BIND_SOURCES")?
        };
        // Registration is explicit, but shares this admission's observation.
        // The accepted binding below still records an empty source ceiling.
        if let Some(operation) = source_registration
            && !source_facts.is_empty()
        {
            catalog.register(context, operation, &source_facts)?;
        }
        let sources = if matches!(&accepted.data.origin, AcceptedOrigin::Studio)
            && selection.mode == IntegrationTaskCapabilityScopeMode::InheritCurrent
        {
            catalog.current_choices_for_studio(context, &source_facts)?
        } else {
            resolve_selection(context, catalog, &selection, &source_facts)?
        };
        accepted.verify(context, facts).await?;
        facts
            .authorize_selection(context, &accepted, operation_id, &selection)
            .await?;
        facts.verify_safe_boundary(context, &accepted, &execution)?;
        let directory = self.directory(context)?;
        let _lease = binding_lease(&directory, &self.lock_identity, PrivateLeaseMode::Exclusive)?;
        let mut index = read_index(&directory)?;
        if let Some(existing) = read_record_with_index(&directory, &key, &index)? {
            ensure!(
                existing.accepted == accepted.data,
                "TASK_CAPABILITY_SCOPE_BINDING_ACCEPTED_CHANGED"
            );
            let receipt = existing
                .receipts
                .get(operation_id)
                .context("TASK_CAPABILITY_SCOPE_BINDING_ALREADY_EXISTS")?;
            ensure!(
                receipt.intent == intent,
                "TASK_CAPABILITY_SCOPE_CHANGE_CONFLICT"
            );
        } else {
            ensure!(
                !index.contains_key(&key),
                "TASK_CAPABILITY_SCOPE_BINDING_OUTCOME_UNKNOWN"
            );
            ensure!(
                directory.count_regular_files_bounded(
                    |name| name.to_string_lossy().starts_with("source-binding-"),
                    MAX_BINDINGS + 1
                )? < MAX_BINDINGS,
                "TASK_CAPABILITY_SCOPE_BINDING_CAPACITY"
            );
            let snapshot = IntegrationTaskCapabilityScopeSnapshot {
                thread_id: accepted.thread_id().into(),
                revision: 1,
                selection,
                effective_sources: sources,
                effective_from: IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot,
                resource_bindings: None,
                effective_resource_bindings: None,
            };
            let record = Record {
                version: 1,
                accepted: accepted.data.clone(),
                snapshot: snapshot.clone(),
                pending: None,
                receipts: BTreeMap::from([(operation_id.into(), Receipt { intent, snapshot })]),
                children: BTreeMap::new(),
                controls: BTreeMap::new(),
            };
            index.insert(
                key.clone(),
                Birth {
                    operation_id: operation_id.into(),
                    intent: record.receipts[operation_id].intent.clone(),
                },
            );
            directory.atomic_replace(OsStr::new(INDEX), &serde_json::to_vec(&index)?)?;
            write_record(&directory, &key, &record)?;
        }
        Ok(NativeTaskCapabilityScopeBinding {
            store: self.clone(),
            accepted,
        })
    }
    fn read_change(
        &self,
        context: &NativeIntegrationContext,
        key: &str,
        operation: &str,
        intent: &str,
    ) -> Result<Option<IntegrationTaskCapabilityScopeSnapshot>> {
        let directory = self.directory(context)?;
        let _lease = binding_lease(&directory, &self.lock_identity, PrivateLeaseMode::Shared)?;
        let Some(record) = read_record(&directory, key)? else {
            return Ok(None);
        };
        if let Some(receipt) = record.receipts.get(operation) {
            ensure!(
                receipt.intent == intent,
                "TASK_CAPABILITY_SCOPE_CHANGE_CONFLICT"
            );
            Ok(Some(receipt.snapshot.clone()))
        } else {
            Ok(None)
        }
    }
}
impl NativeTaskCapabilityScopeBinding {
    /// Read only the original protected binding for a child catalog hint.
    /// No model, admission or transport effect is authorized by this snapshot.
    pub(crate) fn child_tool_snapshot(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<IntegrationTaskCapabilityScopeSnapshot> {
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Shared,
        )?;
        let record = read_record(&directory, &self.task_key()?)?
            .context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data,
            "TASK_CAPABILITY_SCOPE_BINDING_ACCEPTED_CHANGED"
        );
        Ok(record.snapshot)
    }
    pub(crate) fn task_key(&self) -> Result<String> {
        self.accepted.task_key()
    }
    pub(crate) fn accepted(&self) -> &NativeAcceptedTaskIdentity {
        &self.accepted
    }
    pub(crate) fn pending_control_operation(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<Option<String>> {
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Shared,
        )?;
        let record = read_record(&directory, &self.task_key()?)?
            .context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data,
            "TASK_CAPABILITY_SCOPE_BINDING_ACCEPTED_CHANGED"
        );
        Ok(record.pending.map(|pending| pending.operation_id))
    }
    pub(crate) async fn snapshot(
        &self,
        context: &NativeIntegrationContext,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<IntegrationTaskCapabilityScopeSnapshot> {
        self.accepted.verify(context, facts).await?;
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Shared,
        )?;
        let record = read_record(&directory, &self.task_key()?)?
            .context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data,
            "TASK_CAPABILITY_SCOPE_BINDING_ACCEPTED_CHANGED"
        );
        Ok(record.snapshot)
    }
    #[cfg(test)]
    pub(crate) async fn stage_selection(
        &self,
        context: &NativeIntegrationContext,
        operation_id: &str,
        expected_revision: u64,
        selection: IntegrationTaskCapabilityScopeSelection,
        catalog: &NativeConnectivitySourceCatalog,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<IntegrationTaskCapabilityScopeSnapshot> {
        self.stage_selection_with_resources(
            context,
            operation_id,
            expected_revision,
            selection,
            None,
            catalog,
            facts,
        )
        .await
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "Keep the native operation/CAS and independent source/resource selections explicit"
    )]
    pub(crate) async fn stage_selection_with_resources(
        &self,
        context: &NativeIntegrationContext,
        operation_id: &str,
        expected_revision: u64,
        selection: IntegrationTaskCapabilityScopeSelection,
        resource_bindings: Option<Vec<IntegrationTaskResourceBinding>>,
        catalog: &NativeConnectivitySourceCatalog,
        facts: &dyn NativeTaskCapabilityScopeFacts,
    ) -> Result<IntegrationTaskCapabilityScopeSnapshot> {
        atom(operation_id)?;
        selection.validate()?;
        if let Some(bindings) = &resource_bindings {
            ensure!(bindings.len() <= 64, "TASK_RESOURCE_BINDING_LIMIT");
            for binding in bindings {
                binding.validate()?;
            }
            facts
                .authorize_resource_selection(context, &self.accepted, operation_id, bindings)
                .await?;
        }
        self.accepted.verify(context, facts).await?;
        facts
            .authorize_selection(context, &self.accepted, operation_id, &selection)
            .await?;
        let key = self.task_key()?;
        let intent = if resource_bindings.is_none() {
            digest(&serde_json::json!([
                "stage",
                key,
                expected_revision,
                selection
            ]))?
        } else {
            digest(&serde_json::json!([
                "stage-resources-v1",
                key,
                expected_revision,
                selection,
                resource_bindings
            ]))?
        };
        if let Some(original) = self
            .store
            .read_change(context, &key, operation_id, &intent)?
        {
            return Ok(original);
        }
        let source_facts = if selection.mode == IntegrationTaskCapabilityScopeMode::None {
            Vec::new()
        } else {
            facts.sources(context).await?
        };
        let sources = resolve_selection(context, catalog, &selection, &source_facts)?;
        self.accepted.verify(context, facts).await?;
        facts
            .authorize_selection(context, &self.accepted, operation_id, &selection)
            .await?;
        let admission = facts
            .selection_admission(context, &self.accepted, operation_id, &selection)
            .await?;
        if let Some(bindings) = &resource_bindings {
            ensure!(
                bindings
                    .iter()
                    .all(|binding| sources.contains(&binding.source)),
                "TASK_RESOURCE_SOURCE_NOT_SELECTED"
            );
            facts
                .authorize_resource_selection(context, &self.accepted, operation_id, bindings)
                .await?;
        }
        admission
            .receipt()
            .verify_native(context, &self.accepted, operation_id, &selection)?;
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?;
        let mut record =
            read_record(&directory, &key)?.context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data,
            "TASK_CAPABILITY_SCOPE_BINDING_ACCEPTED_CHANGED"
        );
        if let Some(receipt) = record.receipts.get(operation_id) {
            ensure!(
                receipt.intent == intent,
                "TASK_CAPABILITY_SCOPE_CHANGE_CONFLICT"
            );
            return Ok(receipt.snapshot.clone());
        }
        ensure!(
            record.snapshot.revision == expected_revision,
            "TASK_CAPABILITY_SCOPE_REVISION_CONFLICT"
        );
        ensure!(
            record.receipts.len() < MAX_CHANGES,
            "TASK_CAPABILITY_SCOPE_CHANGE_CAPACITY"
        );
        let previous = if let Some(pending) = &record.pending {
            let original = record
                .controls
                .get_mut(&pending.operation_id)
                .context("TASK_CAPABILITY_SCOPE_LEGACY_PENDING_AUTHORITY_UNKNOWN")?;
            ensure!(
                matches!(
                    original.phase,
                    NativeTaskCapabilityScopeControlPhase::PendingBoundary
                ),
                "TASK_CAPABILITY_SCOPE_PENDING_CONTROL_CONFLICT"
            );
            original.phase = NativeTaskCapabilityScopeControlPhase::Superseded;
            original.reason_code = Some("TASK_CAPABILITY_SCOPE_CHANGE_SUPERSEDED".into());
            let mut previous = original.previous.clone();
            previous.revision = record.snapshot.revision;
            previous
        } else {
            record.snapshot.clone()
        };
        ensure!(
            record.controls.len() < MAX_CHANGES,
            "TASK_CAPABILITY_SCOPE_CONTROL_CAPACITY"
        );
        record.version =
            if resource_bindings.is_some() || record.snapshot.resource_bindings.is_some() {
                4
            } else {
                record.version.max(3)
            };
        record.snapshot.revision = expected_revision
            .checked_add(1)
            .context("TASK_CAPABILITY_SCOPE_REVISION_LIMIT")?;
        record.snapshot.selection = selection;
        record.snapshot.resource_bindings = resource_bindings
            .clone()
            .or_else(|| previous.resource_bindings.clone());
        record.snapshot.effective_from = IntegrationTaskCapabilityScopeBoundary::NextToolBoundary;
        record.pending = Some(Pending {
            operation_id: operation_id.into(),
            sources,
            resource_bindings,
        });
        record.controls.insert(
            operation_id.into(),
            NativeTaskCapabilityScopeControlReceipt {
                operation_id: operation_id.into(),
                intent_sha256: intent.clone(),
                authorization: admission
                    .receipt()
                    .bind_fixed_sources(&record.pending.as_ref().unwrap().sources)?
                    .bind_resource_bindings(
                        record
                            .pending
                            .as_ref()
                            .unwrap()
                            .resource_bindings
                            .as_deref(),
                    )?,
                previous,
                requested: record.snapshot.clone(),
                phase: NativeTaskCapabilityScopeControlPhase::PendingBoundary,
                applied_revision: None,
                reason_code: None,
            },
        );
        record.receipts.insert(
            operation_id.into(),
            Receipt {
                intent,
                snapshot: record.snapshot.clone(),
            },
        );
        if write_record(&directory, &key, &record).is_err() {
            let current = read_record(&directory, &key)?
                .context("TASK_CAPABILITY_SCOPE_CONTROL_OUTCOME_UNKNOWN")?;
            ensure!(
                current.controls.get(operation_id) == record.controls.get(operation_id),
                "TASK_CAPABILITY_SCOPE_CONTROL_OUTCOME_UNKNOWN"
            );
        }
        Ok(record.snapshot)
    }
    pub(crate) async fn commit_boundary(
        &self,
        context: &NativeIntegrationContext,
        operation_id: &str,
        expected_revision: u64,
        facts: &dyn NativeTaskCapabilityScopeFacts,
        boundary: &NativeTaskCapabilityScopeCallback<'_>,
    ) -> Result<IntegrationTaskCapabilityScopeSnapshot> {
        atom(operation_id)?;
        self.accepted.verify(context, facts).await?;
        let execution = facts
            .execution_for_callback(
                context,
                &self.accepted,
                boundary,
                NativeTaskCapabilityScopeCallbackPurpose::SourceBoundary,
            )
            .await?;
        self.accepted
            .check_execution(context, boundary.session_id, &execution, false)?;
        ensure!(
            execution.lineage.is_empty()
                && execution.current_session_id == self.accepted.thread_id(),
            "TASK_CAPABILITY_SCOPE_ROOT_BOUNDARY_REQUIRED"
        );
        facts.verify_safe_boundary(context, &self.accepted, &execution)?;
        let key = self.task_key()?;
        let intent = digest(&serde_json::json!(["commit", key, expected_revision]))?;
        if let Some(original) = self
            .store
            .read_change(context, &key, operation_id, &intent)?
        {
            return Ok(original);
        }
        let (pending, control, staged) = {
            let directory = self.store.directory(context)?;
            let _lease = binding_lease(
                &directory,
                &self.store.lock_identity,
                PrivateLeaseMode::Shared,
            )?;
            let record =
                read_record(&directory, &key)?.context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
            ensure!(
                record.accepted == self.accepted.data
                    && record.snapshot.revision == expected_revision,
                "TASK_CAPABILITY_SCOPE_REVISION_CONFLICT"
            );
            let pending = record
                .pending
                .clone()
                .context("TASK_CAPABILITY_SCOPE_NO_PENDING_CHANGE")?;
            let control = record
                .controls
                .get(&pending.operation_id)
                .cloned()
                .context("TASK_CAPABILITY_SCOPE_LEGACY_PENDING_AUTHORITY_UNKNOWN")?;
            ensure!(
                control.phase == NativeTaskCapabilityScopeControlPhase::PendingBoundary
                    && control.requested == record.snapshot,
                "TASK_CAPABILITY_SCOPE_PENDING_CONTROL_CHANGED"
            );
            (pending, control, record.snapshot)
        };
        // Reuse the original admitted operation, never a transient caller permit
        // or the later native boundary operation as source-management authority.
        control
            .authorization
            .verify_fixed_sources(&pending.sources)?;
        let authorization = facts
            .revalidate_selection_authorization(
                context,
                &self.accepted,
                &control.authorization,
                &pending.operation_id,
                &staged.selection,
            )
            .await;
        let resource_check = async {
            control
                .authorization
                .verify_resource_bindings(pending.resource_bindings.as_deref())?;
            if let Some(bindings) = &pending.resource_bindings {
                facts.verify_resource_bindings(context, bindings).await?;
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let source_check = if authorization.is_ok() {
            let observed = if staged.selection.mode == IntegrationTaskCapabilityScopeMode::None {
                Vec::new()
            } else {
                facts.sources(context).await?
            };
            validate_current_sources(context, &pending.sources, &observed)
        } else {
            Err(anyhow::anyhow!(
                "TASK_CAPABILITY_SCOPE_CURRENT_AUTHORITY_UNAVAILABLE"
            ))
        };
        self.accepted.verify(context, facts).await?;
        facts.verify_safe_boundary(context, &self.accepted, &execution)?;
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Exclusive,
        )?;
        let mut record =
            read_record(&directory, &key)?.context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data
                && record.snapshot == staged
                && record
                    .pending
                    .as_ref()
                    .is_some_and(|current| current.operation_id == pending.operation_id)
                && record.controls.get(&pending.operation_id) == Some(&control),
            "TASK_CAPABILITY_SCOPE_CONTROL_CHANGED_DURING_REVALIDATION"
        );
        ensure!(
            record.receipts.len() < MAX_CHANGES,
            "TASK_CAPABILITY_SCOPE_CHANGE_CAPACITY"
        );
        record.pending = None;
        record.snapshot.revision = expected_revision
            .checked_add(1)
            .context("TASK_CAPABILITY_SCOPE_REVISION_LIMIT")?;
        if authorization.is_ok() && source_check.is_ok() && resource_check.is_ok() {
            record.snapshot.effective_sources = pending.sources;
            if let Some(bindings) = pending.resource_bindings {
                record.snapshot.effective_resource_bindings = Some(bindings);
            }
            record.snapshot.effective_from =
                IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot;
            let saved = record.controls.get_mut(&pending.operation_id).unwrap();
            saved.phase = NativeTaskCapabilityScopeControlPhase::Applied;
            saved.applied_revision = Some(record.snapshot.revision);
            saved.reason_code = None;
        } else {
            let revision = record.snapshot.revision;
            record.snapshot = control.previous.clone();
            record.snapshot.revision = revision;
            record.snapshot.effective_from =
                IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot;
            let saved = record.controls.get_mut(&pending.operation_id).unwrap();
            saved.phase = NativeTaskCapabilityScopeControlPhase::Rejected;
            saved.applied_revision = None;
            saved.reason_code = Some(
                if resource_check.is_err() {
                    "TASK_RESOURCE_GRANT_CHANGED_OR_UNAVAILABLE"
                } else if authorization.is_err() {
                    "TASK_CAPABILITY_SCOPE_AUTHORITY_REVOKED_OR_UNAVAILABLE"
                } else {
                    "TASK_CAPABILITY_SCOPE_SOURCE_OR_ACCOUNT_CHANGED"
                }
                .into(),
            );
        }
        record.receipts.insert(
            operation_id.into(),
            Receipt {
                intent,
                snapshot: record.snapshot.clone(),
            },
        );
        if write_record(&directory, &key, &record).is_err() {
            let current = read_record(&directory, &key)?
                .context("TASK_CAPABILITY_SCOPE_CONTROL_OUTCOME_UNKNOWN")?;
            ensure!(
                current.controls.get(&pending.operation_id)
                    == record.controls.get(&pending.operation_id),
                "TASK_CAPABILITY_SCOPE_CONTROL_OUTCOME_UNKNOWN"
            );
        }
        Ok(record.snapshot)
    }
    pub(crate) fn read_control_operation(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<NativeTaskCapabilityScopeControlReceipt>> {
        atom(operation)?;
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Shared,
        )?;
        let record = read_record(&directory, &self.task_key()?)?
            .context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data,
            "TASK_CAPABILITY_SCOPE_BINDING_ACCEPTED_CHANGED"
        );
        Ok(record.controls.get(operation).cloned())
    }
}
fn resolve_selection(
    context: &NativeIntegrationContext,
    catalog: &NativeConnectivitySourceCatalog,
    selection: &IntegrationTaskCapabilityScopeSelection,
    facts: &[NativeMcpSourceFact],
) -> Result<Vec<IntegrationTaskCapabilitySourceChoice>> {
    selection.validate()?;
    match selection.mode {
        IntegrationTaskCapabilityScopeMode::None => Ok(Vec::new()),
        IntegrationTaskCapabilityScopeMode::InheritCurrent => {
            catalog.current_choices(context, facts)
        }
        IntegrationTaskCapabilityScopeMode::Selected => {
            for choice in &selection.sources {
                catalog.resolve_choice(context, choice, facts)?;
            }
            Ok(selection.sources.clone())
        }
    }
}
fn leaf(key: &str) -> Result<String> {
    ensure!(
        key.len() == 64 && key.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "TASK_CAPABILITY_SCOPE_KEY_INVALID"
    );
    Ok(format!("source-binding-{key}.json"))
}
fn read_bytes(directory: &PrivateDirectory, name: &str) -> Result<Option<Vec<u8>>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= MAX_RECORD_BYTES as usize,
        "TASK_CAPABILITY_SCOPE_RECORD_TOO_LARGE"
    );
    Ok(Some(bytes))
}
fn read_record(directory: &PrivateDirectory, key: &str) -> Result<Option<Record>> {
    let index = read_index(directory)?;
    read_record_with_index(directory, key, &index)
}

fn read_record_with_index(
    directory: &PrivateDirectory,
    key: &str,
    index: &BTreeMap<String, Birth>,
) -> Result<Option<Record>> {
    let Some(bytes) = read_bytes(directory, &leaf(key)?)? else {
        ensure!(
            !index.contains_key(key),
            "TASK_CAPABILITY_SCOPE_BINDING_OUTCOME_UNKNOWN"
        );
        return Ok(None);
    };
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_RECORD_INVALID"))?;
    ensure!(
        matches!(record.version, 1..=4)
            && (record.version >= 2 || record.children.is_empty())
            && (record.version >= 3 || record.controls.is_empty())
            && record.controls.len() <= MAX_CHANGES
            && record.children.len() <= 128
            && record.snapshot.revision > 0
            && record.receipts.len() <= MAX_CHANGES
            && record.snapshot.thread_id == record.accepted.initial_attempt.thread_id
            && digest(&record.accepted)? == key,
        "TASK_CAPABILITY_SCOPE_RECORD_INVALID"
    );
    record.snapshot.selection.validate()?;
    validate_choices(&record.snapshot.effective_sources)?;
    validate_resources(record.snapshot.resource_bindings.as_deref())?;
    validate_resources(record.snapshot.effective_resource_bindings.as_deref())?;
    ensure!(
        record.pending.is_some()
            == (record.snapshot.effective_from
                == IntegrationTaskCapabilityScopeBoundary::NextToolBoundary),
        "TASK_CAPABILITY_SCOPE_RECORD_INVALID"
    );
    if let Some(pending) = &record.pending {
        atom(&pending.operation_id)?;
        validate_choices(&pending.sources)?;
        validate_resources(pending.resource_bindings.as_deref())?;
        ensure!(
            pending.resource_bindings.is_none()
                || pending.resource_bindings == record.snapshot.resource_bindings,
            "TASK_RESOURCE_PENDING_INTENT_CHANGED"
        );
        ensure!(
            record
                .receipts
                .get(&pending.operation_id)
                .is_some_and(|receipt| receipt.snapshot == record.snapshot),
            "TASK_CAPABILITY_SCOPE_PENDING_INTENT_CHANGED"
        );
        validate_effective(&record.snapshot.selection, &pending.sources)?;
    } else {
        validate_effective(
            &record.snapshot.selection,
            &record.snapshot.effective_sources,
        )?;
    }
    for (key, intent) in &record.children {
        intent.validate(key)?;
    }
    for (operation, receipt) in &record.receipts {
        atom(operation)?;
        ensure!(
            receipt.intent.len() == 64
                && receipt.intent.bytes().all(|byte| byte.is_ascii_hexdigit())
                && receipt.snapshot.thread_id == record.snapshot.thread_id
                && receipt.snapshot.revision > 0
                && receipt.snapshot.revision <= record.snapshot.revision,
            "TASK_CAPABILITY_SCOPE_RECORD_INVALID"
        );
        receipt.snapshot.selection.validate()?;
        validate_choices(&receipt.snapshot.effective_sources)?;
    }
    let birth = index
        .get(key)
        .context("TASK_CAPABILITY_SCOPE_BINDING_BIRTH_REQUIRED")?;
    ensure!(
        record
            .receipts
            .get(&birth.operation_id)
            .is_some_and(|receipt| receipt.intent == birth.intent),
        "TASK_CAPABILITY_SCOPE_BINDING_BIRTH_CHANGED"
    );
    Ok(Some(record))
}
fn read_index(directory: &PrivateDirectory) -> Result<BTreeMap<String, Birth>> {
    #[cfg(test)]
    INDEX_READS.with(|count| count.set(count.get() + 1));
    let bytes =
        read_bytes(directory, INDEX)?.context("TASK_CAPABILITY_SCOPE_BINDING_INDEX_REQUIRED")?;
    let index: BTreeMap<String, Birth> = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_BINDING_INDEX_INVALID"))?;
    ensure!(
        index.len() <= MAX_BINDINGS,
        "TASK_CAPABILITY_SCOPE_BINDING_INDEX_INVALID"
    );
    for (key, birth) in &index {
        leaf(key)?;
        atom(&birth.operation_id)?;
        ensure!(
            birth.intent.len() == 64,
            "TASK_CAPABILITY_SCOPE_BINDING_INDEX_INVALID"
        );
    }
    Ok(index)
}
fn validate_effective(
    selection: &IntegrationTaskCapabilityScopeSelection,
    sources: &[IntegrationTaskCapabilitySourceChoice],
) -> Result<()> {
    ensure!(
        match selection.mode {
            IntegrationTaskCapabilityScopeMode::None => sources.is_empty(),
            IntegrationTaskCapabilityScopeMode::Selected => sources == selection.sources,
            IntegrationTaskCapabilityScopeMode::InheritCurrent => true,
        },
        "TASK_CAPABILITY_SCOPE_EFFECTIVE_INTENT_CHANGED"
    );
    Ok(())
}
fn validate_choices(choices: &[IntegrationTaskCapabilitySourceChoice]) -> Result<()> {
    if choices.is_empty() {
        return Ok(());
    }
    IntegrationTaskCapabilityScopeSelection {
        mode: IntegrationTaskCapabilityScopeMode::Selected,
        sources: choices.to_vec(),
    }
    .validate()?;
    Ok(())
}
fn write_record(directory: &PrivateDirectory, key: &str, record: &Record) -> Result<()> {
    let bytes = serde_json::to_vec(record)?;
    ensure!(
        bytes.len() <= MAX_RECORD_BYTES as usize,
        "TASK_CAPABILITY_SCOPE_RECORD_TOO_LARGE"
    );
    directory.atomic_replace(OsStr::new(&leaf(key)?), &bytes)
}

fn validate_current_sources(
    context: &NativeIntegrationContext,
    choices: &[IntegrationTaskCapabilitySourceChoice],
    facts: &[NativeMcpSourceFact],
) -> Result<()> {
    if choices.is_empty() {
        return Ok(());
    }
    let catalog = NativeConnectivitySourceCatalog::observe(context)?
        .context("NATIVE_SOURCE_CATALOG_REQUIRED")?;
    for choice in choices {
        catalog.resolve_choice(context, choice, facts)?;
    }
    Ok(())
}

fn validate_resources(bindings: Option<&[IntegrationTaskResourceBinding]>) -> Result<()> {
    if let Some(bindings) = bindings {
        ensure!(
            bindings.len() <= MAX_TASK_CAPABILITY_SOURCES,
            "TASK_RESOURCE_BINDING_LIMIT"
        );
        let mut seen = std::collections::BTreeSet::new();
        for binding in bindings {
            binding.validate()?;
            ensure!(
                seen.insert((
                    binding.source.source_ref.id.clone(),
                    binding.connection_ref.id.clone()
                )),
                "TASK_RESOURCE_DUPLICATE_CONNECTION"
            );
        }
    }
    Ok(())
}
