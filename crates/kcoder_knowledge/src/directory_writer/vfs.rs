//! Forward native SQLite locks, rollback journals and WAL/shm to its system VFS.
//! Only pathname canonicalization is replaced with a held directory alias.
use anyhow::{Result, ensure};
use kcoder_config::PrivateDirectory;
use rusqlite::ffi;
use std::{
    ffi::{CStr, CString, OsStr},
    path::Path,
    ptr,
    sync::{Arc, Mutex, OnceLock},
};

const MAX_ANCHORS: usize = 64;
const DB: &str = "state.sqlite";

pub(super) struct Anchor {
    directory: PrivateDirectory,
    identity: String,
    path: CString,
    name: CString,
    original: usize,
    registered: usize,
}
impl Anchor {
    pub(super) fn path(&self) -> &Path {
        Path::new(
            self.path
                .to_str()
                .expect("validated native directory alias"),
        )
    }
    pub(super) fn name(&self) -> &str {
        self.name.to_str().expect("ASCII VFS name")
    }
    fn permits(&self, name: &CStr) -> bool {
        let raw = name.to_bytes();
        let base = self.path.to_bytes();
        raw == base
            || [b"-journal".as_slice(), b"-wal", b"-shm"]
                .iter()
                .any(|suffix| raw.strip_prefix(base) == Some(*suffix))
    }
    fn original(&self) -> *mut ffi::sqlite3_vfs {
        self.original as *mut ffi::sqlite3_vfs
    }
    fn verify_entry(&self, name: &CStr) -> bool {
        if !self.permits(name) || self.directory.verify_private_directory().is_err() {
            return false;
        }
        #[cfg(windows)]
        {
            let suffix = name
                .to_bytes()
                .strip_prefix(self.path.to_bytes())
                .unwrap_or_default();
            let Ok(suffix) = std::str::from_utf8(suffix) else {
                return false;
            };
            let leaf = format!("{DB}{suffix}");
            match self
                .directory
                .open_single_link_regular_file(OsStr::new(&leaf))
            {
                Ok(file) => file.metadata().is_ok_and(|metadata| metadata.is_file()),
                Err(error) => missing(&error),
            }
        }
        #[cfg(unix)]
        {
            let Ok(path) = name.to_str() else {
                return false;
            };
            // lstat on the descriptor alias never opens/closes a DB descriptor.
            // Closing an independent Unix DB fd could release SQLite's POSIX locks.
            match std::fs::symlink_metadata(Path::new(path)) {
                Ok(metadata) => {
                    use std::os::unix::fs::MetadataExt;
                    metadata.is_file()
                        && metadata.nlink() == 1
                        && self
                            .directory
                            .directory_metadata()
                            .is_ok_and(|parent| metadata.uid() == parent.uid())
                        && metadata.mode() & 0o022 == 0
                }
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            }
        }
    }
}

// SQLite's unixShmNode may retain the first connection's filename even after
// that connection closes, including when a normal path connection is the peer.
// The bounded registry is process-owned, not a connection counter: descriptor
// aliases are never released/reused while any native SQLite shared node can live.
// This mutex only registers aliases. It never serializes a database operation.
static ANCHORS: OnceLock<Mutex<Vec<Arc<Anchor>>>> = OnceLock::new();

pub(super) fn anchor(directory: &PrivateDirectory, named: Option<&Path>) -> Result<Arc<Anchor>> {
    let directory_identity = directory.directory_identity()?;
    let identity = match named {
        Some(path) => format!("named:{directory_identity}:{}", path.display()),
        None => format!("descriptor:{directory_identity}"),
    };
    let mut anchors = ANCHORS
        .get_or_init(|| Mutex::new(Vec::new()))
        .lock()
        .map_err(|_| anyhow::anyhow!("native SQLite anchors unavailable"))?;
    if let Some(anchor) = anchors.iter().find(|anchor| anchor.identity == identity) {
        return Ok(anchor.clone());
    }
    ensure!(
        anchors.len() < MAX_ANCHORS,
        "native SQLite anchor capacity reached"
    );
    let directory = directory.duplicate_handle()?;
    let path = match named {
        Some(path) => path.to_path_buf(),
        None => directory.native_sqlite_entry_alias(OsStr::new(DB))?,
    };
    let path = CString::new(
        path.to_str()
            .ok_or_else(|| anyhow::anyhow!("native SQLite alias unavailable"))?,
    )?;
    let name = CString::new(format!("kcoder-native-directory-{}", anchors.len()))?;
    // The system VFS owns every sqlite3_file and its native io_methods. No
    // replacement xLock, RAM WAL index, exclusive namespace lock or DB copy exists.
    let (original, registered) = unsafe {
        ensure!(
            ffi::sqlite3_initialize() == ffi::SQLITE_OK,
            "SQLite initialization failed"
        );
        let original = ffi::sqlite3_vfs_find(ptr::null());
        ensure!(!original.is_null(), "system SQLite VFS unavailable");
        let mut forwarded = ptr::read(original);
        forwarded.pNext = ptr::null_mut();
        forwarded.zName = name.as_ptr();
        forwarded.xFullPathname = Some(full_path);
        forwarded.xOpen = Some(open);
        forwarded.xAccess = Some(access);
        forwarded.xDelete = Some(delete);
        (
            original as usize,
            Box::into_raw(Box::new(forwarded)) as usize,
        )
    };
    let anchor = Arc::new(Anchor {
        directory,
        identity,
        path,
        name,
        original,
        registered,
    });
    // Keep callback metadata reachable before the VFS becomes discoverable.
    anchors.push(anchor.clone());
    let code = unsafe { ffi::sqlite3_vfs_register(registered as *mut ffi::sqlite3_vfs, 0) };
    ensure!(
        code == ffi::SQLITE_OK,
        "native SQLite VFS registration failed"
    );
    Ok(anchor)
}

#[cfg(windows)]
fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|e| {
        e.downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
    })
}

fn context(vfs: *mut ffi::sqlite3_vfs) -> Option<Arc<Anchor>> {
    ANCHORS
        .get()?
        .lock()
        .ok()?
        .iter()
        .find(|a| a.registered == vfs as usize)
        .cloned()
}

unsafe extern "C" fn full_path(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    size: i32,
    out: *mut std::ffi::c_char,
) -> i32 {
    let Some(anchor) = context(vfs) else {
        return ffi::SQLITE_CANTOPEN;
    };
    if name.is_null()
        || out.is_null()
        || size <= 0
        || anchor.directory.verify_private_directory().is_err()
    {
        return ffi::SQLITE_CANTOPEN;
    }
    let name = unsafe { CStr::from_ptr(name) };
    if name != anchor.path.as_c_str() || name.to_bytes_with_nul().len() >= size as usize {
        return ffi::SQLITE_CANTOPEN;
    }
    unsafe {
        ptr::copy_nonoverlapping(name.as_ptr(), out, name.to_bytes_with_nul().len());
        *out.add(name.to_bytes_with_nul().len()) = 0;
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn open(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    file: *mut ffi::sqlite3_file,
    flags: i32,
    actual: *mut i32,
) -> i32 {
    let Some(anchor) = context(vfs) else {
        return ffi::SQLITE_CANTOPEN;
    };
    if anchor.directory.verify_private_directory().is_err()
        || !name.is_null() && !anchor.verify_entry(unsafe { CStr::from_ptr(name) })
    {
        return ffi::SQLITE_CANTOPEN;
    }
    unsafe {
        match (*anchor.original()).xOpen {
            Some(callback) => callback(
                anchor.original(),
                name,
                file,
                flags | ffi::SQLITE_OPEN_NOFOLLOW,
                actual,
            ),
            None => ffi::SQLITE_CANTOPEN,
        }
    }
}

unsafe extern "C" fn access(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    flags: i32,
    out: *mut i32,
) -> i32 {
    let Some(anchor) = context(vfs) else {
        return ffi::SQLITE_CANTOPEN;
    };
    if name.is_null() || !anchor.verify_entry(unsafe { CStr::from_ptr(name) }) {
        return ffi::SQLITE_CANTOPEN;
    }
    unsafe {
        match (*anchor.original()).xAccess {
            Some(callback) => callback(anchor.original(), name, flags, out),
            None => ffi::SQLITE_CANTOPEN,
        }
    }
}

unsafe extern "C" fn delete(
    vfs: *mut ffi::sqlite3_vfs,
    name: *const std::ffi::c_char,
    sync: i32,
) -> i32 {
    let Some(anchor) = context(vfs) else {
        return ffi::SQLITE_CANTOPEN;
    };
    if name.is_null()
        || !anchor.verify_entry(unsafe { CStr::from_ptr(name) })
        || unsafe { CStr::from_ptr(name) } == anchor.path.as_c_str()
    {
        return ffi::SQLITE_IOERR_DELETE;
    }
    unsafe {
        match (*anchor.original()).xDelete {
            Some(callback) => callback(anchor.original(), name, sync),
            None => ffi::SQLITE_IOERR_DELETE,
        }
    }
}
