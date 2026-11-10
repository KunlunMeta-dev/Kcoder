//! Retirement execution has its own born lock; archive readers never impersonate a worker.
use super::*;
use kcoder_config::PortableLeaseIdentity;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchiveRetirementExecutionState {
    Running,
    Stopped,
    Unknown,
}

#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::external_history::lifecycle) struct ExecutionAnchor {
    pub identity: PortableLeaseIdentity,
    pub birth_sha256: String,
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Birth {
    version: u8,
    scope: String,
    operation: String,
    request: String,
    archive: String,
    fingerprint: String,
    initial_sha256: String,
    identity: PortableLeaseIdentity,
}

fn stem(operation: &str) -> Result<String> {
    operation_id(operation)?;
    Ok(format!("retirement-{}", hash(&operation)?))
}

impl Catalog<'_> {
    fn execution_birth(&self, record: &Retirement) -> Result<Birth> {
        let anchor = record
            .execution
            .as_ref()
            .context("external_history_retirement_execution_untracked")?;
        let birth: Birth = load(
            &self.directory,
            &format!("{}.execution.birth", stem(&record.operation)?),
            4096,
        )?;
        ensure!(
            birth.version == 1
                && birth.scope == self.document.scope
                && birth.operation == record.operation
                && birth.request == record.request
                && birth.archive == record.archive
                && birth.fingerprint == record.fingerprint
                && birth.identity == anchor.identity
                && hash(&birth)? == anchor.birth_sha256,
            "external_history_retirement_execution_unknown"
        );
        digest(&birth.initial_sha256)?;
        Ok(birth)
    }

    /// The catalogue's original mutation coordinator serializes birth publication.
    /// An orphan without its pre-publication marker is never adopted or replaced.
    pub(super) fn birth_retirement_execution(
        &self,
        record: &Retirement,
    ) -> Result<ExecutionAnchor> {
        self.ensure_writer()?;
        ensure!(
            record.execution.is_none(),
            "external_history_retirement_execution_unknown"
        );
        let stem = stem(&record.operation)?;
        let marker = format!("{stem}.execution.birth");
        let initial_sha256 = hash(record)?;
        let birth = match load::<Birth>(&self.directory, &marker, 4096) {
            Ok(birth) => {
                ensure!(
                    birth.version == 1
                        && birth.scope == self.document.scope
                        && birth.operation == record.operation
                        && birth.request == record.request
                        && birth.archive == record.archive
                        && birth.fingerprint == record.fingerprint
                        && birth.initial_sha256 == initial_sha256,
                    "external_history_retirement_execution_unknown"
                );
                birth
            }
            Err(error) if missing(&error) => {
                let file = self
                    .directory
                    .open_read_write_file(OsStr::new(&format!("{stem}.execution.lock")), true)
                    .map_err(|_| {
                        anyhow::anyhow!("external_history_retirement_execution_unknown")
                    })?;
                let identity = self.directory.portable_regular_handle_identity(&file)?;
                ensure!(
                    self.directory
                        .portable_regular_identity(OsStr::new(&format!("{stem}.execution.lock")))?
                        == identity,
                    "external_history_retirement_execution_unknown"
                );
                let birth = Birth {
                    version: 1,
                    scope: self.document.scope.clone(),
                    operation: record.operation.clone(),
                    request: record.request.clone(),
                    archive: record.archive.clone(),
                    fingerprint: record.fingerprint.clone(),
                    initial_sha256,
                    identity,
                };
                crate::external_history::publish_exact(
                    &self.directory,
                    &marker,
                    &encode(&birth, 4096)?,
                    4096,
                )?;
                birth
            }
            Err(error) => return Err(error),
        };
        let anchor = ExecutionAnchor {
            identity: birth.identity.clone(),
            birth_sha256: hash(&birth)?,
        };
        // Check the original name even when recovering a lost catalogue receipt.
        let _verified = self
            .directory
            .try_existing_portable_lock(
                OsStr::new(&format!("{stem}.execution.lock")),
                &anchor.identity,
                PrivateLeaseMode::Shared,
            )?
            .context("external_history_retirement_execution_busy")?;
        Ok(anchor)
    }

    pub(super) fn claim_retirement_execution(
        &self,
        operation: &str,
    ) -> Result<VerifiedPrivateLease> {
        let record = self.retirement(operation)?;
        ensure!(
            record.execution.is_some(),
            "external_history_retirement_execution_untracked"
        );
        self.execution_birth(record)
            .map_err(|_| anyhow::anyhow!("external_history_retirement_execution_unknown"))?;
        let identity = &record.execution.as_ref().unwrap().identity;
        self.directory
            .try_existing_portable_lock(
                OsStr::new(&format!("{}.execution.lock", stem(operation)?)),
                identity,
                PrivateLeaseMode::Exclusive,
            )
            .map_err(|_| anyhow::anyhow!("external_history_retirement_execution_unknown"))?
            .context("external_history_retirement_execution_busy")
    }

    /// Shared probes do not block one another and never create a missing leaf.
    pub fn retirement_execution_state(
        &self,
        operation: &str,
    ) -> Result<ArchiveRetirementExecutionState> {
        let record = self.retirement(operation)?;
        let Some(anchor) = &record.execution else {
            return Ok(ArchiveRetirementExecutionState::Unknown);
        };
        let observed = (|| -> Result<ArchiveRetirementExecutionState> {
            self.execution_birth(record)?;
            let lease = self.directory.try_existing_portable_lock(
                OsStr::new(&format!("{}.execution.lock", stem(operation)?)),
                &anchor.identity,
                PrivateLeaseMode::Shared,
            )?;
            Ok(if lease.is_some() {
                ArchiveRetirementExecutionState::Stopped
            } else {
                ArchiveRetirementExecutionState::Running
            })
        })();
        Ok(observed.unwrap_or(ArchiveRetirementExecutionState::Unknown))
    }
}
#[cfg(test)]
mod tests;
