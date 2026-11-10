//! One original State budget journal for the actual native profile account.
use anyhow::{Context, Result, ensure};
use kcoder_integration_storage::integrations::core::budgets::NativeBudgetStore;
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationOwner, IntegrationScope};
use std::{ffi::OsStr, sync::Arc};

pub struct NativeBudgetService {
    guard: NativeDomainGuard,
    owner: IntegrationOwner,
    store: Arc<NativeBudgetStore>,
}
impl NativeBudgetService {
    fn account_scope(native: &NativeIntegrationContext) -> Result<IntegrationScope> {
        native.verify()?;
        ensure!(
            native.scope().organization_id.is_none(),
            "BUDGET_ORGANIZATION_AUTHORITY_UNAVAILABLE"
        );
        let mut account = native.scope().clone();
        account.workspace_id = IntegrationNullable::Null;
        account.validate()?;
        Ok(account)
    }
    /// Observation never initializes, repairs, or silently adopts a lost journal.
    pub fn load(native: &NativeIntegrationContext) -> Result<Option<Self>> {
        let account = Self::account_scope(native)?;
        let Some(guard) =
            NativeDomainGuard::observe(native.profile()?, &account, NativeDomain::Budgets)?
        else {
            return Ok(None);
        };
        let directory = guard.directory(native.profile()?)?;
        let store = NativeBudgetStore::open_in(&directory, OsStr::new("ledger"), &account)?
            .context("BUDGET_COMMITTED_JOURNAL_MISSING")?;
        let service = Self {
            guard,
            owner: IntegrationOwner::from(&account),
            store: Arc::new(store),
        };
        service.verify(native)?;
        Ok(Some(service))
    }
    /// Native composition calls this only after the real persisted source/run,
    /// explicit consent, and current policy have authorized the first effect.
    pub fn initialize(native: &NativeIntegrationContext, original_operation: &str) -> Result<Self> {
        if let Some(existing) = Self::load(native)? {
            return Ok(existing);
        }
        let account = Self::account_scope(native)?;
        let initialized = NativeDomainGuard::initialize(
            native.profile()?,
            &account,
            NativeDomain::Budgets,
            original_operation,
            |directory| NativeBudgetStore::create_in(directory, OsStr::new("ledger"), &account),
        );
        let (guard, store) = match initialized {
            Ok(value) => value,
            Err(error) => {
                if let Ok(Some(existing)) = Self::load(native) {
                    return Ok(existing);
                }
                return Err(error);
            }
        };
        let service = Self {
            guard,
            owner: IntegrationOwner::from(&account),
            store: Arc::new(store),
        };
        service.verify(native)?;
        Ok(service)
    }
    pub fn verify(&self, native: &NativeIntegrationContext) -> Result<()> {
        let account = Self::account_scope(native)?;
        ensure!(
            self.owner == IntegrationOwner::from(&account),
            "BUDGET_NATIVE_OWNER_MISMATCH"
        );
        let directory = self.guard.directory(native.profile()?)?;
        ensure!(
            directory
                .open_entry_handle(OsStr::new("ledger"))?
                .open_child_directory()?
                .directory_identity()?
                == self.store.storage_directory_identity()?,
            "BUDGET_NATIVE_JOURNAL_CHANGED"
        );
        Ok(())
    }
    /// Accounting leases retain this original journal even after execution
    /// authority is revoked. They may settle observed spend, never admit work.
    pub fn accounting_store(&self) -> Arc<NativeBudgetStore> {
        self.store.clone()
    }
    #[cfg(test)]
    pub fn namespace_id(&self) -> &str {
        self.guard.namespace_id()
    }
}

#[cfg(test)]
#[path = "budget_host/tests.rs"]
mod tests;
