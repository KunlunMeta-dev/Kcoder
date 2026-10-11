use super::*;
use std::sync::atomic::AtomicUsize;
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "kcoder-owned-selected-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, size: u64) -> PathBuf {
        let path = self.0.join(name);
        File::create(&path).unwrap().set_len(size).unwrap();
        path
    }
    fn discover(&self, state: &SelectedFileReads) -> Result<SelectedFileRead, String> {
        state.discover(
            "owned".into(),
            vec![self.0.to_string_lossy().into()],
            state.reserve("owned")?,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
#[test]
fn oversized_metadata_is_rejected_before_any_file_read() {
    let fixture = Fixture::new();
    fixture.file("oversized", MAX_FILE_BYTES + 1);
    let state = SelectedFileReads::default();
    assert!(fixture.discover(&state).err().unwrap().contains("100 MiB"));
    assert_eq!(state.0.lock().unwrap().len(), 0);
}
#[test]
fn small_and_exact_100_mib_files_use_bounded_real_handle_chunks() {
    let fixture = Fixture::new();
    let small = fixture.file("small.txt", 3);
    std::fs::write(small, "abc").unwrap();
    fixture.file("large.bin", MAX_FILE_BYTES);
    let state = SelectedFileReads::default();
    let selected = fixture.discover(&state).unwrap();
    assert_eq!(selected.files.len(), 2);
    assert_eq!(selected.chunk_bytes, CHUNK_BYTES);
    for (index, metadata) in selected.files.iter().enumerate() {
        let mut offset = 0;
        while offset < metadata.size {
            let bytes = state.chunk("owned", index, offset).unwrap();
            assert!(bytes.len() <= CHUNK_BYTES);
            offset += bytes.len() as u64;
        }
        assert_eq!(offset, metadata.size);
        if metadata.name == "small.txt" {
            assert_eq!(state.chunk("owned", index, 0).unwrap(), b"abc");
        }
    }
    state.cancel("owned").unwrap();
    assert!(state.chunk("owned", 0, 0).is_err());
}
#[test]
fn directory_total_file_count_and_depth_fail_before_reading() {
    let fixture = Fixture::new();
    for index in 0..6 {
        fixture.file(&format!("file{index}"), MAX_FILE_BYTES);
    }
    assert!(fixture
        .discover(&SelectedFileReads::default())
        .err()
        .unwrap()
        .contains("total size"));
    let fixture = Fixture::new();
    for index in 0..=MAX_FILES {
        fixture.file(&format!("file{index}"), 0);
    }
    assert!(fixture
        .discover(&SelectedFileReads::default())
        .err()
        .unwrap()
        .contains("file count"));
    let fixture = Fixture::new();
    let mut directory = fixture.0.clone();
    for _ in 0..=MAX_DEPTH {
        directory = directory.join("d");
        std::fs::create_dir(&directory).unwrap();
    }
    assert!(fixture
        .discover(&SelectedFileReads::default())
        .err()
        .unwrap()
        .contains("depth"));
}
#[test]
fn cancel_discovery_and_read_release_handles_and_capacity() {
    let fixture = Fixture::new();
    fixture.file("file", MAX_FILE_BYTES);
    let state = SelectedFileReads::default();
    let entry = state.reserve("owned").unwrap();
    state.cancel("owned").unwrap();
    assert!(state
        .discover(
            "owned".into(),
            vec![fixture.0.to_string_lossy().into()],
            entry
        )
        .is_err());
    fixture.discover(&state).unwrap();
    assert_eq!(state.chunk("owned", 0, 0).unwrap().len(), CHUNK_BYTES);
    state.cancel("owned").unwrap();
    assert!(state.chunk("owned", 0, CHUNK_BYTES as u64).is_err());
    for _ in 0..8 {
        fixture.discover(&state).unwrap();
        state.cancel("owned").unwrap();
    }
    assert!(state.0.lock().unwrap().is_empty());
}
#[cfg(unix)]
#[test]
fn symlinks_are_skipped_and_special_files_are_rejected_without_opening() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let path = fixture.file("file", 3);
    symlink(path, fixture.0.join("link")).unwrap();
    let state = SelectedFileReads::default();
    assert_eq!(fixture.discover(&state).unwrap().files.len(), 1);
    state.cancel("owned").unwrap();
    let fifo = std::ffi::CString::new(fixture.0.join("pipe").to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert!(fixture
        .discover(&state)
        .err()
        .unwrap()
        .contains("not a regular file"));
}
