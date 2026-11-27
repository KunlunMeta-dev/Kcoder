use super::*;
use kcoder_config::storage::StoragePublishedComponent;
use kcoder_native_scope::{NativeIdentity, NativeObservedDomain};

pub(super) enum SourceAuthority<'a> {
    Runtime(&'a NativeIntegrationContext),
    Offline {
        entry: &'a NativeObservedDomain,
        identity: &'a NativeIdentity,
        profile: &'a PrivateDirectory,
        path: PathBuf,
    },
}

pub(super) enum TargetAuthority<'a> {
    Runtime(&'a NativeIntegrationContext),
    Offline {
        identity: &'a NativeIdentity,
        published: &'a StoragePublishedComponent,
    },
}

impl<'a> SourceAuthority<'a> {
    pub(super) fn profile(&self) -> Result<&'a PrivateDirectory> {
        match self {
            Self::Runtime(context) => context.profile(),
            Self::Offline { profile, .. } => Ok(profile),
        }
    }
    pub(super) fn path(&self) -> &Path {
        match self {
            Self::Runtime(context) => context.captured_profile_path(),
            Self::Offline { path, .. } => path,
        }
    }
    pub(super) fn epoch(&self) -> Result<(String, u64)> {
        match self {
            Self::Runtime(context) => context.source_authority_epoch(),
            Self::Offline {
                entry,
                identity,
                profile,
                path,
            } => {
                entry.verify(identity, profile)?;
                ensure!(
                    PrivateDirectory::open_existing(path)?.directory_identity()?
                        == profile.directory_identity()?,
                    "CONNECTIVITY_RELOCATION_SOURCE_CHANGED"
                );
                Ok((
                    entry.snapshot().generation.clone(),
                    entry.snapshot().revision,
                ))
            }
        }
    }
    pub(super) fn directory(
        &self,
        source: &NativeConnectivityLeaseFacade,
    ) -> Result<PrivateDirectory> {
        match self {
            Self::Runtime(context) => source.verify(context),
            Self::Offline { entry, profile, .. } => {
                self.epoch()?;
                ensure!(
                    entry.domain() == NativeDomain::Connectivity
                        && entry.namespace_id() == source.domain.namespace_id(),
                    "CONNECTIVITY_RELOCATION_OWNER_CHANGED"
                );
                source.verify_existing_profile(profile, &IntegrationOwner::from(entry.scope()))
            }
        }
    }
    pub(super) fn target_epoch(
        &self,
        target: &TargetAuthority<'_>,
        operation_id: &str,
    ) -> Result<(String, u64)> {
        match (self, target) {
            (Self::Runtime(source), TargetAuthority::Runtime(target)) => {
                source.validate_scope(target.scope())?;
                target.source_authority_epoch()
            }
            (
                Self::Offline {
                    entry,
                    identity: source_identity,
                    profile: source_profile,
                    ..
                },
                TargetAuthority::Offline {
                    identity,
                    published,
                },
            ) => {
                let profile = published.directory();
                ensure!(
                    published.operation_id() == operation_id,
                    "CONNECTIVITY_RELOCATION_OPERATION_CONFLICT"
                );
                entry.verify_target_relocation(
                    source_identity,
                    source_profile,
                    identity,
                    profile,
                    published,
                    Path::new(""),
                )?;
                let snapshot = identity.snapshot(profile)?;
                Ok((snapshot.generation, snapshot.revision))
            }
            _ => anyhow::bail!("CONNECTIVITY_RELOCATION_AUTHORITY_MISMATCH"),
        }
    }
}

impl<'a> TargetAuthority<'a> {
    pub(super) fn profile(&self) -> Result<&'a PrivateDirectory> {
        match self {
            Self::Runtime(context) => context.profile(),
            Self::Offline { published, .. } => Ok(published.directory()),
        }
    }
    pub(super) fn path(&self) -> &Path {
        match self {
            Self::Runtime(context) => context.captured_profile_path(),
            Self::Offline { published, .. } => published.destination_path(),
        }
    }
}
