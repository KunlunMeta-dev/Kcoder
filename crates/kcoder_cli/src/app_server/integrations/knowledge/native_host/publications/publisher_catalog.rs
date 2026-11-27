//! Original publisher-owned namespace observation; no root body reads or caller-scope replacement.
use super::{OBJECTS, PublicationAnchors, read_binding};
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_knowledge::{KnowledgeCatalog, integrations::knowledge::CatalogReadLimits};
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_types::integrations::knowledge::KnowledgeOwner;
use std::path::{Path, PathBuf};
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
    binding.verify_profile_binding(profile)?;
    ensure!(
        &binding.owner == owner,
        "KNOWLEDGE_SHARED_READER_BINDING_CHANGED"
    );
    let anchors = PublicationAnchors::observe(&directory, &binding)?;
    let verify = || -> Result<()> {
        anchors.verify(&guard.directory(profile)?, &binding)?;
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
        &anchors.database_identity()?,
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
