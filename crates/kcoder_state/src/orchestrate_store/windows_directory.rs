//! Handle-relative traversal for already-authorized PlanStore cleanup targets.
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::fs::MetadataExt;
use std::os::windows::io::AsRawHandle;

use anyhow::{Context, bail, ensure};
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DISPOSITION_INFO, FILE_GENERIC_READ,
    FILE_ID_BOTH_DIR_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE, FileDispositionInfo,
    FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx,
    SetFileInformationByHandle,
};

use super::windows_io::open_relative;

const MAX_ENTRIES: usize = 65_536;
const MAX_DEPTH: usize = 128;

pub(super) fn enumerate(directory: &File) -> anyhow::Result<Vec<OsString>> {
    let metadata = directory.metadata()?;
    ensure!(
        metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
        "unsafe PlanStore enumeration directory"
    );
    let mut entries = Vec::new();
    let mut buffer = vec![0u64; 8192];
    let capacity = buffer.len() * std::mem::size_of::<u64>();
    let mut first = true;
    loop {
        let class = if first {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        // The buffer is aligned and the kernel bounds each returned record by its offset.
        let result = unsafe {
            GetFileInformationByHandleEx(
                directory.as_raw_handle(),
                class,
                buffer.as_mut_ptr().cast(),
                capacity as u32,
            )
        };
        if result == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(18) {
                break;
            }
            return Err(error).context("failed to enumerate PlanStore directory handle");
        }
        first = false;
        let mut offset = 0usize;
        loop {
            let header = std::mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
            ensure!(
                offset + header <= capacity,
                "invalid PlanStore directory record"
            );
            let base = unsafe { buffer.as_ptr().cast::<u8>().add(offset) };
            let record = base.cast::<FILE_ID_BOTH_DIR_INFO>();
            let next =
                unsafe { std::ptr::addr_of!((*record).NextEntryOffset).read_unaligned() } as usize;
            let length =
                unsafe { std::ptr::addr_of!((*record).FileNameLength).read_unaligned() } as usize;
            let record_size = if next == 0 { capacity - offset } else { next };
            ensure!(
                record_size >= header
                    && offset + record_size <= capacity
                    && length % 2 == 0
                    && length <= record_size - header,
                "invalid PlanStore directory filename"
            );
            let name: Vec<u16> = (0..length / 2)
                .map(|index| unsafe { base.add(header + index * 2).cast::<u16>().read_unaligned() })
                .collect();
            let name = OsString::from_wide(&name);
            if name != OsStr::new(".") && name != OsStr::new("..") {
                validate_name(&name)?;
                ensure!(
                    entries.len() < MAX_ENTRIES,
                    "PlanStore directory entry limit exceeded"
                );
                entries.push(name);
            }
            if next == 0 {
                break;
            }
            offset += next;
        }
    }
    Ok(entries)
}

fn validate_name(name: &OsStr) -> anyhow::Result<()> {
    let units: Vec<u16> = name.encode_wide().collect();
    ensure!(
        !units.is_empty()
            && name != OsStr::new(".")
            && name != OsStr::new("..")
            && !units.iter().any(|unit| matches!(*unit, 0 | 47 | 58 | 92)),
        "unsafe PlanStore cleanup name"
    );
    Ok(())
}

/// The caller must restrict this entry point to orphan works or uncommitted revisions.
pub(super) fn delete_tree(parent: &File, name: &OsStr) -> anyhow::Result<()> {
    let mut remaining = MAX_ENTRIES;
    delete_entry(parent, name, 0, &mut remaining)
}

fn delete_entry(
    parent: &File,
    name: &OsStr,
    depth: usize,
    remaining: &mut usize,
) -> anyhow::Result<()> {
    validate_name(name)?;
    ensure!(
        depth < MAX_DEPTH && *remaining > 0,
        "PlanStore cleanup traversal limit exceeded"
    );
    *remaining -= 1;
    // Omitting share-delete pins this exact entry until disposition is set on its handle.
    let entry = open_relative(
        parent,
        name,
        FILE_GENERIC_READ | DELETE,
        1,
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )
    .context("failed to open PlanStore cleanup entry")?;
    let metadata = entry.metadata()?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        bail!("refusing to traverse PlanStore reparse point during cleanup");
    }
    if metadata.is_dir() {
        for child in enumerate(&entry)? {
            delete_entry(&entry, &child, depth + 1, remaining)?;
        }
    } else {
        ensure!(metadata.is_file(), "unsupported PlanStore cleanup entry");
    }
    let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    if unsafe {
        SetFileInformationByHandle(
            entry.as_raw_handle(),
            FileDispositionInfo,
            (&mut disposition as *mut FILE_DISPOSITION_INFO).cast(),
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error())
            .context("failed to delete PlanStore entry by handle");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    fn directory(path: &std::path::Path) -> File {
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .unwrap()
    }

    #[test]
    fn windows_directory_enumeration_and_nested_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("orphan/nested")).unwrap();
        fs::write(temp.path().join("orphan/nested/中文.txt"), "content").unwrap();
        fs::write(temp.path().join("keep.txt"), "keep").unwrap();
        let parent = directory(temp.path());
        let first = enumerate(&parent).unwrap();
        assert!(first.contains(&OsString::from("orphan")));
        assert!(first.contains(&OsString::from("keep.txt")));
        assert_eq!(enumerate(&parent).unwrap().len(), 2);
        delete_tree(&parent, OsStr::new("orphan")).unwrap();
        assert!(!temp.path().join("orphan").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("keep.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn windows_directory_cleanup_rejects_escape_and_junction() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), "unchanged").unwrap();
        let junction = temp.path().join("orphan");
        assert!(
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&junction)
                .arg(outside.path())
                .status()
                .unwrap()
                .success()
        );
        let parent = directory(temp.path());
        for name in ["..", "../outside", "file:stream", ""] {
            assert!(delete_tree(&parent, OsStr::new(name)).is_err());
        }
        assert!(delete_tree(&parent, OsStr::new("orphan")).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("keep.txt")).unwrap(),
            "unchanged"
        );
        fs::remove_dir(junction).unwrap();
    }
}
