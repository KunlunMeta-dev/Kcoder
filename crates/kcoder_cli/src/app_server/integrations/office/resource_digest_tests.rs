//! Full byte digest equivalence and original cancellation/size/fuse boundaries.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom, Write};

#[test]
fn complete_office_digests_match_existing_sha256_across_block_and_chunk_boundaries() -> Result<()> {
    let directory = tempfile::tempdir()?;
    for length in [
        0,
        1,
        63,
        64,
        65,
        65535,
        65536,
        65537,
        262143,
        262144,
        262145,
        4 * 1024 * 1024 + 17,
    ] {
        let bytes = (0..length)
            .map(|index| ((index * 31 + 7) % 251) as u8)
            .collect::<Vec<_>>();
        let expected = format!("{:x}", Sha256::digest(&bytes));
        let mut file = tempfile::tempfile()?;
        file.write_all(&bytes)?;
        file.seek(SeekFrom::Start(0))?;
        assert_eq!(
            digest(&mut file, length as u64, &CancellationToken::new())?,
            expected
        );
        let path = directory.path().join("original-runtime");
        std::fs::write(&path, &bytes)?;
        assert_eq!(
            hash_runtime(&path, &CancellationToken::new(), false)?.sha256,
            expected
        );
    }
    Ok(())
}
#[test]
fn complete_office_hash_keeps_cancel_size_and_split_runtime_fuse_facts() -> Result<()> {
    let mut file = tempfile::tempfile()?;
    file.write_all(b"original")?;
    file.seek(SeekFrom::Start(0))?;
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(digest(&mut file, 8, &cancel).is_err());
    file.seek(SeekFrom::Start(0))?;
    assert!(digest(&mut file, 9, &CancellationToken::new()).is_err());
    let directory = tempfile::tempdir()?;
    let path = directory.path().join("original-runtime");
    let mut bytes = vec![0; 256 * 1024 - 10];
    bytes.extend_from_slice(b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
    bytes.extend_from_slice(&[1, 1, 49, 0]);
    std::fs::write(&path, &bytes)?;
    assert!(hash_runtime(&path, &cancel, true).is_err());
    let found = hash_runtime(&path, &CancellationToken::new(), true)?;
    assert!(found.has_electron_fuse && found.run_as_node_enabled);
    assert_eq!(found.sha256, format!("{:x}", Sha256::digest(&bytes)));
    bytes[256 * 1024 - 10 + 32 + 2] = 48;
    std::fs::write(&path, &bytes)?;
    let disabled = hash_runtime(&path, &CancellationToken::new(), true)?;
    assert!(disabled.has_electron_fuse && !disabled.run_as_node_enabled);
    Ok(())
}
