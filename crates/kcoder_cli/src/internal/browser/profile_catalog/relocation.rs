//! The browser catalog owner adapts its own data before a domain marker commits.
use super::*;
use kcoder_config::PrivateDirectory;
use kcoder_native_scope::{NativeIdentity, NativeObservedDomain, NativeObservedDomainRelocation};
use kcoder_state::browser_profiles::PreparedBrowserProfileRelocation;

pub struct NativeBrowserCatalogRelocation {
    namespace: String,
    source_directory_identity: String,
    store: BrowserProfileStore,
}
pub struct PreparedNativeBrowserCatalogRelocation<'a> {
    owner: &'a NativeBrowserCatalogRelocation,
    prepared: PreparedBrowserProfileRelocation<'a>,
}
impl NativeBrowserCatalogRelocation {
    /// The data observation permits disabled-source preservation without runtime
    /// capture, browser launch, account changes or active-use cleanup by fiat.
    pub fn observe(
        source: &NativeObservedDomain,
        identity: &NativeIdentity,
        profile: &PrivateDirectory,
    ) -> Result<Self> {
        ensure!(
            source.domain() == NativeDomain::BrowserProfiles,
            "BROWSER_PROFILE_RELOCATION_WRONG_DOMAIN"
        );
        let directory = source.directory(identity, profile)?;
        let store =
            BrowserProfileStore::open_in(&directory, OsStr::new("catalog"), source.scope())?
                .context("BROWSER_PROFILE_STORAGE_DAMAGED")?;
        store.relocation_snapshot()?;
        source.verify(identity, profile)?;
        Ok(Self {
            namespace: source.namespace_id().into(),
            source_directory_identity: directory.directory_identity()?,
            store,
        })
    }
    pub fn prepare_relocation<'a>(
        &'a self,
        source: &NativeObservedDomain,
        identity: &NativeIdentity,
        profile: &PrivateDirectory,
    ) -> Result<PreparedNativeBrowserCatalogRelocation<'a>> {
        ensure!(
            source.namespace_id() == self.namespace
                && source.directory(identity, profile)?.directory_identity()?
                    == self.source_directory_identity,
            "BROWSER_PROFILE_RELOCATION_OWNER_CHANGED"
        );
        let prepared = self.store.prepare_relocation()?;
        source.verify(identity, profile)?;
        Ok(PreparedNativeBrowserCatalogRelocation {
            owner: self,
            prepared,
        })
    }
    pub fn verify_relocation(
        &self,
        transaction: NativeObservedDomainRelocation<'_>,
    ) -> Result<NativeDomainGuard> {
        self.check_transaction(&transaction)?;
        ensure!(
            transaction.is_committed(),
            "BROWSER_PROFILE_RELOCATION_UNCONFIRMED"
        );
        let snapshot = self.store.relocation_snapshot()?;
        let operation_id = transaction.operation_id().to_owned();
        transaction.commit(|_, target| {
            self.store
                .verify_relocation(target, &operation_id, &snapshot)
        })
    }
    fn check_transaction(&self, transaction: &NativeObservedDomainRelocation<'_>) -> Result<()> {
        transaction.verify()?;
        ensure!(
            transaction.domain() == NativeDomain::BrowserProfiles
                && transaction.namespace_id() == self.namespace
                && transaction.source_directory().directory_identity()?
                    == self.source_directory_identity,
            "BROWSER_PROFILE_RELOCATION_OWNER_CHANGED"
        );
        Ok(())
    }
}
impl PreparedNativeBrowserCatalogRelocation<'_> {
    pub fn verify(&self) -> Result<()> {
        self.prepared.verify()
    }
    pub fn relocate(
        self,
        transaction: NativeObservedDomainRelocation<'_>,
    ) -> Result<NativeDomainGuard> {
        self.owner.check_transaction(&transaction)?;
        self.prepared.verify()?;
        let committed = transaction.is_committed();
        let operation_id = transaction.operation_id().to_owned();
        transaction.commit(|_, target| {
            if committed {
                self.prepared.verify_relocation(target, &operation_id)
            } else {
                self.prepared.relocate(target, &operation_id).map(|_| ())
            }
        })
    }
}

#[cfg(test)]
#[path = "relocation/tests.rs"]
mod tests;
