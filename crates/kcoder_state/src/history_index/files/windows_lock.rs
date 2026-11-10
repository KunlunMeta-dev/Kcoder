//! Windows byte locks are mandatory, while SQLite reads its header before xLock.
//! Coordinate beyond the bounded data range so those header reads remain legal.
use std::{fs::File, io, os::windows::io::AsRawHandle};
use windows_sys::Win32::{
    Storage::FileSystem::{
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx, UnlockFileEx,
    },
    System::IO::OVERLAPPED,
};

// The VFS rejects databases/journals above 4 GiB. Locking at 8 GiB never covers
// payload bytes and still overlaps the legacy fs2 whole-file lock range.
pub(super) const LOCK_OFFSET: u64 = 8 * 1024 * 1024 * 1024;

fn offset() -> OVERLAPPED {
    // SAFETY: this POD is initialized synchronously; no event or async I/O is used.
    let mut value: OVERLAPPED = unsafe { std::mem::zeroed() };
    value.Anonymous.Anonymous.Offset = LOCK_OFFSET as u32;
    value.Anonymous.Anonymous.OffsetHigh = (LOCK_OFFSET >> 32) as u32;
    value
}

pub(super) fn try_lock_exclusive(file: &File) -> io::Result<()> {
    let mut overlapped = offset();
    // SAFETY: the owned handle stays live and the exact OVERLAPPED buffer outlives
    // this synchronous, fail-immediately call.
    if unsafe {
        LockFileEx(
            file.as_raw_handle().cast(),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(super) fn unlock(file: &File) -> io::Result<()> {
    let mut overlapped = offset();
    // SAFETY: the same live handle and byte range release its synchronous lock.
    if unsafe { UnlockFileEx(file.as_raw_handle().cast(), 0, 1, 0, &mut overlapped) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs2::FileExt;
    use std::io::{Read, Seek, SeekFrom, Write};

    fn files() -> (tempfile::TempDir, File, File) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("catalog.sqlite3");
        std::fs::write(&path, b"SQLite format 3\0").unwrap();
        let open = || {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap()
        };
        (directory, open(), open())
    }

    #[test]
    fn catalog_lock_allows_sqlite_prelock_header_reads_without_growth() {
        let (_directory, writer, mut reader) = files();
        try_lock_exclusive(&writer).unwrap();
        let mut header = [0; 16];
        reader.read_exact(&mut header).unwrap();
        assert_eq!(&header, b"SQLite format 3\0");
        assert!(try_lock_exclusive(&reader).is_err());
        assert_eq!(writer.metadata().unwrap().len(), 16);
        unlock(&writer).unwrap();
        try_lock_exclusive(&reader).unwrap();
        reader.seek(SeekFrom::Start(0)).unwrap();
        reader.write_all(b"SQLite format 3\0").unwrap();
        unlock(&reader).unwrap();
    }

    #[test]
    fn new_and_legacy_catalog_lock_ranges_remain_mutually_exclusive() {
        let (_directory, first, second) = files();
        try_lock_exclusive(&first).unwrap();
        assert!(FileExt::try_lock_exclusive(&second).is_err());
        unlock(&first).unwrap();
        FileExt::try_lock_exclusive(&first).unwrap();
        assert!(try_lock_exclusive(&second).is_err());
        FileExt::unlock(&first).unwrap();
        try_lock_exclusive(&second).unwrap();
        unlock(&second).unwrap();
    }

    #[test]
    fn legacy_whole_file_lock_reproduces_native_prelock_read_failure() {
        let (_directory, writer, mut reader) = files();
        FileExt::try_lock_exclusive(&writer).unwrap();
        let error = reader.read_exact(&mut [0; 16]).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(33));
        FileExt::unlock(&writer).unwrap();
    }

    #[test]
    #[ignore = "owned subprocess helper; invoked explicitly by the cross-process regression"]
    fn owned_process_lock_holder() {
        let path = std::env::var_os("KCODER_TEST_WINDOWS_CATALOG_LOCK_FILE").unwrap();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        try_lock_exclusive(&file).unwrap();
        println!("WINDOWS_CATALOG_LOCK_READY");
        std::io::stdout().flush().unwrap();
        let mut command = String::new();
        std::io::stdin().read_line(&mut command).unwrap();
        assert_eq!(command.trim(), "release");
        unlock(&file).unwrap();
    }

    #[test]
    fn native_catalog_lock_serializes_processes_and_releases_for_the_next_writer() {
        use std::{
            io::BufRead,
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let (directory, _writer, mut reader) = files();
        let helper = format!(
            "{}::owned_process_lock_holder",
            module_path!().split_once("::").unwrap().1
        );
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", helper.as_str(), "--nocapture"])
                .env(
                    "KCODER_TEST_WINDOWS_CATALOG_LOCK_FILE",
                    directory.path().join("catalog.sqlite3"),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
        let (send, receive) = std::sync::mpsc::channel();
        let output = child.0.stdout.take().unwrap();
        let observer = std::thread::spawn(move || {
            for line in std::io::BufReader::new(output).lines() {
                if line.unwrap() == "WINDOWS_CATALOG_LOCK_READY" {
                    let _ = send.send(());
                }
            }
        });
        receive.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(try_lock_exclusive(&reader).is_err());
        reader.read_exact(&mut [0; 16]).unwrap();
        child
            .0
            .stdin
            .take()
            .unwrap()
            .write_all(b"release\n")
            .unwrap();
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(
                Instant::now() < until,
                "owned child did not release its lock"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
        observer.join().unwrap();
        try_lock_exclusive(&reader).unwrap();
        unlock(&reader).unwrap();
    }
}
