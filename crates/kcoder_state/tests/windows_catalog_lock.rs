//! Standalone native Windows regression entry for the private SQLite VFS lock.
//! It can be cross-built with rustc against the pinned release dependencies and
//! executed on an owned Windows host without building or installing the CLI.
#[cfg(windows)]
#[path = "../src/history_index/files/windows_lock.rs"]
mod windows_lock;
