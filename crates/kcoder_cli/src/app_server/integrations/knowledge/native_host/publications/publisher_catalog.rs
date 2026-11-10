//! Original publisher-owned namespace observation; no root body reads or caller-scope replacement.
use super::{BINDING, DB, LOCK, OBJECTS, read_binding};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::{KnowledgeCatalog, integrations::knowledge::CatalogReadLimits};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::knowledge::KnowledgeOwner;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

pub(super) struct Facts {
    pub(super) generation: String,
    pub(super) revision: u64,
    pub(super) proof: kcoder_knowledge::integrations::knowledge::CatalogReadProof,
}

pub(super) fn with_catalog<T>(
    owner: &KnowledgeOwner,
    principal: &str,
    read: impl FnOnce(&mut KnowledgeCatalog) -> Result<T>,
) -> Result<(T, Facts)> {
    ensure!(
        std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID").ok().as_deref() == Some(principal),
        "KNOWLEDGE_SHARED_READER_REFERENCE_DENIED"
    );
    let home = PathBuf::from(
        std::env::var_os("HOME")
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_READER_HOME_REQUIRED"))?,
    );
    let profile_path = home.join(".config/kcoder");
    let profile = PrivateDirectory::open_existing(&profile_path)?;
    with_publisher_workspace(&profile, &home, owner, |workspace| {
        with_workspace_catalog(&profile_path, &profile, workspace, owner, read)
    })
}

fn with_publisher_workspace<T>(
    profile: &PrivateDirectory,
    home: &Path,
    owner: &KnowledgeOwner,
    read: impl FnOnce(&PrivateDirectory) -> Result<T>,
) -> Result<T> {
    let default_path = home.join("workspace");
    let default = PrivateDirectory::open_existing(&default_path)?;
    match NativeIntegrationContext::observe_publication_data_scope(profile, &default, owner) {
        Ok(_) => return read(&default),
        Err(error) if error.to_string() == "KNOWLEDGE_PUBLISHER_DATA_OWNER_MISMATCH" => {}
        Err(error) => return Err(error),
    }
    // Only the publisher UID reads its existing Native registration. No caller
    // path or title is accepted, and observation cannot create a workspace.
    let configured = PrivateDirectory::open_existing(&kcoder_config::Settings::config_dir()?)?;
    ensure!(
        configured.directory_identity()? == profile.directory_identity()?,
        "KNOWLEDGE_NATIVE_PROFILE_MISMATCH"
    );
    let registry_root = kcoder_config::Settings::project_data_dir(&default_path)?;
    let registry =
        kcoder_config::imported_projects::ProjectWorkspaceRegistry::open_native(&registry_root)?;
    for (project, membership) in registry.pinned_projects()? {
        for path in project.roots {
            let path = PathBuf::from(path);
            let workspace = match PrivateDirectory::open_existing(&path) {
                Ok(workspace) => workspace,
                Err(_) => continue,
            };
            if workspace.verify_private_directory().is_err() {
                continue;
            }
            match NativeIntegrationContext::observe_publication_data_scope(
                profile, &workspace, owner,
            ) {
                Ok(_) => {
                    return membership.with_registered(|| {
                        let identity = workspace.directory_identity()?;
                        ensure!(
                            PrivateDirectory::open_existing(&path)?.directory_identity()?
                                == identity,
                            "KNOWLEDGE_PUBLISHER_WORKSPACE_CHANGED"
                        );
                        let value = read(&workspace)?;
                        ensure!(
                            PrivateDirectory::open_existing(&path)?.directory_identity()?
                                == identity,
                            "KNOWLEDGE_PUBLISHER_WORKSPACE_CHANGED"
                        );
                        membership.with_registered(|| Ok(value))
                    });
                }
                Err(error) if error.to_string() == "KNOWLEDGE_PUBLISHER_DATA_OWNER_MISMATCH" => {}
                Err(error) => return Err(error),
            }
        }
    }
    anyhow::bail!("KNOWLEDGE_PUBLISHER_WORKSPACE_UNAVAILABLE")
}

fn with_workspace_catalog<T>(
    profile_path: &Path,
    profile: &PrivateDirectory,
    workspace: &PrivateDirectory,
    owner: &KnowledgeOwner,
    read: impl FnOnce(&mut KnowledgeCatalog) -> Result<T>,
) -> Result<(T, Facts)> {
    let (data_scope, identity) =
        NativeIntegrationContext::observe_publication_data_scope(profile, workspace, owner)?;
    let before_identity = identity.snapshot(profile)?;
    let guard = NativeDomainGuard::observe(profile, &data_scope, NativeDomain::Knowledge)?
        .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_SHARED_READER_STORE_UNAVAILABLE"))?;
    let directory = guard.directory(profile)?;
    let binding = read_binding(&directory)?;
    ensure!(
        binding.version == 1
            && &binding.owner == owner
            && binding.namespace_identity == directory.directory_identity()?,
        "KNOWLEDGE_SHARED_READER_BINDING_CHANGED"
    );
    let binding_anchor = directory.open_single_link_regular_file(OsStr::new(BINDING))?;
    let database_anchor = directory.open_single_link_regular_file(OsStr::new(DB))?;
    let lock_anchor = directory.open_single_link_regular_file(OsStr::new(LOCK))?;
    let objects = directory.open_child(OsStr::new(OBJECTS), false)?;
    let verify = || -> Result<()> {
        objects.verify_private_directory()?;
        ensure!(
            guard.directory(profile)?.directory_identity()? == binding.namespace_identity
                && read_binding(&directory)? == binding
                && directory.portable_regular_handle_identity(&binding_anchor)?
                    == binding.binding_identity
                && directory.portable_regular_handle_identity(&database_anchor)?
                    == binding.database_identity
                && directory.portable_regular_handle_identity(&lock_anchor)?
                    == binding.lock_identity
                && objects.directory_identity()? == binding.objects_identity
                && directory
                    .open_child(OsStr::new(OBJECTS), false)?
                    .directory_identity()?
                    == binding.objects_identity,
            "KNOWLEDGE_SHARED_READER_BINDING_CHANGED"
        );
        for (name, expected) in [
            (DB, &binding.database_identity),
            (LOCK, &binding.lock_identity),
            (BINDING, &binding.binding_identity),
        ] {
            ensure!(
                directory.portable_regular_identity(OsStr::new(name))? == *expected,
                "KNOWLEDGE_SHARED_READER_BINDING_CHANGED"
            );
        }
        let current = identity.snapshot(profile)?;
        ensure!(
            current.enabled && current == before_identity,
            "INTEGRATION_IDENTITY_REVOKED"
        );
        Ok(())
    };
    verify()?;
    let cancel = CancellationToken::new();
    let (result, proof) = KnowledgeCatalog::open_existing_native_owned(
        &directory,
        &binding.database_identity,
        &binding.lock_identity,
        &profile_path.join(guard.namespace_id()).join(OBJECTS),
        &cancel,
        CatalogReadLimits::default(),
    )?
    .with_catalog(read)?;
    verify()?;
    Ok((
        result,
        Facts {
            generation: before_identity.generation,
            revision: before_identity.revision,
            proof,
        },
    ))
}
