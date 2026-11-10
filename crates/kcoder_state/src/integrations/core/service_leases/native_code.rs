//! Saved-code leases reuse the original private service store and writer/owner locks.
use super::*;
use kcoder_types::integrations::core::{
    NativeCodeServiceIntent, NativeCodeServiceLaunchSpec, NativeCodeServiceRecord,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preparation {
    intent: NativeCodeServiceIntent,
    launch: NativeCodeServiceLaunchSpec,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodeStored {
    record: NativeCodeServiceRecord,
    launch: NativeCodeServiceLaunchSpec,
    owner_lock_identity: PortableLeaseIdentity,
    runtime_claimed: bool,
}
impl IntegrationServiceLeaseStore {
    pub fn set_native_code_enabled(
        &self,
        id: &str,
        expected: u64,
        enabled: bool,
        observed: u64,
    ) -> Result<NativeCodeServiceRecord> {
        let _writer = self.writer()?;
        let mut stored = self
            .native_code_stored(id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        ensure!(
            stored.record.revision == expected
                && (!enabled || stored.record.state != NativeCodeServiceState::Revoked),
            "NATIVE_CODE_SERVICE_REVISION_CONFLICT"
        );
        stored.record.enabled = enabled;
        stored.record.revision = stored
            .record
            .revision
            .checked_add(1)
            .context("NATIVE_CODE_SERVICE_REVISION_LIMIT")?;
        stored.record.observed_at_ms = observed;
        stored.record.validate()?;
        self.write_code_bytes(&code_name(id, "record")?, &stored)?;
        Ok(stored.record)
    }
    pub fn list_native_code(&self) -> Result<Vec<NativeCodeServiceRecord>> {
        self.verify()?;
        let mut records = Vec::new();
        self.directory.visit_entry_names_bounded(1024, |name| {
            let Some(name) = name.to_str() else {
                return Ok(());
            };
            if name.starts_with("native-code-record-") && name.ends_with(".json") {
                let stored: CodeStored = serde_json::from_slice(&read(&self.directory, name)?)?;
                let original = self
                    .native_code_stored(&stored.record.intent.lease_id)?
                    .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
                ensure!(records.len() < MAX_LEASES, "SERVICE_LEASE_CAPACITY");
                records.push(original.record);
            }
            Ok(())
        })?;
        Ok(records)
    }
    pub fn prepare_native_code(
        &self,
        intent: &NativeCodeServiceIntent,
        launch: &NativeCodeServiceLaunchSpec,
    ) -> Result<()> {
        intent.validate()?;
        launch.validate()?;
        ensure!(
            intent.lease_id == launch.lease_id
                && IntegrationOwner::from(&intent.scope) == self.header.owner,
            "NATIVE_CODE_SERVICE_OWNER_MISMATCH"
        );
        let _writer = self.writer()?;
        if let Some(prior) = self.read_native_code_preparation(&intent.lease_id)? {
            ensure!(
                prior.0 == *intent && prior.1 == *launch,
                "NATIVE_CODE_SERVICE_ORIGINAL_INTENT_CONFLICT"
            );
            return Ok(());
        }
        let name = code_name(&intent.lease_id, "prepare")?;
        self.write_code_bytes(
            &name,
            &Preparation {
                intent: intent.clone(),
                launch: launch.clone(),
            },
        )
    }
    pub fn read_native_code_preparation(
        &self,
        id: &str,
    ) -> Result<Option<(NativeCodeServiceIntent, NativeCodeServiceLaunchSpec)>> {
        self.verify()?;
        let Some(bytes) = self.optional_code_bytes(&code_name(id, "prepare")?)? else {
            return Ok(None);
        };
        let prepared: Preparation = serde_json::from_slice(&bytes)?;
        prepared.intent.validate()?;
        prepared.launch.validate()?;
        ensure!(
            prepared.intent.lease_id == id
                && prepared.launch.lease_id == id
                && IntegrationOwner::from(&prepared.intent.scope) == self.header.owner,
            "NATIVE_CODE_SERVICE_PREPARATION_CHANGED"
        );
        Ok(Some((prepared.intent, prepared.launch)))
    }
    pub fn commit_native_code(
        &self,
        record: NativeCodeServiceRecord,
    ) -> Result<NativeCodeServiceRecord> {
        record.validate()?;
        ensure!(
            record.revision == 1
                && record.state == NativeCodeServiceState::Approved
                && IntegrationOwner::from(&record.intent.scope) == self.header.owner,
            "NATIVE_CODE_SERVICE_INITIAL_RECORD_INVALID"
        );
        let _writer = self.writer()?;
        let (intent, launch) = self
            .read_native_code_preparation(&record.intent.lease_id)?
            .context("NATIVE_CODE_SERVICE_PREPARATION_REQUIRED")?;
        ensure!(
            intent == record.intent,
            "NATIVE_CODE_SERVICE_ORIGINAL_INTENT_CONFLICT"
        );
        if let Some(prior) = self.native_code_stored(&record.intent.lease_id)? {
            ensure!(
                prior.record.intent == record.intent && prior.record.grant_ref == record.grant_ref,
                "NATIVE_CODE_SERVICE_ORIGINAL_INTENT_CONFLICT"
            );
            return Ok(prior.record);
        }
        ensure!(
            self.directory.count_regular_files_bounded(
                |name| name.to_str().is_some_and(
                    |name| name.starts_with("native-code-record-") && name.ends_with(".json")
                ),
                MAX_LEASES + 1
            )? < MAX_LEASES,
            "SERVICE_LEASE_CAPACITY"
        );
        let lock_name = code_lock_name(&record.intent.lease_id)?;
        let lock = self
            .directory
            .open_read_write_file(OsStr::new(&lock_name), true)
            .context("NATIVE_CODE_SERVICE_INITIALIZATION_UNCONFIRMED")?;
        let stored = CodeStored {
            record: record.clone(),
            launch,
            owner_lock_identity: self.directory.portable_regular_handle_identity(&lock)?,
            runtime_claimed: false,
        };
        self.write_code_bytes(&code_name(&record.intent.lease_id, "record")?, &stored)?;
        Ok(record)
    }
    pub fn read_native_code(&self, id: &str) -> Result<Option<NativeCodeServiceRecord>> {
        self.verify()?;
        Ok(self.native_code_stored(id)?.map(|stored| stored.record))
    }
    pub fn read_native_code_launch(&self, id: &str) -> Result<NativeCodeServiceLaunchSpec> {
        self.verify()?;
        Ok(self
            .native_code_stored(id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?
            .launch)
    }
    pub fn claim_native_code_owner(&self, id: &str) -> Result<Option<VerifiedPrivateLease>> {
        self.verify()?;
        let stored = self
            .native_code_stored(id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        ensure!(
            stored.record.state != NativeCodeServiceState::Revoked,
            "NATIVE_CODE_SERVICE_REVOKED"
        );
        self.directory.try_existing_portable_lock(
            OsStr::new(&code_lock_name(id)?),
            &stored.owner_lock_identity,
            PrivateLeaseMode::Exclusive,
        )
    }
    pub fn transition_native_code(
        &self,
        id: &str,
        expected: u64,
        state: NativeCodeServiceState,
        observed: u64,
    ) -> Result<NativeCodeServiceRecord> {
        let _writer = self.writer()?;
        let mut stored = self
            .native_code_stored(id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        ensure!(
            stored.record.revision == expected,
            "NATIVE_CODE_SERVICE_REVISION_CONFLICT"
        );
        ensure!(
            stored.record.state != NativeCodeServiceState::Revoked
                || state == NativeCodeServiceState::Revoked,
            "NATIVE_CODE_SERVICE_REVOCATION_IMMUTABLE"
        );
        stored.record.revision = stored
            .record
            .revision
            .checked_add(1)
            .context("NATIVE_CODE_SERVICE_REVISION_LIMIT")?;
        stored.record.state = state;
        if state == NativeCodeServiceState::Revoked {
            stored.record.enabled = false;
        }
        stored.record.observed_at_ms = observed;
        stored.record.validate()?;
        self.write_code_bytes(&code_name(id, "record")?, &stored)?;
        Ok(stored.record)
    }
    pub fn claim_native_code_runtime(&self, id: &str) -> Result<bool> {
        let _writer = self.writer()?;
        let mut stored = self
            .native_code_stored(id)?
            .context("NATIVE_CODE_SERVICE_NOT_FOUND")?;
        if stored.runtime_claimed {
            return Ok(false);
        }
        stored.runtime_claimed = true;
        stored.record.revision = stored
            .record
            .revision
            .checked_add(1)
            .context("NATIVE_CODE_SERVICE_REVISION_LIMIT")?;
        stored.record.validate()?;
        self.write_code_bytes(&code_name(id, "record")?, &stored)?;
        Ok(true)
    }
    fn native_code_stored(&self, id: &str) -> Result<Option<CodeStored>> {
        self.verify()?;
        let Some(bytes) = self.optional_code_bytes(&code_name(id, "record")?)? else {
            return Ok(None);
        };
        let stored: CodeStored = serde_json::from_slice(&bytes)?;
        stored.record.validate()?;
        stored.launch.validate()?;
        ensure!(
            stored.record.intent.lease_id == id
                && stored.launch.lease_id == id
                && IntegrationOwner::from(&stored.record.intent.scope) == self.header.owner
                && self
                    .directory
                    .portable_regular_identity(OsStr::new(&code_lock_name(id)?))?
                    == stored.owner_lock_identity,
            "NATIVE_CODE_SERVICE_RECORD_CHANGED"
        );
        Ok(Some(stored))
    }
    fn optional_code_bytes(&self, name: &str) -> Result<Option<Vec<u8>>> {
        match self
            .directory
            .open_single_link_regular_file(OsStr::new(name))
        {
            Ok(file) => Ok(Some(read_file(file)?)),
            Err(error) if missing(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }
    fn write_code_bytes(&self, name: &str, value: &impl Serialize) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        ensure!(
            bytes.len() <= MAX_RECORD_BYTES,
            "SERVICE_LEASE_RECORD_TOO_LARGE"
        );
        self.directory.atomic_replace(OsStr::new(name), &bytes)?;
        self.verify()
    }
}
fn code_name(id: &str, stage: &str) -> Result<String> {
    let (name, _) = names(id)?;
    Ok(name.replace("lease-", &format!("native-code-{stage}-")))
}
fn code_lock_name(id: &str) -> Result<String> {
    let (_, name) = names(id)?;
    Ok(name.replace("lease-", "native-code-"))
}

#[cfg(test)]
mod tests;
