//! Private frozen launch facts in the original journal, separate from model/public intent.
use super::*;
use kcoder_config::SourceDocumentSnapshot;

/// A bounded FD-backed read of the exact frozen original launch. It is not an
/// execution grant and never enters a public projection or model transcript.
pub struct NativeRemoteLaunchSnapshot {
    snapshot: SourceDocumentSnapshot,
}
impl NativeRemoteLaunchSnapshot {
    pub fn bytes(&self) -> &[u8] {
        self.snapshot.bytes()
    }
    pub fn sha256(&self) -> &str {
        &self.snapshot.sha256
    }
}
impl NativeRemoteDelegationStore {
    /// Native factory calls only after actual current Tool/Accepted admission.
    /// The bytes contain private native locations/receipt pins, never credentials.
    /// No launch can be replaced after a dispatch, including an unknown dispatch.
    pub fn freeze_native_launch(
        &self,
        operation: &str,
        scope: &IntegrationScope,
        bytes: &[u8],
    ) -> Result<()> {
        label(operation)?;
        scope.validate()?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= 64 * 1024,
            "REMOTE_NATIVE_LAUNCH_LIMIT"
        );
        let hash = format!("{:x}", Sha256::digest(bytes));
        let name = launch_leaf(operation);
        self.mutate(|ledger| {
            let record = ledger
                .entries
                .get_mut(operation)
                .context("REMOTE_ORIGINAL_OPERATION_MISSING")?;
            ensure!(
                &record.scope_at_creation == scope,
                "REMOTE_ACTIVE_SCOPE_CHANGED"
            );
            if let Some(original) = &record.native_launch_sha256 {
                ensure!(original == &hash, "REMOTE_NATIVE_LAUNCH_IMMUTABLE");
                let actual = self.read_native_launch_file(&name)?;
                ensure!(
                    actual.sha256 == hash && actual.bytes() == bytes,
                    "REMOTE_NATIVE_LAUNCH_CHANGED"
                );
                return Ok(());
            }
            ensure!(
                record.stages.is_empty(),
                "REMOTE_NATIVE_LAUNCH_BEFORE_DISPATCH_REQUIRED"
            );
            // A lost first write receipt may leave the exact owned immutable bytes.
            // Reconcile them; never overwrite a different unexplained file.
            match self.directory.entry_metadata(OsStr::new(&name)) {
                Ok(_) => {
                    let actual = self.read_native_launch_file(&name)?;
                    ensure!(
                        actual.sha256 == hash && actual.bytes() == bytes,
                        "REMOTE_NATIVE_LAUNCH_UNCONFIRMED"
                    );
                }
                Err(error)
                    if error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
                {
                    self.directory.atomic_replace(OsStr::new(&name), bytes)?
                }
                Err(error) => return Err(error),
            }
            record.native_launch_sha256 = Some(hash);
            record.revision = next(record.revision)?;
            ledger.revision = next(ledger.revision)?;
            Ok(())
        })
    }
    /// Pure original-operation lookup. Missing or corrupt original launch facts
    /// cannot be repaired, adopted from caller metadata, or replaced on retry.
    pub fn read_native_launch(
        &self,
        operation: &str,
    ) -> Result<Option<NativeRemoteLaunchSnapshot>> {
        label(operation)?;
        let ledger = self.load()?;
        let Some(record) = ledger.entries.get(operation) else {
            return Ok(None);
        };
        let Some(expected) = &record.native_launch_sha256 else {
            return Ok(None);
        };
        let snapshot = self.read_native_launch_file(&launch_leaf(operation))?;
        ensure!(&snapshot.sha256 == expected, "REMOTE_NATIVE_LAUNCH_CHANGED");
        self.verify()?;
        Ok(Some(NativeRemoteLaunchSnapshot { snapshot }))
    }
    fn read_native_launch_file(&self, name: &str) -> Result<SourceDocumentSnapshot> {
        self.directory
            .read_source_document_snapshot(OsStr::new(name), 64 * 1024, || self.verify().is_ok())
    }
}
fn launch_leaf(operation: &str) -> String {
    format!("launch-{:x}.json", Sha256::digest(operation.as_bytes()))
}
