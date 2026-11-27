//! Profile-path principals are data addresses, never authorization grants.
use crate::KnowledgeScope;
use anyhow::{Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory, profile_identity::ProfileIdentity};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

pub(crate) const RECORD: &str = ".profile-scope.json";
const MAX_RECORD_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfileAddress {
    pub path: PathBuf,
    pub identity: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfileScopeRecord {
    pub version: u32,
    pub operation_id: String,
    pub logical_profile_seed: String,
    pub source_profile_identity: String,
    pub source_record_sha256: Option<String>,
    pub source_content_sha256: String,
    pub source_credentials_sha256: String,
    pub source_profiles: Vec<ProfileAddress>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub credential_files: BTreeMap<PathBuf, PathBuf>,
    pub profile_identity: String,
    pub knowledge_identity: String,
    pub principal: String,
}

/// A host-selected profile address, with a fresh receipt check on every read.
/// The captured identities constrain routing; they never authorize a key.
#[derive(Clone)]
pub struct ProfileCredentialFileMapping {
    profile_path: PathBuf,
    profile_identity: String,
    logical_profile_seed: String,
    operation_id: String,
}
impl ProfileCredentialFileMapping {
    pub fn observe(profile_path: &Path) -> Result<Option<Self>> {
        personal_profile_scope(profile_path)?;
        let canonical = profile_path.canonicalize()?;
        let profile = PrivateDirectory::open_existing(&canonical)?;
        let directory = match profile.open_child(OsStr::new("knowledge"), false) {
            Ok(directory) => directory,
            Err(error) if missing(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        let Some((record, _)) = read_record(&directory)? else {
            return Ok(None);
        };
        let logical = ProfileIdentity::observe(&profile)?;
        verify_record(&profile, &logical, &directory, &record)?;
        Ok(Some(Self {
            profile_path: canonical,
            profile_identity: profile.directory_identity()?,
            logical_profile_seed: record.logical_profile_seed,
            operation_id: record.operation_id,
        }))
    }

    pub fn resolve(&self, original: &Path) -> Result<PathBuf> {
        let profile = PrivateDirectory::open_existing(&self.profile_path)?;
        let logical = ProfileIdentity::observe(&profile)?;
        let directory = profile.open_child(OsStr::new("knowledge"), false)?;
        let (record, _) = read_record(&directory)?
            .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_PROFILE_SCOPE_BINDING_CHANGED"))?;
        verify_record(&profile, &logical, &directory, &record)?;
        ensure!(
            profile.directory_identity()? == self.profile_identity
                && record.logical_profile_seed == self.logical_profile_seed
                && record.operation_id == self.operation_id,
            "KNOWLEDGE_PROFILE_SCOPE_BINDING_CHANGED"
        );
        relocated_profile_credential_file(&self.profile_path, original)
    }
}

/// Read the same legacy principal before and after a verified offline move.
/// Explicit account principals must still be supplied by the trusted host.
/// This bounded observation does not initialize storage or cache permission.
pub fn personal_profile_scope(profile_path: &Path) -> Result<KnowledgeScope> {
    let canonical = profile_path.canonicalize()?;
    let profile = PrivateDirectory::open_existing(&canonical)?;
    let logical = ProfileIdentity::observe(&profile)?;
    let principal = match profile.open_child(OsStr::new("knowledge"), false) {
        Ok(directory) => {
            let principal = match read_record(&directory)? {
                Some((record, _)) => {
                    verify_record(&profile, &logical, &directory, &record)?;
                    record.principal
                }
                None => format!("profile:{}", canonical.display()),
            };
            ensure!(
                profile
                    .open_child(OsStr::new("knowledge"), false)?
                    .directory_identity()?
                    == directory.directory_identity()?,
                "KNOWLEDGE_PROFILE_SCOPE_BINDING_CHANGED"
            );
            principal
        }
        Err(error) if missing(&error) => format!("profile:{}", canonical.display()),
        Err(error) => return Err(error),
    };
    logical.verify(&profile)?;
    ensure!(
        PrivateDirectory::open_existing(&canonical)?.directory_identity()?
            == profile.directory_identity()?,
        "KNOWLEDGE_PROFILE_CHANGED"
    );
    KnowledgeScope::from_authenticated_host(&principal, "execution-host")
}

pub(crate) fn verify_record(
    profile: &PrivateDirectory,
    logical: &ProfileIdentity,
    directory: &PrivateDirectory,
    record: &ProfileScopeRecord,
) -> Result<()> {
    ensure!(
        matches!(record.version, 1 | 2)
            && valid_operation(&record.operation_id)
            && record.logical_profile_seed == logical.logical_seed()
            && record.source_profile_identity != record.profile_identity
            && profile
                .open_child(OsStr::new("knowledge"), false)?
                .directory_identity()?
                == directory.directory_identity()?
            && record.principal.starts_with("profile:")
            && record.principal.len() > "profile:".len()
            && record.principal.len() <= 512
            && sha(&record.source_content_sha256)
            && sha(&record.source_credentials_sha256)
            && record.source_record_sha256.as_deref().is_none_or(sha),
        "KNOWLEDGE_PROFILE_SCOPE_BINDING_CHANGED"
    );
    ensure!(
        record.credential_files.len() <= 65_536
            && record.credential_files.iter().all(|(original, relative)| {
                original.is_absolute()
                    && !original
                        .components()
                        .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
                    && !relative.as_os_str().is_empty()
                    && relative
                        .components()
                        .all(|part| matches!(part, Component::Normal(_)))
            }),
        "KNOWLEDGE_PROFILE_SCOPE_BINDING_CHANGED"
    );
    ensure!(
        !record.source_profiles.is_empty()
            && record.source_profiles.len() <= 64
            && record
                .source_profiles
                .iter()
                .all(|source| source.path.is_absolute()
                    && !source.identity.is_empty()
                    && source.path.components().all(|component| !matches!(
                        component,
                        Component::ParentDir | Component::CurDir
                    )))
            && record
                .source_profiles
                .last()
                .is_some_and(|source| source.identity == record.source_profile_identity)
            && record.source_profiles.first().is_some_and(
                |source| record.principal == format!("profile:{}", source.path.display())
            ),
        "KNOWLEDGE_PROFILE_SCOPE_BINDING_CHANGED"
    );
    ensure!(
        read_record(directory)?.is_some_and(|(current, _)| current == *record),
        "KNOWLEDGE_PROFILE_SCOPE_BINDING_CHANGED"
    );
    logical.verify(profile)
}

/// Resolve only a frozen worker's explicit credential-file address. Root
/// continuity supplies routing evidence; the normal credential owner still
/// validates the credential on use, including later legitimate key rotation.
pub fn relocated_profile_credential_file(profile_path: &Path, original: &Path) -> Result<PathBuf> {
    let canonical = profile_path.canonicalize()?;
    let profile = PrivateDirectory::open_existing(&canonical)?;
    let logical = ProfileIdentity::observe(&profile)?;
    let directory = match profile.open_child(OsStr::new("knowledge"), false) {
        Ok(directory) => directory,
        Err(error) if missing(&error) => return Ok(original.into()),
        Err(error) => return Err(error),
    };
    let Some((record, _)) = read_record(&directory)? else {
        return Ok(original.into());
    };
    verify_record(&profile, &logical, &directory, &record)?;
    let relative = record
        .credential_files
        .get(original)
        .cloned()
        .or(relative_credential_path(
            &canonical,
            &record.source_profiles,
            original,
        )?);
    let Some(relative) = relative else {
        return Ok(original.into());
    };
    let _file = open_profile_credential_file(&profile, &relative)?;
    verify_record(&profile, &logical, &directory, &record)?;
    logical.verify(&profile)?;
    ensure!(
        PrivateDirectory::open_existing(&canonical)?.directory_identity()?
            == profile.directory_identity()?,
        "KNOWLEDGE_PROFILE_CHANGED"
    );
    Ok(canonical.join(relative))
}

pub(crate) fn relative_credential_path(
    current: &Path,
    sources: &[ProfileAddress],
    original: &Path,
) -> Result<Option<PathBuf>> {
    let relative = std::iter::once(current)
        .chain(sources.iter().rev().map(|source| source.path.as_path()))
        .find_map(|root| original.strip_prefix(root).ok());
    relative
        .map(|relative| {
            ensure!(
                !relative.as_os_str().is_empty()
                    && relative
                        .components()
                        .all(|component| matches!(component, Component::Normal(_))),
                "KNOWLEDGE_WORKER_CREDENTIAL_PATH_INVALID"
            );
            Ok(relative.to_path_buf())
        })
        .transpose()
}

pub(crate) fn open_profile_credential_file(
    profile: &PrivateDirectory,
    relative: &Path,
) -> Result<File> {
    let mut directory = profile.duplicate_handle()?;
    let mut parts = relative.components().peekable();
    while let Some(part) = parts.next() {
        let Component::Normal(name) = part else {
            anyhow::bail!("KNOWLEDGE_WORKER_CREDENTIAL_PATH_INVALID");
        };
        if parts.peek().is_none() {
            let file = directory.open_single_link_regular_file(name)?;
            let expected = PortableLeaseIdentity::from_private_regular_handle(&file)?;
            ensure!(
                PortableLeaseIdentity::from_private_regular_handle(
                    &directory.open_single_link_regular_file(name)?
                )? == expected,
                "KNOWLEDGE_WORKER_CREDENTIAL_CHANGED"
            );
            return Ok(file);
        }
        directory = directory.open_child(name, false)?;
        directory.verify_trusted_config_directory()?;
    }
    anyhow::bail!("KNOWLEDGE_WORKER_CREDENTIAL_PATH_INVALID")
}

pub(crate) fn read_record(
    directory: &PrivateDirectory,
) -> Result<Option<(ProfileScopeRecord, Vec<u8>)>> {
    let file = match directory.open_single_link_regular_file(OsStr::new(RECORD)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let identity = directory.portable_regular_handle_identity(&file)?;
    let mut bytes = Vec::new();
    (&file).take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_RECORD_BYTES,
        "KNOWLEDGE_PROFILE_SCOPE_INVALID"
    );
    ensure!(
        directory.portable_regular_identity(OsStr::new(RECORD))? == identity,
        "KNOWLEDGE_PROFILE_SCOPE_BINDING_CHANGED"
    );
    Ok(Some((serde_json::from_slice(&bytes)?, bytes)))
}

pub(crate) fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
pub(crate) fn valid_operation(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control)
}
pub(crate) fn sha(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
