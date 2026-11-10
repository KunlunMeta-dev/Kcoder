//! A birth-time sealed raw-file manifest; later additions never become owned by scanning them.
use super::*;
use kcoder_config::PortableLeaseIdentity;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Leaf {
    pub name: String,
    pub identity: PortableLeaseIdentity,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Manifest {
    pub directory: PortableLeaseIdentity,
    pub leaves: Vec<Leaf>,
}
pub(crate) struct BirthProof {
    pub(super) manifest: Manifest,
    pub(super) directory: PrivateDirectory,
    pub(super) _guard: ArchiveReadGuard,
}
impl BirthProof {
    pub(crate) fn verify(&self, check: &mut impl FnMut() -> bool) -> Result<()> {
        self.manifest.verify_remaining(&self.directory, &[], check)
    }
}
impl Manifest {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.leaves.len() <= 16,
            "external_history_lifecycle_budget_exceeded"
        );
        let mut previous: Option<&str> = None;
        for leaf in &self.leaves {
            ensure!(
                !leaf.name.is_empty()
                    && leaf.name.len() <= 64
                    && leaf.bytes <= 4 * 1024 * 1024 * 1024
                    && leaf
                        .name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
                    && previous.is_none_or(|name| name < leaf.name.as_str()),
                "external_history_lifecycle_changed"
            );
            digest(&leaf.sha256)?;
            previous = Some(&leaf.name);
        }
        Ok(())
    }
    #[cfg(any(target_os = "linux", windows))]
    pub fn capture_cache(
        directory: &PrivateDirectory,
        check: &mut impl FnMut() -> bool,
    ) -> Result<Self> {
        let allowed = [
            "owner.json",
            "setup.lock",
            "build.lock",
            "catalog.sqlite3",
            "schema-intent.json",
            "schema-ready.json",
        ];
        let mut names = Vec::new();
        directory.visit_entry_names_bounded(17, |name| {
            let name = name
                .to_str()
                .context("external_history_lifecycle_unknown_entry")?;
            ensure!(
                allowed.contains(&name),
                "external_history_lifecycle_unknown_entry"
            );
            names.push(name.to_string());
            Ok(())
        })?;
        ensure!(
            ["owner.json", "catalog.sqlite3", "schema-ready.json"]
                .iter()
                .all(|required| names.iter().any(|name| name == required)),
            "external_history_derived_incomplete"
        );
        names.sort();
        let mut leaves = Vec::new();
        for name in names {
            ensure!(check(), "external_history_lifecycle_cancelled");
            let identity = directory.portable_retention_regular_identity(OsStr::new(&name))?;
            let held = directory.portable_open_verified_regular(OsStr::new(&name), &identity)?;
            let bytes = held.file().metadata()?.len();
            ensure!(
                bytes <= 4 * 1024 * 1024 * 1024,
                "external_history_lifecycle_budget_exceeded"
            );
            let mut file = held.file();
            let mut hash = Sha256::new();
            let mut read = 0;
            let mut buffer = [0; 64 * 1024];
            while read < bytes {
                ensure!(check(), "external_history_lifecycle_cancelled");
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                read += count as u64;
                ensure!(read <= bytes, "external_history_derived_changed");
                hash.update(&buffer[..count]);
            }
            ensure!(
                read == bytes && file.metadata()?.len() == bytes,
                "external_history_derived_changed"
            );
            directory.portable_open_verified_regular(OsStr::new(&name), &identity)?;
            leaves.push(Leaf {
                name,
                identity,
                bytes,
                sha256: format!("{:x}", hash.finalize()),
            });
        }
        let manifest = Self {
            directory: directory.portable_retention_identity()?,
            leaves,
        };
        manifest.validate()?;
        Ok(manifest)
    }
    #[cfg(any(target_os = "linux", windows))]
    pub fn capture(
        directory: &PrivateDirectory,
        receipt: &kcoder_types::external_history::ExternalHistoryReceipt,
    ) -> Result<Self> {
        let mut names = Vec::new();
        directory.visit_entry_names_bounded(17, |name| {
            let name = name
                .to_str()
                .context("external_history_lifecycle_unknown_entry")?;
            ensure!(
                [
                    "binding.json",
                    "import.lock",
                    "receipt.json",
                    "source.bin",
                    "source-chunks.bin",
                    "records.bin",
                    "record-chunks.bin",
                    "original.bin",
                    "original-chunks.bin",
                    "original.json",
                ]
                .contains(&name),
                "external_history_lifecycle_unknown_entry"
            );
            names.push(name.to_string());
            Ok(())
        })?;
        names.sort();
        let mut leaves = Vec::new();
        for name in names {
            let file = directory.open_single_link_regular_file(OsStr::new(&name))?;
            let bytes = file.metadata()?.len();
            let expected = match name.as_str() {
                "source.bin" => Some((receipt.source_bytes, receipt.source_sha256.clone())),
                "records.bin" => Some((receipt.index_bytes, receipt.index_sha256.clone())),
                "original.bin" => Some(
                    receipt
                        .original
                        .as_ref()
                        .map(|original| (original.source.bytes, original.source.sha256.clone()))
                        .context("external_history_lifecycle_changed")?,
                ),
                _ => None,
            };
            let sha256 = if let Some((size, sha256)) = expected {
                ensure!(bytes == size, "external_history_lifecycle_changed");
                sha256
            } else if bytes == 0 {
                // Windows byte-range locks reject ReadFile from a second handle,
                // even for an empty control file. Empty bytes have a fixed digest;
                // actual descriptor identity and length remain independently checked.
                format!("{:x}", Sha256::digest([]))
            } else {
                ensure!(
                    bytes <= 1024 * 1024,
                    "external_history_lifecycle_budget_exceeded"
                );
                let mut data = Vec::new();
                (&file).take(1024 * 1024 + 1).read_to_end(&mut data)?;
                ensure!(
                    data.len() <= 1024 * 1024,
                    "external_history_lifecycle_budget_exceeded"
                );
                format!("{:x}", Sha256::digest(data))
            };
            ensure!(
                file.metadata()?.len() == bytes,
                "external_history_lifecycle_changed"
            );
            leaves.push(Leaf {
                name: name.clone(),
                identity: directory.portable_retention_regular_identity(OsStr::new(&name))?,
                bytes,
                sha256,
            });
        }
        let value = Self {
            directory: directory.portable_retention_identity()?,
            leaves,
        };
        value.validate()?;
        Ok(value)
    }
    pub fn verify_remaining(
        &self,
        directory: &PrivateDirectory,
        removed: &[String],
        check: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        self.verify_remaining_with_children(directory, removed, &[], check)
    }
    pub fn verify_remaining_with_children(
        &self,
        directory: &PrivateDirectory,
        removed: &[String],
        children: &[String],
        check: &mut impl FnMut() -> bool,
    ) -> Result<()> {
        self.validate()?;
        ensure!(
            children.len() <= 66,
            "external_history_lifecycle_budget_exceeded"
        );
        directory.portable_verify_retention_identity(&self.directory)?;
        directory.visit_entry_names_bounded(83, |name| {
            ensure!(
                self.leaves
                    .iter()
                    .any(|leaf| OsStr::new(&leaf.name) == name)
                    || children.iter().any(|child| OsStr::new(child) == name),
                "external_history_lifecycle_unknown_entry"
            );
            Ok(())
        })?;
        for leaf in &self.leaves {
            if removed.contains(&leaf.name) {
                continue;
            }
            ensure!(check(), "external_history_lifecycle_cancelled");
            let file =
                directory.portable_open_verified_regular(OsStr::new(&leaf.name), &leaf.identity)?;
            ensure!(
                file.file().metadata()?.len() == leaf.bytes,
                "external_history_lifecycle_changed"
            );
            let mut input = file.file();
            let mut digest = Sha256::new();
            let mut buffer = [0; 64 * 1024];
            let mut bytes = 0;
            while bytes < leaf.bytes {
                ensure!(check(), "external_history_lifecycle_cancelled");
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                bytes += count as u64;
                ensure!(bytes <= leaf.bytes, "external_history_lifecycle_changed");
                digest.update(&buffer[..count]);
            }
            ensure!(
                bytes == leaf.bytes
                    && file.file().metadata()?.len() == leaf.bytes
                    && format!("{:x}", digest.finalize()) == leaf.sha256,
                "external_history_lifecycle_changed"
            );
        }
        Ok(())
    }
}
