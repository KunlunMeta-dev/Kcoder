//! Read-only policy selection and an invalidation hint over the original native journal.
use super::*;
use std::{collections::BTreeMap, time::UNIX_EPOCH};

impl NativeBudgetStore {
    /// Return every currently applicable family from the actual verified journal.
    /// Missing current windows, overlapping latest windows and stale versions
    /// are errors; callers must not omit an upper policy to obtain admission.
    pub fn current_applicable_policies(
        &self,
        principal: &NativeBudgetPrincipal,
        root_operation: &str,
        now_ms: u64,
    ) -> Result<Vec<NativeBudgetPolicy>> {
        label(root_operation)?;
        let ledger = self.load()?;
        let mut families = BTreeMap::<String, Vec<&PolicyRecord>>::new();
        for policy in ledger.windows.values() {
            if principal.record.applies(&policy.scope, root_operation) {
                families.entry(policy.family()?).or_default().push(policy);
            }
        }
        let mut selected = Vec::new();
        for records in families.values() {
            let version = records
                .iter()
                .map(|record| record.version)
                .max()
                .context("BUDGET_POLICY_UNKNOWN")?;
            let current = records
                .iter()
                .filter(|record| {
                    record.version == version
                        && now_ms >= record.window.starts_at_ms
                        && now_ms < record.window.ends_at_ms
                })
                .collect::<Vec<_>>();
            ensure!(!current.is_empty(), "BUDGET_WINDOW_NOT_CURRENT");
            ensure!(current.len() == 1, "BUDGET_POLICY_WINDOW_AMBIGUOUS");
            selected.push(NativeBudgetPolicy {
                record: (**current[0]).clone(),
            });
        }
        self.verify()?;
        Ok(selected)
    }

    /// An opaque physical change hint, never a reservation or policy grant.
    /// Admission/dispatch/settlement still use the original full locked journal.
    /// Unsupported timestamps or any lost native identity stay unavailable.
    pub fn observation_epoch(&self) -> Result<String> {
        self.verify()?;
        let file = self
            .directory
            .open_single_link_regular_file(OsStr::new(DATA))?;
        let identity = self.directory.portable_regular_handle_identity(&file)?;
        let metadata = file.metadata()?;
        ensure!(metadata.len() <= MAX_LEDGER_BYTES, "BUDGET_LEDGER_CAPACITY");
        let modified = metadata.modified()?.duration_since(UNIX_EPOCH)?;
        #[cfg(unix)]
        let native_change = {
            use std::os::unix::fs::MetadataExt;
            (metadata.ctime(), metadata.ctime_nsec())
        };
        #[cfg(not(unix))]
        let native_change = ();
        let after = file.metadata()?;
        ensure!(
            after.len() == metadata.len()
                && after.modified()? == metadata.modified()?
                && self.directory.portable_regular_identity(OsStr::new(DATA))? == identity,
            "BUDGET_STORAGE_CHANGED"
        );
        self.verify()?;
        digest(&(
            "budget-observation-epoch-v1",
            self.directory.directory_identity()?,
            identity,
            metadata.len(),
            modified.as_secs(),
            modified.subsec_nanos(),
            native_change,
        ))
    }
}

#[cfg(test)]
#[path = "observations/tests.rs"]
mod tests;
