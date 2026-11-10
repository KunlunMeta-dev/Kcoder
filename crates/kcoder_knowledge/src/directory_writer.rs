//! Native maintenance uses the held namespace and SQLite's real system I/O.
use crate::KnowledgeCatalog;
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use rusqlite::Connection;
use std::ffi::OsStr;
#[cfg(any(unix, windows))]
mod vfs;

pub struct DirectoryKnowledgeWriter {
    catalog: Option<KnowledgeCatalog>,
    directory: PrivateDirectory,
    #[cfg(windows)]
    _name_pin: kcoder_config::NativeSqliteDirectoryPin,
}

impl DirectoryKnowledgeWriter {
    /// This initializes only after the host authorized the actual maintenance
    /// request. It is not an observation or a path-based fallback.
    pub fn open(directory: PrivateDirectory) -> Result<Self> {
        directory.verify_private_directory()?;
        #[cfg(unix)]
        let anchor = vfs::anchor(&directory, None)?;
        #[cfg(windows)]
        let pin = directory.pin_native_sqlite_directory(OsStr::new("state.sqlite"))?;
        #[cfg(windows)]
        let anchor = vfs::anchor(&directory, Some(&pin.path().join("state.sqlite")))?;
        #[cfg(any(unix, windows))]
        let connection = Connection::open_with_flags_and_vfs(
            anchor.path(),
            rusqlite::OpenFlags::default() | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
            anchor.name(),
        )?;
        #[cfg(windows)]
        {
            use std::os::windows::io::BorrowedHandle;
            let mut actual = std::ptr::null_mut::<std::ffi::c_void>();
            let code = unsafe {
                rusqlite::ffi::sqlite3_file_control(
                    connection.handle(),
                    c"main".as_ptr(),
                    rusqlite::ffi::SQLITE_FCNTL_WIN32_GET_HANDLE,
                    (&mut actual as *mut *mut std::ffi::c_void).cast(),
                )
            };
            ensure!(
                code == rusqlite::ffi::SQLITE_OK && !actual.is_null(),
                "native SQLite database handle unavailable"
            );
            pin.verify_database_handle(unsafe { BorrowedHandle::borrow_raw(actual) })?;
        }
        #[cfg(unix)]
        {
            // A preexisting ordinary connection may have created the shared
            // shm node with an absolute name. In the vendored SQLite,
            // sqlite3PagerClose passes a null checkpoint buffer for this flag;
            // sqlite3WalClose then keeps isDelete=0 through unixShmUnmap.
            // Explicit checkpoints and native WAL/OS locks are unchanged.
            connection.set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                true,
            )?;
        }
        #[cfg(not(any(unix, windows)))]
        let connection: Connection =
            anyhow::bail!("native SQLite writer unsupported on this platform");
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            version <= crate::catalog::SCHEMA_VERSION,
            "unsupported future knowledge schema version {version}"
        );
        let objects = crate::objects::ObjectStore::open_writer_child(
            directory.duplicate_handle()?,
            OsStr::new("state.objects"),
        )?;
        let catalog = KnowledgeCatalog::initialize_owned_connection(connection, objects)?;
        Ok(Self {
            catalog: Some(catalog),
            directory,
            #[cfg(windows)]
            _name_pin: pin,
        })
    }

    pub fn with_catalog<T>(
        mut self,
        write: impl FnOnce(&mut KnowledgeCatalog) -> Result<T>,
    ) -> Result<T> {
        let result = write(self.catalog.as_mut().expect("owned catalog"));
        let catalog = self.catalog.take().expect("owned catalog");
        // Close/checkpoint while the actual namespace and object handles remain
        // held. The process anchor also covers ordinary SQLite peers' shm node.
        let KnowledgeCatalog {
            connection,
            objects,
        } = catalog;
        let closed = connection.close();
        let continuity = objects
            .verify_held_writer()
            .and_then(|_| self.directory.verify_private_directory());
        ensure!(
            closed.is_ok() && continuity.is_ok(),
            "WIKI_WRITE_RESULT_NEEDS_RECONCILIATION"
        );
        result
    }
}

#[cfg(test)]
mod tests;
