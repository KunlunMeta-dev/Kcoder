//! A target-owned lifecycle locator, never an execution or delegation permit.
use super::*;
use serde::{Deserialize, Serialize};
use std::{ffi::OsStr, io::Read};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Revision {
    schema_version: u32,
    owner: IntegrationOwner,
    identity_generation: String,
    target_revision: String,
}

pub(super) fn name(scope: &IntegrationScope) -> Result<String> {
    Ok(format!(
        "native-lifecycle-{:x}.json",
        Sha256::digest(serde_json::to_vec(&(
            IntegrationOwner::from(scope),
            &scope.identity_generation
        ))?)
    ))
}

pub(super) fn read(
    profile: &PrivateDirectory,
    scope: &IntegrationScope,
    filename: &str,
) -> Result<Option<String>> {
    // The captured locator is immutable; file contents and authority remain live reads.
    let file = match profile.open_single_link_regular_file(OsStr::new(filename)) {
        Ok(file) => file,
        Err(error)
            if error.chain().any(|cause| {
                cause
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            }) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(4097).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 4096,
        "INTEGRATION_LIFECYCLE_REVISION_INVALID"
    );
    let record: Revision = serde_json::from_slice(&bytes)?;
    ensure!(
        record.schema_version == 1
            && record.owner == IntegrationOwner::from(scope)
            && record.identity_generation == scope.identity_generation,
        "INTEGRATION_LIFECYCLE_OWNER_CHANGED"
    );
    let mut candidate = scope.clone();
    candidate.target_revision = record.target_revision.clone();
    candidate.validate()?;
    Ok(Some(record.target_revision))
}

impl NativeIntegrationContext {
    /// The authenticated Native handshake pins the existing lifecycle epoch.
    /// Model revisions remain independently checked by task admission.
    pub fn pin_lifecycle_revision(&mut self) -> Result<()> {
        self.verify()?;
        let filename = &self.lifecycle_revision_name;
        let _lock = self
            .profile
            .try_exclusive_lock(OsStr::new(&format!("{filename}.lock")))?
            .context("INTEGRATION_LIFECYCLE_WRITER_BUSY")?;
        if let Some(revision) = read(&self.profile, &self.scope, filename)? {
            self.scope.target_revision = revision;
            self.lifecycle_revision_required = true;
            return Ok(());
        }
        let record = Revision {
            schema_version: 1,
            owner: IntegrationOwner::from(&self.scope),
            identity_generation: self.scope.identity_generation.clone(),
            target_revision: self.scope.target_revision.clone(),
        };
        self.profile
            .atomic_replace(OsStr::new(filename), &serde_json::to_vec(&record)?)?;
        self.lifecycle_revision_required = true;
        self.verify()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removing_an_observed_lifecycle_locator_cannot_downgrade_a_live_context() -> Result<()> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("profile");
        let workspace = root.path().join("workspace");
        PrivateDirectory::open_or_create(&profile)?;
        PrivateDirectory::open_or_create(&workspace)?;
        let legacy = Arc::new(NativeIntegrationContext::capture(
            &profile, &workspace, "ui", "model",
        )?);
        let retained_legacy = legacy.retain_for_checked_operation()?;
        assert!(!Arc::ptr_eq(&legacy, &retained_legacy));
        let mut native = NativeIntegrationContext::capture(&profile, &workspace, "ui", "model")?;
        native.pin_lifecycle_revision()?;
        let reopened = Arc::new(NativeIntegrationContext::capture_existing(
            &profile,
            &workspace,
            "reopen",
            "other-model",
        )?);
        let retained = reopened.retain_for_checked_operation()?;
        assert!(Arc::ptr_eq(&reopened, &retained));
        std::fs::remove_file(profile.join(name(native.scope())?))?;
        assert!(native.verify().is_err());
        assert!(reopened.verify().is_err());
        assert!(retained.verify().is_err());
        assert!(
            native
                .refresh_configuration_revision("new-model".into())
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn lifecycle_survives_model_revision_and_reopen_without_bypassing_identity() -> Result<()> {
        let root = tempfile::tempdir()?;
        let profile = root.path().join("profile");
        let workspace = root.path().join("workspace");
        PrivateDirectory::open_or_create(&profile)?;
        PrivateDirectory::open_or_create(&workspace)?;
        let mut native =
            NativeIntegrationContext::capture(&profile, &workspace, "ui", "model-one")?;
        native.pin_lifecycle_revision()?;
        let original = native.scope().clone();
        let original_name = native.lifecycle_revision_name.clone();
        native.refresh_configuration_revision("model-two".into())?;
        assert_eq!(native.scope(), &original);
        assert_eq!(native.lifecycle_revision_name, original_name);
        assert_eq!(native.lifecycle_revision_name, name(native.scope())?);
        let reopened = NativeIntegrationContext::capture_existing(
            &profile,
            &workspace,
            "reopen",
            "model-three",
        )?;
        reopened.validate_scope(&original)?;
        let mut forged = original.clone();
        forged.target_revision = "caller-selected-revision".into();
        assert!(reopened.validate_scope(&forged).is_err());
        let revision = native.identity.snapshot(&native.profile)?.revision;
        native.identity.disable(
            &native.profile,
            "original-revoke",
            revision,
            1_793_612_000_000,
        )?;
        assert!(native.verify().is_err());
        assert!(reopened.verify().is_err());
        Ok(())
    }
}
