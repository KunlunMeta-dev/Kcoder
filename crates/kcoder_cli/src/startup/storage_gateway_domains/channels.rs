//! The existing SQLite source lease protects original channel files. Only the
//! operation-owned disposable copies are ever opened by Node's SQLite runtime.
use super::*;
use kcoder_config::{PortableLeaseIdentity, SqliteSourcePart, SqliteSourceReadLease};
use std::io::Write;

const DATABASE: &str = "channels.sqlite3";

pub(super) struct ChannelRead {
    original_path: PathBuf,
    original: PrivateDirectory,
    lease: SqliteSourceReadLease,
    shadow: PrivateDirectory,
    // Close the directory handle before removing its owned temporary tree.
    temporary: tempfile::TempDir,
}

impl ChannelRead {
    pub(super) fn prepare(
        coordinator: &mut StorageCoordinator,
        id: &str,
        original_path: &Path,
    ) -> Result<Self> {
        let original = PrivateDirectory::open_existing(original_path)?;
        // The existing Node limit concerns logical SQLite pages. A long WAL
        // can exceed that size without enlarging the live database; bound this
        // copy to the actual observed file set instead of adding a new format cap.
        let mut bytes = 0u64;
        for suffix in ["", "-wal", "-shm"] {
            match original.entry_metadata(OsStr::new(&format!("{DATABASE}{suffix}"))) {
                Ok(metadata) => {
                    bytes = bytes
                        .checked_add(metadata.len())
                        .context("CHANNEL_RELOCATION_CAPACITY_EXCEEDED")?;
                }
                Err(error) if missing(&error) => {}
                Err(error) => return Err(error),
            }
        }
        let lease = original
            .try_sqlite_source_read_lease(OsStr::new(DATABASE), bytes.max(1))?
            .context("CHANNEL_RELOCATION_BUSY")?;
        let receipt = coordinator
            .current()?
            .context("STORAGE_OPERATION_MISSING")?;
        ensure!(
            receipt.plan.operation_id == id,
            "STORAGE_OPERATION_CONFLICT"
        );
        let operation_path = receipt
            .plan
            .from
            .location_file
            .as_ref()
            .and_then(|path| path.parent())
            .context("STORAGE_CONTROL_UNAVAILABLE")?
            .join("kcoder-storage-migrations")
            .join(id);
        let operation = coordinator.offline_operation_directory(id)?;
        ensure!(
            PrivateDirectory::open_existing(&operation_path)?.directory_identity()?
                == operation.directory_identity()?,
            "STORAGE_OPERATION_DIRECTORY_CHANGED"
        );
        let mut temporary = tempfile::Builder::new();
        temporary.prefix("channel-read-");
        let temporary = temporary.tempdir_in(&operation_path)?;
        let shadow = PrivateDirectory::open_existing(temporary.path())?;
        shadow.verify_private_directory()?;
        ensure!(
            PrivateDirectory::open_existing(&operation_path)?.directory_identity()?
                == operation.directory_identity()?,
            "STORAGE_OPERATION_DIRECTORY_CHANGED"
        );
        let mut buffer = [0u8; 64 * 1024];
        for (part, suffix) in [
            (SqliteSourcePart::Database, ""),
            (SqliteSourcePart::Wal, "-wal"),
            (SqliteSourcePart::SharedMemory, "-shm"),
        ] {
            let Some(fact) = lease.fact(part) else {
                continue;
            };
            let name = format!("{DATABASE}{suffix}");
            let original_file = original.open_single_link_regular_file(OsStr::new(&name))?;
            ensure!(
                PortableLeaseIdentity::from_regular_handle(&original_file)? == fact.identity,
                "CHANNEL_RELOCATION_SOURCE_CHANGED"
            );
            let mut file = shadow.open_read_write_file(OsStr::new(&name), true)?;
            let mut offset = 0;
            while offset < fact.bytes {
                let count = lease.read_at(part, offset, &mut buffer)?;
                ensure!(count > 0, "CHANNEL_RELOCATION_SOURCE_CHANGED");
                file.write_all(&buffer[..count])?;
                offset += count as u64;
            }
        }
        let result = Self {
            original_path: original_path.into(),
            original,
            lease,
            shadow,
            temporary,
        };
        result.verify()?;
        Ok(result)
    }

    pub(super) fn path(&self) -> &Path {
        self.temporary.path()
    }

    pub(super) fn verify(&self) -> Result<()> {
        ensure!(
            PrivateDirectory::open_existing(&self.original_path)?.directory_identity()?
                == self.original.directory_identity()?
                && PrivateDirectory::open_existing(self.path())?.directory_identity()?
                    == self.shadow.directory_identity()?,
            "CHANNEL_RELOCATION_SOURCE_CHANGED"
        );
        self.lease.verify()
    }
}
