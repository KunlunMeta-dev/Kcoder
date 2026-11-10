use super::*;
use serde_json::Value;

/// A live caller's verified admission capability. No public body can construct
/// or deserialize it; only its private durable projection enters the binding.
pub(crate) struct NativeTaskCapabilityScopeAdmission {
    pub(super) receipt: NativeTaskCapabilityScopeAuthorizationReceipt,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeTaskCapabilityScopeAuthorizationReceipt {
    pub(super) version: u32,
    pub(super) owner: IntegrationOwner,
    pub(super) identity_generation: String,
    pub(super) identity_revision: u64,
    pub(super) target_revision: String,
    pub(super) task_key: String,
    pub(super) accepted_fingerprint: String,
    pub(super) native_owner_epoch: String,
    pub(super) operation: String,
    pub(super) selection_sha256: String,
    pub(super) fixed_sources_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) resource_bindings_sha256: Option<String>,
    pub(super) origin: AuthorizationOrigin,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum AuthorizationOrigin {
    NativePublicOwner,
    // Historical SDK bindings remain readable, but never authorize a task operation.
    #[serde(rename = "sdk_task_binding")]
    RetiredSdkTaskBinding(Value),
    // Decode historical task configuration without treating an old member grant as authority.
    #[serde(rename = "sdk_delegation")]
    RetiredSdkDelegation(Value),
    #[cfg(test)]
    ExplicitOwnedFixture,
}
impl NativeTaskCapabilityScopeAdmission {
    pub(crate) fn from_public(
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        operation: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
        permit: &Arc<NativeTaskCapabilityScopeManagementPermit>,
    ) -> Result<Self> {
        let task = accepted.task_key()?;
        permit.verify(context.scope(), &task, operation, selection)?;
        let (generation, revision) = context.source_authority_epoch()?;
        ensure!(
            context.scope().organization_id.is_none(),
            "TASK_CAPABILITY_SCOPE_ORGANIZATION_POLICY_REQUIRED"
        );
        let receipt = NativeTaskCapabilityScopeAuthorizationReceipt {
            version: 1,
            owner: IntegrationOwner::from(context.scope()),
            identity_generation: generation,
            identity_revision: revision,
            target_revision: context.scope().target_revision.clone(),
            task_key: task,
            accepted_fingerprint: accepted.accepted_fingerprint().into(),
            native_owner_epoch: accepted.native_owner_epoch().into(),
            operation: operation.into(),
            selection_sha256: hash(selection)?,
            fixed_sources_sha256: None,
            resource_bindings_sha256: None,
            origin: AuthorizationOrigin::NativePublicOwner,
        };
        receipt.verify_native(context, accepted, operation, selection)?;
        permit.verify(context.scope(), &receipt.task_key, operation, selection)?;
        Ok(Self { receipt })
    }
    pub(crate) fn receipt(&self) -> &NativeTaskCapabilityScopeAuthorizationReceipt {
        &self.receipt
    }
}
impl NativeTaskCapabilityScopeAuthorizationReceipt {
    pub(crate) fn verify_native(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        operation: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<()> {
        let (generation, revision) = context.source_authority_epoch()?;
        ensure!(
            self.is_current_origin()
                && self.version == 1
                && self.owner == IntegrationOwner::from(context.scope())
                && self.identity_generation == generation
                && self.identity_revision == revision
                && self.target_revision == context.scope().target_revision
                && self.task_key == accepted.task_key()?
                && self.accepted_fingerprint == accepted.accepted_fingerprint()
                && self.native_owner_epoch == accepted.native_owner_epoch()
                && self.operation == operation
                && self.selection_sha256 == hash(selection)?,
            "TASK_CAPABILITY_SCOPE_DURABLE_AUTHORITY_CHANGED"
        );
        Ok(())
    }
    fn is_current_origin(&self) -> bool {
        match self.origin {
            AuthorizationOrigin::NativePublicOwner => true,
            #[cfg(test)]
            AuthorizationOrigin::ExplicitOwnedFixture => true,
            _ => false,
        }
    }
    pub(crate) fn is_public_owner(&self) -> bool {
        matches!(self.origin, AuthorizationOrigin::NativePublicOwner)
    }
    pub(crate) fn bind_fixed_sources(
        &self,
        sources: &[IntegrationTaskCapabilitySourceChoice],
    ) -> Result<Self> {
        let mut current = self.clone();
        current.fixed_sources_sha256 = Some(hash(&sources)?);
        Ok(current)
    }
    pub(crate) fn verify_fixed_sources(
        &self,
        sources: &[IntegrationTaskCapabilitySourceChoice],
    ) -> Result<()> {
        ensure!(
            self.fixed_sources_sha256.as_deref() == Some(hash(&sources)?.as_str()),
            "TASK_CAPABILITY_SCOPE_FIXED_REFERENCES_CHANGED"
        );
        Ok(())
    }
    pub(crate) fn bind_resource_bindings(
        mut self,
        bindings: Option<&[IntegrationTaskResourceBinding]>,
    ) -> Result<Self> {
        self.resource_bindings_sha256 = bindings.map(|bindings| hash(&bindings)).transpose()?;
        Ok(self)
    }
    pub(crate) fn verify_resource_bindings(
        &self,
        bindings: Option<&[IntegrationTaskResourceBinding]>,
    ) -> Result<()> {
        ensure!(
            self.resource_bindings_sha256
                == bindings.map(|bindings| hash(&bindings)).transpose()?,
            "TASK_RESOURCE_FIXED_REFERENCES_CHANGED"
        );
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn explicit_owned_fixture(
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
        operation: &str,
        selection: &IntegrationTaskCapabilityScopeSelection,
    ) -> Result<NativeTaskCapabilityScopeAdmission> {
        let (generation, revision) = context.source_authority_epoch()?;
        Ok(NativeTaskCapabilityScopeAdmission {
            receipt: Self {
                version: 1,
                owner: IntegrationOwner::from(context.scope()),
                identity_generation: generation,
                identity_revision: revision,
                target_revision: context.scope().target_revision.clone(),
                task_key: accepted.task_key()?,
                accepted_fingerprint: accepted.accepted_fingerprint().into(),
                native_owner_epoch: accepted.native_owner_epoch().into(),
                operation: operation.into(),
                selection_sha256: hash(selection)?,
                fixed_sources_sha256: None,
                resource_bindings_sha256: None,
                origin: AuthorizationOrigin::ExplicitOwnedFixture,
            },
        })
    }
}
