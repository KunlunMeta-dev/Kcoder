//! Provider keys and MCP payloads use the same native group authority.
use crate::{
    credentials::{CredentialPhase, CredentialPlan, CredentialTarget},
    mcp_credentials::McpCredentialPlan,
};
use anyhow::Result;
use kcoder_config::{
    CredentialBackend,
    imported_credentials::{CredentialImportRef, ImportState},
};

#[derive(Clone)]
pub(crate) enum AtomicCredential {
    Provider(Box<CredentialPlan>),
    Mcp(Box<McpCredentialPlan>),
}
impl AtomicCredential {
    pub fn reference(&self) -> &CredentialImportRef {
        match self {
            Self::Provider(plan) => &plan.reference,
            Self::Mcp(plan) => &plan.reference,
        }
    }
    pub fn id(&self) -> &str {
        match self {
            Self::Provider(plan) => &plan.plan_id,
            Self::Mcp(plan) => &plan.plan_id,
        }
    }
    pub fn item_id(&self) -> &str {
        match self {
            Self::Provider(plan) => &plan.item_id,
            Self::Mcp(plan) => &plan.item_id,
        }
    }
    pub fn phase(&self) -> CredentialPhase {
        match self {
            Self::Provider(plan) => plan.phase,
            Self::Mcp(plan) => plan.phase,
        }
    }
    pub fn provider_named(&self, name: &str) -> bool {
        matches!(self,Self::Provider(plan) if plan.target_name==name)
    }
    pub fn stage(
        &self,
        target: &CredentialTarget,
        backend: &dyn CredentialBackend,
        source_name: &str,
    ) -> Result<ImportState> {
        match self {
            Self::Provider(plan) => target.stage(plan, backend, source_name),
            Self::Mcp(plan) => {
                plan.stage_native(target.native(), backend, &target.directory_identity()?)
            }
        }
    }
    pub fn state(
        &self,
        target: &CredentialTarget,
        backend: &dyn CredentialBackend,
    ) -> Result<Option<ImportState>> {
        target
            .native()
            .state(self.reference(), backend)
            .map_err(crate::mcp_credentials::safe_error)
    }
    pub fn undo(
        &self,
        target: &CredentialTarget,
        backend: &dyn CredentialBackend,
    ) -> Result<ImportState> {
        match self {
            Self::Provider(plan) => target.undo(plan, backend),
            Self::Mcp(plan) => target
                .native()
                .undo(&plan.reference, backend)
                .map_err(crate::mcp_credentials::safe_error),
        }
    }
}
