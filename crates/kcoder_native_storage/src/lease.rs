//! One held filesystem lease; policy and admission remain with the caller.
use crate::abi::Fault;
use anyhow::{Result, ensure};
use kcoder_fs::{PortableLeaseIdentity, PrivateDirectory};
use std::{
    collections::BTreeSet,
    ffi::OsStr,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

mod observation;

pub(super) enum Acquisition {
    Missing,
    Busy,
    Held(StorageLease),
}

#[derive(Clone, Copy)]
pub(super) enum Mode {
    Shared,
    Exclusive,
    SharedExisting,
}

pub(super) struct StorageLease {
    path: PathBuf,
    directory: PrivateDirectory,
    root_identity: String,
    name: &'static str,
    file: File,
    file_identity: PortableLeaseIdentity,
    observations: Vec<observation::Observation>,
}

impl StorageLease {
    /// Fixed metadata observations only. The caller interprets operation state;
    /// these bounded bytes and held identities do not grant migration authority.
    pub(super) fn source_retirement(&self, role: &str) -> Result<String> {
        self.verify()?;
        if let Some(id) = role.strip_prefix("operation:") {
            ensure!(
                self.name == "kcoder-storage.lock"
                    && !id.is_empty()
                    && id.len() <= 96
                    && !matches!(id, "." | "..")
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte)),
                Fault::Argument
            );
            let operations = self
                .directory
                .open_child(OsStr::new("kcoder-storage-migrations"), false)?;
            let operation = operations.open_child(OsStr::new(id), false)?;
            let operation_identity = operation.directory_identity()?;
            let receipt = observe_leaf(&operation, "receipt.json", 1024 * 1024)?;
            let selection = observe_leaf(&self.directory, "kcoder-storage.json", 32 * 1024)?;
            ensure!(
                operations
                    .open_child(OsStr::new(id), false)?
                    .directory_identity()?
                    == operation_identity,
                Fault::Changed
            );
            self.verify()?;
            return Ok(serde_json::json!({"rootIdentity":self.root_identity,
                "operationIdentity":operation_identity,"receipt":receipt,"selection":selection})
            .to_string());
        }
        let name = match role {
            "identity" => {
                ensure!(self.name == "kcoder-storage-writers.lock", Fault::Argument);
                let ancestor_identities = self
                    .path
                    .ancestors()
                    .map(|path| PrivateDirectory::open_existing(path)?.directory_identity())
                    .collect::<Result<BTreeSet<_>>>()?;
                ensure!(
                    ancestor_identities.contains(&self.root_identity),
                    Fault::Changed
                );
                self.verify()?;
                return Ok(serde_json::json!({"rootIdentity":self.root_identity,
                    "marker":null,"ancestorIdentities":ancestor_identities})
                .to_string());
            }
            "native" => "kcoder-storage-retired-native.json",
            "gateway" => "kcoder-storage-retired-gateway.json",
            "desktop" => "kcoder-storage-retired-desktop.json",
            "pending" => "kcoder-storage-pending.json",
            "control" => {
                ensure!(self.name == "kcoder-storage.lock", Fault::Argument);
                return Ok(
                    serde_json::json!({"rootIdentity":self.root_identity,"marker":null})
                        .to_string(),
                );
            }
            _ => anyhow::bail!(Fault::Argument),
        };
        ensure!(self.name == "kcoder-storage-writers.lock", Fault::Argument);
        let marker = observe_leaf(&self.directory, name, 32 * 1024)?;
        self.verify()?;
        Ok(serde_json::json!({"rootIdentity":self.root_identity,"marker":marker}).to_string())
    }

    pub(super) fn acquire(
        path: &Path,
        name: &str,
        mode: Mode,
        create_root: bool,
    ) -> Result<Acquisition> {
        ensure!(path.is_absolute(), Fault::Argument);
        let name = match name {
            "kcoder-storage.lock" => "kcoder-storage.lock",
            "kcoder-storage-instances.lock" => "kcoder-storage-instances.lock",
            "kcoder-storage-writers.lock" => "kcoder-storage-writers.lock",
            _ => anyhow::bail!(Fault::Argument),
        };
        let existing_only = matches!(mode, Mode::SharedExisting);
        ensure!(
            !existing_only || !create_root,
            "existing lease cannot create roots"
        );
        let directory = match if create_root {
            PrivateDirectory::open_config_root(path)
        } else {
            PrivateDirectory::open_existing(path)
        } {
            Ok(directory) => directory,
            Err(error) if existing_only && missing(&error) => return Ok(Acquisition::Missing),
            Err(error) => return Err(error),
        };
        directory.verify_config_root_directory()?;
        let root_identity = directory.directory_identity()?;
        let acquired = match mode {
            Mode::Shared => directory.try_shared_lock(OsStr::new(name)),
            Mode::Exclusive => directory.try_exclusive_lock(OsStr::new(name)),
            Mode::SharedExisting => directory.try_existing_shared_lock(OsStr::new(name)),
        };
        let file = match acquired {
            Ok(Some(file)) => file,
            Ok(None) => {
                // A busy descriptor must never become a "missing" result if its
                // current name disappeared or was replaced during acquisition.
                verify_root(path, &directory, &root_identity)?;
                let current = directory.open_single_link_regular_file(OsStr::new(name))?;
                ensure!(current.metadata()?.len() == 0, Fault::Changed);
                PortableLeaseIdentity::from_storage_lock_handle(&current)?;
                return Ok(Acquisition::Busy);
            }
            Err(error) if existing_only && missing(&error) => {
                verify_root(path, &directory, &root_identity)?;
                return Ok(Acquisition::Missing);
            }
            Err(error) => return Err(error),
        };
        ensure!(file.metadata()?.len() == 0, Fault::Changed);
        let file_identity = PortableLeaseIdentity::from_storage_lock_handle(&file)?;
        let lease = Self {
            path: path.to_owned(),
            directory,
            root_identity,
            name,
            file,
            file_identity,
            observations: Vec::new(),
        };
        lease.verify()?;
        Ok(Acquisition::Held(lease))
    }

    pub(super) fn verify(&self) -> Result<()> {
        self.verify_lease()?;
        for observation in &self.observations {
            observation.verify(&self.directory)?;
        }
        Ok(())
    }

    fn verify_lease(&self) -> Result<()> {
        verify_root(&self.path, &self.directory, &self.root_identity)?;
        let current = self
            .directory
            .open_single_link_regular_file(OsStr::new(self.name))?;
        ensure!(
            self.file.metadata()?.len() == 0 && current.metadata()?.len() == 0,
            Fault::Changed
        );
        ensure!(
            PortableLeaseIdentity::from_storage_lock_handle(&self.file)? == self.file_identity
                && PortableLeaseIdentity::from_storage_lock_handle(&current)? == self.file_identity,
            "storage lock file changed"
        );
        Ok(())
    }
}

fn observe_leaf(
    directory: &PrivateDirectory,
    name: &str,
    limit: u64,
) -> Result<Option<serde_json::Value>> {
    let mut file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let identity = PortableLeaseIdentity::from_private_regular_handle(&file)?;
    let before = file.metadata()?;
    ensure!(before.len() <= limit, Fault::Changed);
    let mut content = Vec::new();
    (&mut file).take(limit + 1).read_to_end(&mut content)?;
    let after = file.metadata()?;
    ensure!(
        content.len() as u64 <= limit
            && before.len() == after.len()
            && before.modified()? == after.modified()?
            && PortableLeaseIdentity::from_private_regular_handle(&file)? == identity
            && PortableLeaseIdentity::from_private_regular_handle(
                &directory.open_single_link_regular_file(OsStr::new(name))?
            )? == identity,
        Fault::Changed
    );
    Ok(Some(
        serde_json::json!({"identity":serde_json::to_string(&identity)?,
        "text":String::from_utf8(content).map_err(|_| Fault::Changed)?}),
    ))
}

impl Drop for StorageLease {
    fn drop(&mut self) {
        // Explicit unlock also releases this open-file description if a forked
        // child has not yet closed its inherited copy. Closing remains mandatory.
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

fn verify_root(path: &Path, directory: &PrivateDirectory, expected: &str) -> Result<()> {
    directory.verify_config_root_directory()?;
    ensure!(
        directory.directory_identity()? == expected
            && PrivateDirectory::open_existing(path)?.directory_identity()? == expected,
        "storage root changed"
    );
    Ok(())
}

fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod observation_tests;
