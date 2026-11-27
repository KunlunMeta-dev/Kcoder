use super::super::image::NativeServiceImage;
use super::NativeUserServicePeer;
use std::os::unix::net::UnixStream;
use std::{
    fs::OpenOptions,
    io::{Seek, Write},
    os::unix::fs::MetadataExt,
    sync::atomic::{AtomicU64, Ordering},
};
use tokio_util::sync::CancellationToken;

#[test]
fn matching_self_image_peer_reuses_digest_without_reading_peer_bytes() {
    let self_image = NativeServiceImage::capture(&CancellationToken::new())
        .expect("capture verified self image");
    let (stream, _other_end) = UnixStream::pair().expect("same-process peer pair");

    let mut peer = NativeUserServicePeer::capture(&stream, self_image.sha256())
        .expect("peer with matching self-image digest");

    assert_eq!(
        peer.held_pid().expect("verified peer pid"),
        std::process::id()
    );
    assert_eq!(
        peer.image.stream_position().expect("peer file position"),
        0,
        "matching cached digest should avoid reading peer executable bytes"
    );
    peer.verify().expect("peer identity remains valid");
}

#[test]
fn peer_capture_still_rejects_an_incorrect_expected_sha() {
    let self_image = NativeServiceImage::capture(&CancellationToken::new())
        .expect("capture verified self image");
    let wrong_sha = format!("{}-wrong", self_image.sha256());
    let (stream, _other_end) = UnixStream::pair().expect("same-process peer pair");

    let error = NativeUserServicePeer::capture(&stream, &wrong_sha)
        .err()
        .expect("wrong expected SHA must be rejected");

    assert_eq!(error.to_string(), super::PEER_IMAGE_CHANGED);
}

#[test]
fn each_peer_denial_cause_reports_its_own_code() {
    use super::*;
    assert_eq!(
        check_credentials(false, 1000, 1000, 7)
            .unwrap_err()
            .to_string(),
        PEER_DENIED
    );
    assert_eq!(
        check_credentials(true, 1000, 1000, 0)
            .unwrap_err()
            .to_string(),
        PEER_DENIED
    );
    assert_eq!(
        check_credentials(true, 1001, 1000, 7)
            .unwrap_err()
            .to_string(),
        PEER_ACCOUNT_MISMATCH
    );
    check_credentials(true, 1000, 1000, 7).unwrap();
    assert_eq!(pidfd_open_failure(libc::ESRCH), PEER_EXITED);
    assert_eq!(pidfd_open_failure(libc::ENOSYS), PEER_PIDFD_UNSUPPORTED);
    assert_eq!(pidfd_open_failure(libc::EPERM), PEER_PIDFD_UNSUPPORTED);
    assert_eq!(pidfd_open_failure(libc::EMFILE), PEER_DENIED);
    for (is_file, bytes) in [(false, 4096), (true, 0), (true, 1024 * 1024 * 1024 + 1)] {
        assert_eq!(
            check_image_metadata(is_file, bytes)
                .unwrap_err()
                .to_string(),
            PEER_DENIED
        );
    }
    check_image_metadata(true, 4096).unwrap();
    assert_eq!(check_pidfd_poll(1).unwrap_err().to_string(), PEER_EXITED);
    assert_eq!(check_pidfd_poll(-1).unwrap_err().to_string(), PEER_DENIED);
    check_pidfd_poll(0).unwrap();
}

fn isolated_path(label: &str) -> std::path::PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!(
        "kcoder-peer-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

fn pidfd(pid: u32) -> std::os::fd::OwnedFd {
    use std::os::fd::FromRawFd;
    let raw = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as i32, 0) };
    assert!(raw >= 0, "pidfd_open is required by this Linux regression");
    unsafe { std::os::fd::OwnedFd::from_raw_fd(raw as i32) }
}

#[test]
fn exited_peer_reports_exited_instead_of_a_generic_denial() {
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .spawn()
        .expect("spawn owned short-lived peer fixture");
    let held = pidfd(child.id());
    child.wait().expect("reap owned peer fixture");
    let image = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
    let metadata = image.metadata().unwrap();
    let peer = NativeUserServicePeer {
        pidfd: held,
        pid: child.id() as i32,
        image,
        identity: (metadata.dev(), metadata.ino(), metadata.len()),
    };
    assert_eq!(peer.verify().unwrap_err().to_string(), super::PEER_EXITED);
}

#[test]
fn replaced_or_modified_peer_image_reports_image_changed() {
    let self_image = NativeServiceImage::capture(&CancellationToken::new())
        .expect("capture verified self image");
    let (stream, _other_end) = UnixStream::pair().expect("same-process peer pair");
    let mut peer = NativeUserServicePeer::capture(&stream, self_image.sha256())
        .expect("peer with matching self-image digest");
    peer.verify().unwrap();
    // The held identity no longer names the live peer image.
    peer.identity.2 += 1;
    assert_eq!(
        peer.verify().unwrap_err().to_string(),
        super::PEER_IMAGE_CHANGED
    );
    // A peer whose live image is a different inode (exec or replacement).
    let other = isolated_path("replacement");
    std::fs::write(&other, b"replacement image").unwrap();
    let replacement = std::fs::File::open(&other).unwrap();
    std::fs::remove_file(&other).unwrap();
    let metadata = replacement.metadata().unwrap();
    let replaced = NativeUserServicePeer {
        pidfd: pidfd(std::process::id()),
        pid: std::process::id() as i32,
        image: replacement,
        identity: (metadata.dev(), metadata.ino(), metadata.len()),
    };
    assert_eq!(
        replaced.verify().unwrap_err().to_string(),
        super::PEER_IMAGE_CHANGED
    );
}

#[test]
fn image_that_changes_size_while_hashing_reports_image_changed() {
    let path = isolated_path("resized");
    let mut file = OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    std::fs::remove_file(&path).unwrap();
    file.write_all(b"grown after the size was captured")
        .unwrap();
    file.rewind().unwrap();
    let metadata = file.metadata().unwrap();
    let shorter = (metadata.dev(), metadata.ino(), metadata.len() - 1);
    assert_eq!(
        super::peer_content_sha256(&mut file, shorter, None)
            .unwrap_err()
            .to_string(),
        super::PEER_IMAGE_CHANGED
    );
    file.rewind().unwrap();
    let longer = (metadata.dev(), metadata.ino(), metadata.len() + 1);
    assert_eq!(
        super::peer_content_sha256(&mut file, longer, None)
            .unwrap_err()
            .to_string(),
        super::PEER_IMAGE_CHANGED
    );
}

#[test]
fn missing_peer_digest_uses_the_full_size_checked_hash_path() {
    static NEXT_FILE: AtomicU64 = AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "kcoder-peer-image-hash-{}-{}",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    let contents = b"peer executable fallback bytes";
    let mut image = OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(&path)
        .expect("create isolated peer-image fixture");
    image.write_all(contents).expect("write peer-image fixture");
    let metadata = image.metadata().expect("fixture metadata");
    let identity = (metadata.dev(), metadata.ino(), metadata.len());
    image.rewind().expect("start reading peer-image fixture");

    let sha256 = super::peer_content_sha256(&mut image, identity, None)
        .expect("cache miss performs full peer-image hash");
    let expected: String = ring::digest::digest(&ring::digest::SHA256, contents)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    assert_eq!(sha256, expected);
    assert_eq!(
        image.stream_position().expect("peer image cursor"),
        identity.2,
        "cache miss must read and size-check the full peer image"
    );
    drop(image);
    std::fs::remove_file(path).expect("remove isolated peer-image fixture");
}
