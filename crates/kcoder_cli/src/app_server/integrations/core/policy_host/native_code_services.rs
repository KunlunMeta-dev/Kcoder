//! A fixed native saved-code purpose uses the same account issuer and journal.
use super::*;
use kcoder_native_delegation::{AuthenticatedNativeCodeServiceSource, NativeCodeServicePermit};

impl NativePolicyService {
    pub fn open_after_native_code_approval(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Self> {
        match Self::load(context)? {
            Some(service) => Ok(service),
            None => Self::initialize(context, operation),
        }
    }
    pub fn issue_native_code_service(
        &self,
        context: &NativeIntegrationContext,
        intent: &NativeCodeServiceIntent,
        source: &AuthenticatedNativeCodeServiceSource,
        now: u64,
    ) -> Result<NativeCodeServiceGrantView> {
        context.validate_scope(&intent.scope)?;
        self.verify(context)?;
        let view = self.with_authority_at(context, now, |authority, at| {
            authority.issue_native_code_service(intent, source, at)
        })?;
        self.verify(context)?;
        Ok(view)
    }
    pub fn read_native_code_service_issue(
        &self,
        context: &NativeIntegrationContext,
        intent: &NativeCodeServiceIntent,
        now: u64,
    ) -> Result<Option<NativeCodeServiceGrantView>> {
        context.verify()?;
        ensure!(
            IntegrationOwner::from(context.scope()) == IntegrationOwner::from(&intent.scope),
            "NATIVE_CODE_SERVICE_OWNER_MISMATCH"
        );
        self.verify(context)?;
        let view = self.with_authority_at(context, now, |authority, at| {
            authority.read_native_code_service_issue(intent, at)
        })?;
        self.verify(context)?;
        Ok(view)
    }
    pub fn authorize_native_code_service(
        &self,
        context: &NativeIntegrationContext,
        record: &NativeCodeServiceRecord,
        source: &AuthenticatedNativeCodeServiceSource,
        now: u64,
    ) -> Result<NativeCodeServicePermit> {
        context.validate_scope(&record.intent.scope)?;
        self.verify(context)?;
        let permit = self.with_authority_at(context, now, |authority, at| {
            authority.authorize_native_code_service(&record.grant_ref, &record.intent, source, at)
        })?;
        self.verify(context)?;
        Ok(permit)
    }
    pub fn revalidate_native_code_service(
        &self,
        context: &NativeIntegrationContext,
        permit: &NativeCodeServicePermit,
        source: &AuthenticatedNativeCodeServiceSource,
        now: u64,
    ) -> Result<()> {
        context.validate_scope(&permit.intent().scope)?;
        self.verify(context)?;
        self.with_authority_at(context, now, |authority, at| {
            authority.revalidate_native_code_service(permit, source, at)
        })?;
        self.verify(context)
    }
    pub fn revoke_native_code_service(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
        reference: &IntegrationRevisionRef,
        now: u64,
    ) -> Result<NativeCodeServiceGrantView> {
        context.verify()?;
        self.verify(context)?;
        let view = self.with_authority_at(context, now, |authority, at| {
            authority.revoke_native_code_service(operation, reference, at)
        })?;
        self.verify(context)?;
        Ok(view)
    }
}
