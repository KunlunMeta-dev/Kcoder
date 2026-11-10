//! Native Wiki publication reads and publisher-owned catalog observations.

use anyhow::{Context, Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use kcoder_knowledge::{
    KnowledgeCatalog, KnowledgeScope, integrations::knowledge::CatalogReadLimits,
};
use kcoder_native_scope::NativeIntegrationContext;
use kcoder_types::integrations::{
    core::{IntegrationNullable, IntegrationScope},
    knowledge::{
        KnowledgeOwner, KnowledgeSourceObservation, PublicationSource, PublishedKnowledgePage,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "linux")]
#[path = "../../../app_server/integrations/knowledge/native_host/publications/publisher_catalog.rs"]
mod publisher_catalog;
#[cfg(target_os = "linux")]
#[path = "../../../app_server/integrations/knowledge/native_host/publications/shared_directory_reader.rs"]
mod shared_directory_reader;
#[path = "../../../app_server/integrations/knowledge/native_host/publications/shared_reader.rs"]
mod shared_reader;

pub use shared_reader::run as run_shared_publication_read_helper;

pub const DB: &str = "catalog.sqlite";
pub const LOCK: &str = "catalog.lock";
pub const OBJECTS: &str = "catalog.objects";
pub const BINDING: &str = "catalog-binding.json";

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub version: u32,
    pub owner: KnowledgeOwner,
    pub namespace_identity: String,
    pub binding_identity: PortableLeaseIdentity,
    pub database_identity: PortableLeaseIdentity,
    pub lock_identity: PortableLeaseIdentity,
    pub objects_identity: String,
}
pub fn read_binding(directory: &PrivateDirectory) -> Result<Binding> {
    let file = directory.open_single_link_regular_file(OsStr::new(BINDING))?;
    let mut bytes = Vec::new();
    file.take(16 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 16 * 1024, "KNOWLEDGE_NATIVE_BINDING_CHANGED");
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn same_account_other_workspace(owner: &KnowledgeOwner, scope: &IntegrationScope) -> bool {
    owner.account_id == scope.account_id
        && owner.target_id == scope.target_id
        && owner.workspace_id != scope.workspace_id
        && matches!(owner.workspace_id, IntegrationNullable::Value(_))
        && matches!(scope.workspace_id, IntegrationNullable::Value(_))
        && matches!(scope.organization_id, Some(IntegrationNullable::Value(_)))
        && owner.organization_id == scope.organization_id
}

pub fn resource_id(kind: &str, owner: &KnowledgeOwner, id: &str) -> Result<String> {
    let family = match kind {
        "knowledge" | "publication" | "knowledge-audience" | "wiki_page" | "memory" => "knowledge",
        "automation" | "automation-templates" => "automation",
        "delivery-destination" => "connection",
        _ => anyhow::bail!("KNOWLEDGE_ORGANIZATION_RESOURCE_UNAVAILABLE"),
    };
    let material = serde_json::to_vec(&(
        "native-knowledge-resource-v1",
        kind,
        &owner.account_id,
        &owner.target_id,
        &owner.workspace_id,
        &owner.organization_id,
        id,
    ))?;
    Ok(format!("{family}:{:x}", Sha256::digest(material)))
}

pub fn catalog_scope_for_profile(path: &Path) -> Result<(std::path::PathBuf, KnowledgeScope)> {
    let profile = path
        .parent()
        .context("knowledge profile storage unavailable")?
        .canonicalize()?;
    let principal = match std::env::var("KCODER_ACCOUNT_PRINCIPAL_ID") {
        Ok(value) => uuid::Uuid::parse_str(&value)
            .context("invalid host account identity")?
            .to_string(),
        Err(std::env::VarError::NotPresent) => format!("profile:{}", profile.display()),
        Err(error) => return Err(error.into()),
    };
    // Plain SSH compatibility is single-user by profile. Account mode gets a
    // stable principal from the trusted launcher and its private worker home.
    let scope = KnowledgeScope::from_authenticated_host(&principal, "execution-host")?;
    Ok((profile, scope))
}

/// The root supplies this native callback, never a body/principal field from the request.
pub trait NativeWikiPublicationResolver: Send + Sync {
    fn resolve_fixed_pages(
        &self,
        native: &NativeIntegrationContext,
        sources: &[PublicationSource],
        cancel: &CancellationToken,
    ) -> Result<Vec<PublishedKnowledgePage>>;
    fn observe_fixed_sources(
        &self,
        _native: &NativeIntegrationContext,
        _sources: &[PublicationSource],
        _cancel: &CancellationToken,
        _now_ms: u64,
    ) -> Result<Vec<KnowledgeSourceObservation>> {
        anyhow::bail!("KNOWLEDGE_SOURCE_UNAVAILABLE")
    }
}
/// Uses the existing target's real scope getter and held-file/WAL reader. The settings
/// location must come from the actual Engine; no RPC accepts a path for this constructor.
pub struct ExistingProfileWikiResolver {
    settings_path: PathBuf,
}

pub fn original_owned_wiki_scope(
    catalog: &KnowledgeCatalog,
    current: &kcoder_knowledge::KnowledgeScope,
    profile: &Path,
    library: &str,
) -> Result<kcoder_knowledge::KnowledgeScope> {
    match catalog.read(current, library) {
        Ok(_) => Ok(current.clone()),
        Err(error) if error.to_string() == "knowledge library not found" => {
            // The authenticated native profile is already held and verified by
            // the caller. This value routes only original same-profile data;
            // it never replaces current caller identity or a resource policy.
            let original = kcoder_knowledge::KnowledgeScope::from_authenticated_host(
                &format!("profile:{}", profile.display()),
                "execution-host",
            )?;
            catalog.read(&original, library)?;
            Ok(original)
        }
        Err(error) => Err(error),
    }
}
impl ExistingProfileWikiResolver {
    pub fn new(native: &NativeIntegrationContext, settings_path: &Path) -> Result<Self> {
        native.verify()?;
        let (profile, _) = catalog_scope_for_profile(settings_path)?;
        let actual = PrivateDirectory::open_existing(&profile)?;
        ensure!(
            actual.directory_identity()? == native.profile()?.directory_identity()?,
            "KNOWLEDGE_NATIVE_PROFILE_MISMATCH"
        );
        Ok(Self {
            settings_path: settings_path.to_path_buf(),
        })
    }
    pub fn resolve_fixed_material(
        &self,
        native: &NativeIntegrationContext,
        sources: &[PublicationSource],
        cancel: &CancellationToken,
    ) -> Result<Vec<kcoder_knowledge::StoredPage>> {
        native.verify()?;
        let (profile, legacy) = catalog_scope_for_profile(&self.settings_path)?;
        ensure!(
            PrivateDirectory::open_existing(&profile)?.directory_identity()?
                == native.profile()?.directory_identity()?,
            "KNOWLEDGE_NATIVE_PROFILE_MISMATCH"
        );
        let observed = KnowledgeCatalog::open_existing_native_directory(
            native
                .profile()?
                .open_child(OsStr::new("knowledge"), false)?,
            OsStr::new("state.sqlite"),
            OsStr::new("state.objects"),
            cancel,
            CatalogReadLimits::default(),
        )?;
        let (pages, _) = observed.with_catalog(|catalog| {
            sources
                .iter()
                .map(|source| {
                    let data_scope =
                        original_owned_wiki_scope(catalog, &legacy, &profile, &source.library_id)?;
                    catalog.read_page(
                        &data_scope,
                        &source.library_id,
                        &source.page_id,
                        Some(&source.page_revision),
                    )
                })
                .collect::<Result<Vec<_>>>()
        })?;
        native.verify()?;
        Ok(pages)
    }
}
impl NativeWikiPublicationResolver for ExistingProfileWikiResolver {
    fn resolve_fixed_pages(
        &self,
        native: &NativeIntegrationContext,
        sources: &[PublicationSource],
        cancel: &CancellationToken,
    ) -> Result<Vec<PublishedKnowledgePage>> {
        Ok(self
            .resolve_fixed_material(native, sources, cancel)?
            .into_iter()
            .zip(sources)
            .map(|(page, source)| PublishedKnowledgePage {
                source: source.clone(),
                title: page.draft.title,
                markdown: page.draft.markdown,
            })
            .collect())
    }
    fn observe_fixed_sources(
        &self,
        native: &NativeIntegrationContext,
        sources: &[PublicationSource],
        cancel: &CancellationToken,
        now_ms: u64,
    ) -> Result<Vec<KnowledgeSourceObservation>> {
        native.verify()?;
        let (profile, legacy) = catalog_scope_for_profile(&self.settings_path)?;
        ensure!(
            PrivateDirectory::open_existing(&profile)?.directory_identity()?
                == native.profile()?.directory_identity()?,
            "KNOWLEDGE_NATIVE_PROFILE_MISMATCH"
        );
        let observed = KnowledgeCatalog::open_existing_native_directory(
            native
                .profile()?
                .open_child(OsStr::new("knowledge"), false)?,
            OsStr::new("state.sqlite"),
            OsStr::new("state.objects"),
            cancel,
            CatalogReadLimits::default(),
        )?;
        let (observations, _) = observed.with_catalog(|catalog| {
            sources
                .iter()
                .map(|source| {
                    let data_scope =
                        original_owned_wiki_scope(catalog, &legacy, &profile, &source.library_id)?;
                    catalog.observe_fixed_page_source(&data_scope, source, now_ms)
                })
                .collect::<Result<Vec<_>>>()
        })?;
        native.verify()?;
        Ok(observations)
    }
}
