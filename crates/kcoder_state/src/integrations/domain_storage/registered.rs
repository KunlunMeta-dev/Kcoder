//! Strict shallow inventory of the existing domain-control protocol.
use super::*;
use std::collections::BTreeSet;

const MAX_PROFILE_ENTRIES: usize = 8192;
const MAX_DOMAINS: usize = 256;

/// Data-owner facts obtained only from an original private marker and Ready.
/// This does not issue Native identity, permission or complete-shutdown proof.
pub struct RegisteredDomain {
    guard: DomainStorageGuard,
}
impl RegisteredDomain {
    pub fn owner(&self) -> &IntegrationOwner {
        &self.guard.initialization.owner
    }
    pub fn domain(&self) -> StorageDomain {
        self.guard.initialization.domain
    }
    pub fn namespace_id(&self) -> &str {
        self.guard.namespace_id()
    }
    pub fn guard(&self) -> &DomainStorageGuard {
        &self.guard
    }
    pub fn verify(&self, profile: &PrivateDirectory) -> Result<()> {
        self.guard.directory(profile).map(|_| ())
    }
}

impl DomainStorageGuard {
    /// Migration inventory is strict: partial or unknown reserved metadata may
    /// not disappear behind a best-effort directory page's `complete=false`.
    /// Only names are enumerated; each marker and namespace is opened by handle.
    pub fn observe_registered_domains(profile: &PrivateDirectory) -> Result<Vec<RegisteredDomain>> {
        profile.verify_config_root_directory()?;
        // Windows enumeration may include '.' and '..' before filtering.
        let entries = profile.entry_names_bounded(MAX_PROFILE_ENTRIES + 3)?;
        ensure!(
            entries.len() <= MAX_PROFILE_ENTRIES,
            "INTEGRATION_DIRECTORY_CAPACITY"
        );
        let mut markers = BTreeSet::new();
        let mut directories = BTreeSet::new();
        for name in entries {
            let Some(text) = name.to_str() else { continue };
            if text.starts_with(".integration-") {
                let digest = text
                    .strip_prefix(".integration-")
                    .and_then(|name| name.strip_suffix(".jsonl"));
                ensure!(
                    digest.is_some_and(valid_digest),
                    "INTEGRATION_STORAGE_UNCONFIRMED_RESERVED_ENTRY: {text}"
                );
                markers.insert(text.to_owned());
            } else if let Some(digest) = text.strip_prefix("integration-") {
                ensure!(
                    valid_digest(digest),
                    "INTEGRATION_STORAGE_UNCONFIRMED_RESERVED_ENTRY: {text}"
                );
                directories.insert(text.to_owned());
            }
        }
        ensure!(
            markers.len() <= MAX_DOMAINS,
            "INTEGRATION_DIRECTORY_CAPACITY"
        );
        let mut result = Vec::new();
        for marker in markers {
            let observed = (|| -> Result<RegisteredDomain> {
                let file = profile.open_single_link_regular_file(OsStr::new(&marker))?;
                let (initial, _) = parse_control(&read_control_bytes(&file)?)?;
                ensure!(
                    names(&initial.owner, initial.domain)?.0 == marker,
                    "INTEGRATION_DIRECTORY_MARKER_MISMATCH"
                );
                let guard = Self::observe_owner(profile, &initial.owner, initial.domain)?
                    .context("INTEGRATION_DIRECTORY_SOURCE_CHANGED")?;
                ensure!(
                    directories.remove(guard.namespace_id()),
                    "INTEGRATION_STORAGE_INITIALIZATION_UNCONFIRMED"
                );
                Ok(RegisteredDomain { guard })
            })()
            .with_context(|| format!("INTEGRATION_STORAGE_REGISTERED_DOMAIN_INVALID: {marker}"))?;
            result.push(observed);
        }
        ensure!(
            directories.is_empty(),
            "INTEGRATION_STORAGE_ORPHAN_NAMESPACE: {}",
            directories.into_iter().next().unwrap_or_default()
        );
        result.sort_by(|a, b| a.namespace_id().cmp(b.namespace_id()));
        profile.verify_config_root_directory()?;
        for entry in &result {
            entry.verify(profile)?;
        }
        Ok(result)
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
#[path = "registered/tests.rs"]
mod tests;
