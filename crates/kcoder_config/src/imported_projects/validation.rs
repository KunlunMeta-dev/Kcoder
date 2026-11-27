use super::*;
use std::collections::BTreeSet;

pub(super) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}
pub(super) fn sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
pub(super) fn owner(owner: &ImportedProjectOwner) -> Result<()> {
    ensure!(
        identifier(&owner.operation_id) && identifier(&owner.action_id),
        "imported_project_invalid_owner"
    );
    Ok(())
}
pub(super) fn record(record: &ImportedProjectAssociation) -> Result<()> {
    owner(&record.owner)?;
    ensure!(
        identifier(&record.id)
            && record.revision > 0
            && text(&record.source.project_id, 256)
            && record.source.project_name.len() <= 4096
            && !record.source.project_name.chars().any(char::is_control)
            && text(&record.source.format_revision, 128)
            && sha(&record.source.snapshot_sha256)
            && text(&record.target.project_key, 4096)
            && record.target.workspace.is_absolute()
            && text(&record.target.workspace_identity, 256)
            && record.target.roots.len() <= 16,
        "imported_project_invalid_record"
    );
    let mut sources = BTreeSet::new();
    let mut targets = BTreeSet::new();
    for root in &record.target.roots {
        ensure!(
            identifier(&root.source_root_id)
                && text(&root.source_path, 4096)
                && root.target_root.is_absolute()
                && text(&root.target_identity, 256)
                && sources.insert(&root.source_root_id)
                && targets.insert(&root.target_identity),
            "imported_project_invalid_mapping"
        );
    }
    Ok(())
}
pub(super) fn target(profile: &Path, target: &ImportedProjectTarget) -> Result<()> {
    let trust = crate::FolderTrustStore::load(profile);
    for (path, identity) in std::iter::once((&target.workspace, &target.workspace_identity)).chain(
        target
            .roots
            .iter()
            .map(|root| (&root.target_root, &root.target_identity)),
    ) {
        ensure!(
            !path.components().any(|part| matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )),
            "imported_project_target_changed"
        );
        let directory = PrivateDirectory::open_existing(path)
            .map_err(|_| anyhow::anyhow!("imported_project_target_changed"))?;
        directory.verify_trusted_config_directory()?;
        ensure!(
            directory.directory_identity()? == *identity
                && PrivateDirectory::open_existing(&dunce::canonicalize(path)?)?
                    .directory_identity()?
                    == *identity,
            "imported_project_target_changed"
        );
        ensure!(
            trust.check(path) == crate::FolderTrust::Trusted,
            "imported_project_target_untrusted"
        );
    }
    Ok(())
}
