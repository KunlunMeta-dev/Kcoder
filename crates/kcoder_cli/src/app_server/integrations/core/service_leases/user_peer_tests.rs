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

    assert!(
        error
            .to_string()
            .contains("NATIVE_CODE_MANAGER_PEER_DENIED")
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
