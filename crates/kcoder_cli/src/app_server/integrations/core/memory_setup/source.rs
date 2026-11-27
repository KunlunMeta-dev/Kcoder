//! Independent first-setup evidence prevents recreating a lost memory namespace.
use super::super::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use anyhow::{Context, Result, ensure};
use fs2::FileExt;
use kcoder_config::PortableLeaseIdentity;
use kcoder_types::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    fs::File,
    io::{Read, Seek, SeekFrom},
};

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    owner: IntegrationOwner,
    namespace: String,
}

pub(in crate::app_server::integrations::core) struct MemorySetupWitness {
    name: String,
    identity: PortableLeaseIdentity,
    file: File,
    record: Record,
    first: bool,
}

impl MemorySetupWitness {
    pub(in crate::app_server::integrations::core) fn acquire(
        context: &NativeIntegrationContext,
    ) -> Result<Self> {
        context.verify()?;
        let profile = context.profile()?;
        let namespace =
            NativeDomainGuard::expected_namespace_id(context.scope(), NativeDomain::Memory)?;
        let name = format!(".memory-setup-{namespace}.json");
        let record = Record {
            version: 1,
            owner: IntegrationOwner::from(context.scope()),
            namespace,
        };
        let (mut file, first) = match profile.open_read_write_file(OsStr::new(&name), true) {
            Ok(file) => (file, true),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) =>
            {
                (
                    profile.open_read_write_file(OsStr::new(&name), false)?,
                    false,
                )
            }
            Err(error) => return Err(error),
        };
        FileExt::try_lock_exclusive(&file).context("MEMORY_BUSY")?;
        let identity = profile.portable_regular_handle_identity(&file)?;
        if first {
            serde_json::to_writer(&mut file, &record)?;
            file.sync_all()?;
            profile.sync()?;
        }
        let witness = Self {
            name,
            identity,
            file,
            record,
            first,
        };
        witness.verify(context)?;
        Ok(witness)
    }

    pub(in crate::app_server::integrations::core) fn is_first_setup(&self) -> bool {
        self.first
    }

    pub(in crate::app_server::integrations::core) fn verify(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<()> {
        context.verify()?;
        let profile = context.profile()?;
        ensure!(
            profile.portable_regular_identity(OsStr::new(&self.name))? == self.identity,
            "MEMORY_SETUP_WITNESS_INVALID"
        );
        let mut file = self.file.try_clone()?;
        file.seek(SeekFrom::Start(0))?;
        let mut bytes = Vec::new();
        file.take(8193).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 8192, "MEMORY_SETUP_WITNESS_INVALID");
        let record: Record =
            serde_json::from_slice(&bytes).context("MEMORY_SETUP_WITNESS_INVALID")?;
        ensure!(record == self.record, "MEMORY_SETUP_WITNESS_INVALID");
        context.verify()
    }
}
