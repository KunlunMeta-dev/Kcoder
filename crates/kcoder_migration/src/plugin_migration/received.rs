//! Received candidates carry private receipt/preview authority, never a client filesystem path.
use super::{PluginMigrationCandidate, discovery::Source};
use anyhow::Result;
use kcoder_config::PrivateDirectory;
use sha2::{Digest, Sha256};
impl PluginMigrationCandidate {
    pub(crate) fn from_received(
        archive: crate::source_transfer::ReceivedPluginArchive,
    ) -> Result<Self> {
        archive.verify_preview()?;
        let origin = archive.origin()?;
        let logical = archive.logical_identity()?;
        let root = archive.profile().canonicalize()?;
        let directory = PrivateDirectory::open_existing(&root)?;
        directory.verify_private_directory()?;
        let candidate = format!("{:x}", Sha256::digest(serde_json::to_vec(&archive)?));
        let source_id = format!("{}@received-{}", origin.name, &logical[..16]);
        Ok(Self {
            id: candidate,
            source: origin.source,
            name: origin.name,
            installed_version: origin.version.clone(),
            scope: origin.scope.clone(),
            source_enabled: origin.source_enabled,
            pending: origin.pending,
            binding: Some(Source {
                root,
                identity: directory.directory_identity()?,
                kind: origin.source,
                source_id,
                version: origin.version.unwrap_or_else(|| "received".into()),
                relative: Default::default(),
                metadata: Vec::new(),
                cache_listing: None,
                source_scope: origin.scope,
                project: None,
                received: Some(Box::new(archive)),
                uploaded: None,
            }),
        })
    }
}
