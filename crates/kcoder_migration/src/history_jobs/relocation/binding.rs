use super::*;

pub(in crate::history_jobs) struct Binding {
    bytes: Option<Vec<u8>>,
    record: Option<Record>,
}

impl Binding {
    pub(in crate::history_jobs) fn open(
        profile: &Path,
        directory: &PrivateDirectory,
        archives: &ExternalHistoryStore,
    ) -> Result<Self> {
        let Some((bytes, identity)) = read_file(directory, RECORD, MAX_RECORD)? else {
            return Ok(Self {
                bytes: None,
                record: None,
            });
        };
        let record: Record =
            serde_json::from_slice(&bytes).context("history_job_relocation_record_invalid")?;
        let root = PrivateDirectory::open_existing(profile)?;
        validate_record(directory, &root, profile, archives, &record, &identity)?;
        Ok(Self {
            bytes: Some(bytes),
            record: Some(record),
        })
    }
    pub(in crate::history_jobs) fn owner<'a>(&'a self, physical: &'a str) -> &'a str {
        self.record
            .as_ref()
            .map_or(physical, |record| record.owner.as_str())
    }
    pub(super) fn record_fingerprint(&self) -> Option<(PortableLeaseIdentity, String)> {
        Some((
            self.record.as_ref()?.identity.clone()?,
            digest(self.bytes.as_ref()?),
        ))
    }
    fn verify(
        &self,
        profile: &Path,
        directory: &PrivateDirectory,
        archives: &ExternalHistoryStore,
    ) -> Result<()> {
        let current = Self::open(profile, directory, archives)?;
        ensure!(
            current.bytes == self.bytes,
            "history_job_relocation_record_changed"
        );
        Ok(())
    }
}

pub(super) fn validate_record(
    directory: &PrivateDirectory,
    root: &PrivateDirectory,
    profile: &Path,
    archives: &ExternalHistoryStore,
    record: &Record,
    identity: &PortableLeaseIdentity,
) -> Result<()> {
    ensure!(
        record.version == 1
            && record.identity.as_ref() == Some(identity)
            && record.target_profile == root.directory_identity()?
            && record.target_directory == directory.directory_identity()?
            && record.target_path == std::fs::canonicalize(profile)?
            && record.target_profile != record.source_profile
            && record.archives_scope == archives.scope_fingerprint()?
            && record.owner.len() == 64
            && record.owner.bytes().all(|byte| byte.is_ascii_hexdigit())
            && record.source_snapshot_sha256.len() == 64,
        "history_job_relocation_record_changed"
    );
    let actual = history_directory(root)?.context("history_job_relocation_record_changed")?;
    ensure!(
        actual.directory_identity()? == directory.directory_identity()?,
        "history_job_relocation_record_changed"
    );
    Ok(())
}

impl HistoryJobStore {
    pub(in crate::history_jobs) fn verify_relocation_binding(&self) -> Result<()> {
        self.relocation
            .verify(&self.profile, &self.directory, &self.archives)
    }
}
