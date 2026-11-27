//! Read-only provenance of this owner's metadata inside another sealed tree.
use super::*;

/// A bounded source observation, not execution, deletion or namespace authority.
/// Deserializing it never substitutes for the caller's fresh source validation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryRelocationMetadata {
    version: u8,
    directory: String,
    record: Option<(PortableLeaseIdentity, String)>,
}

impl HistoryRelocationMetadata {
    /// Only the exact metadata observed or verified at this explicit boundary
    /// may be excluded from another owner's business-payload snapshot.
    pub fn is_metadata_entry(&self, directory: &PrivateDirectory, name: &OsStr) -> Result<bool> {
        if name != OsStr::new(RECORD) {
            return Ok(false);
        }
        ensure!(
            observe_relocation_metadata(directory)? == *self,
            "HISTORY_RELOCATION_METADATA_CHANGED"
        );
        Ok(self.record.is_some())
    }
}

fn observation(
    directory: &PrivateDirectory,
    record: Option<HeldRecord>,
) -> Result<HistoryRelocationMetadata> {
    Ok(HistoryRelocationMetadata {
        version: 1,
        directory: directory.directory_identity()?,
        record: record.map(|record| (record.value.record_identity, hash(&record.bytes))),
    })
}

/// Observe this owner's actual current sidecar and held directory. The caller
/// supplies an already scoped directory; this function does not discover a
/// profile, adopt an unknown target, or scan a payload tree.
pub fn observe_relocation_metadata(
    directory: &PrivateDirectory,
) -> Result<HistoryRelocationMetadata> {
    observation(directory, read_record(directory)?)
}

/// Verify only this operation's new metadata against an actual source
/// observation. Other owners still compare every business file themselves.
/// The published capability is rechecked rather than cached as authorization.
pub fn verify_relocation_metadata(
    published: &StoragePublishedComponent,
    directory: &PrivateDirectory,
    source: &HistoryRelocationMetadata,
) -> Result<HistoryRelocationMetadata> {
    ensure!(
        source.version == 1,
        "HISTORY_RELOCATION_VERSION_UNSUPPORTED"
    );
    published.verify()?;
    ensure!(
        published.domain() == kcoder_types::STORAGE_PERSISTENT_ROOT_DOMAIN,
        "HISTORY_RELOCATION_PUBLISHED_COMPONENT_MISMATCH"
    );
    let record = read_record(directory)?;
    if let Some(record) = &record {
        ensure!(
            record.value.operation == published.operation_id()
                && record.value.source_profile == published.source_identity()
                && record.value.target_profile == published.directory().directory_identity()?
                && record.value.source.identity == source.directory
                && record.value.source.prior_record == source.record,
            "HISTORY_RELOCATION_METADATA_CHANGED"
        );
    } else {
        ensure!(
            source.record.is_none(),
            "HISTORY_RELOCATION_METADATA_MISSING"
        );
    }
    let verified = observation(directory, record)?;
    published.verify()?;
    Ok(verified)
}
