//! Current open-lifetime protection, separate from historical catalog placement.
use super::{BINDING, Binding, DB, LOCK, OBJECTS, read_binding};
use anyhow::{Result, ensure};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use std::{ffi::OsStr, fs::File};

pub struct PublicationAnchors {
    directory: PrivateDirectory,
    binding: File,
    database: File,
    lock: File,
    objects: PrivateDirectory,
}

impl PublicationAnchors {
    pub fn observe(directory: &PrivateDirectory, binding: &Binding) -> Result<Self> {
        let held = Self {
            directory: directory.duplicate_handle()?,
            binding: directory.open_single_link_regular_file(OsStr::new(BINDING))?,
            database: directory.open_single_link_regular_file(OsStr::new(DB))?,
            lock: directory.open_single_link_regular_file(OsStr::new(LOCK))?,
            objects: directory.open_child(OsStr::new(OBJECTS), false)?,
        };
        held.verify(directory, binding)?;
        Ok(held)
    }

    pub fn verify(&self, directory: &PrivateDirectory, binding: &Binding) -> Result<()> {
        directory.verify_private_directory()?;
        self.objects.verify_private_directory()?;
        ensure!(
            directory.directory_identity()? == self.directory.directory_identity()?
                && directory
                    .open_child(OsStr::new(OBJECTS), false)?
                    .directory_identity()?
                    == self.objects.directory_identity()?
                && read_binding(directory)? == *binding,
            "KNOWLEDGE_NATIVE_BINDING_CHANGED"
        );
        for (name, file) in [
            (BINDING, &self.binding),
            (DB, &self.database),
            (LOCK, &self.lock),
        ] {
            let current = self.directory.portable_regular_handle_identity(file)?;
            ensure!(
                directory.portable_regular_identity(OsStr::new(name))? == current,
                "KNOWLEDGE_NATIVE_DATABASE_CHANGED"
            );
            if name == LOCK {
                ensure!(
                    current == binding.lock_identity,
                    "KNOWLEDGE_NATIVE_DATABASE_CHANGED"
                );
            }
        }
        Ok(())
    }

    pub fn database_identity(&self) -> Result<PortableLeaseIdentity> {
        self.directory
            .portable_regular_handle_identity(&self.database)
    }
}
