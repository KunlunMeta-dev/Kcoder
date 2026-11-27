//! Streaming SHA-256 bounded by an already captured file size.
use sha2::{Digest, Sha256};
use std::io::Read;

/// Why a bounded digest did not complete. Callers map each to their own code.
#[derive(Debug)]
pub enum HashFailure {
    /// The underlying read failed; the original error is preserved.
    Io(std::io::Error),
    /// The running byte count overflowed `u64`.
    Overflow,
    /// More bytes were read than the captured size allows.
    Exceeded,
    /// The caller's cancellation was observed before a read.
    Cancelled,
}

/// A complete digest: the number of bytes read and their lowercase hex SHA-256.
#[derive(Debug, PartialEq, Eq)]
pub struct ImageDigest {
    pub bytes: u64,
    pub sha256: String,
}

/// Hash `reader` to EOF in `BUFFER`-byte reads. Cancellation is polled before
/// every read and the running total may never exceed `limit`. A short read
/// (fewer bytes than the captured size) is reported through `bytes`; the
/// caller decides whether that is a mismatch. Interrupted reads are failures,
/// never retried, so a partial digest is never returned as complete.
pub fn sha256_bounded<const BUFFER: usize>(
    reader: &mut impl Read,
    limit: u64,
    mut cancelled: impl FnMut() -> bool,
) -> Result<ImageDigest, HashFailure> {
    let mut hash = Sha256::new();
    let mut buffer = [0u8; BUFFER];
    let mut total = 0u64;
    loop {
        if cancelled() {
            return Err(HashFailure::Cancelled);
        }
        let count = reader.read(&mut buffer).map_err(HashFailure::Io)?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or(HashFailure::Overflow)?;
        if total > limit {
            return Err(HashFailure::Exceeded);
        }
        hash.update(&buffer[..count]);
    }
    Ok(ImageDigest {
        bytes: total,
        sha256: format!("{:x}", hash.finalize()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn digest_matches_sha256_and_reports_bytes() {
        let bytes = vec![7u8; 70_000];
        let digest = sha256_bounded::<4096>(&mut bytes.as_slice(), 70_000, || false).unwrap();
        assert_eq!(digest.bytes, 70_000);
        assert_eq!(digest.sha256, format!("{:x}", Sha256::digest(&bytes)));
        let empty = sha256_bounded::<16>(&mut [].as_slice(), 0, || false).unwrap();
        assert_eq!(empty.sha256, EMPTY);
    }

    #[test]
    fn bytes_beyond_the_captured_size_are_rejected() {
        let bytes = [1u8; 10];
        assert!(matches!(
            sha256_bounded::<4>(&mut bytes.as_slice(), 9, || false),
            Err(HashFailure::Exceeded)
        ));
        // A short stream is complete here; the caller compares `bytes`.
        let short = sha256_bounded::<4>(&mut bytes.as_slice(), 11, || false).unwrap();
        assert_eq!(short.bytes, 10);
    }

    #[test]
    fn cancellation_is_polled_before_each_read() {
        let bytes = [1u8; 10];
        let mut polls = 0;
        assert!(matches!(
            sha256_bounded::<4>(&mut bytes.as_slice(), 10, || {
                polls += 1;
                polls == 2
            }),
            Err(HashFailure::Cancelled)
        ));
        assert_eq!(polls, 2);
    }

    #[test]
    fn read_errors_are_preserved_and_not_retried() {
        struct Interrupted(usize);
        impl Read for Interrupted {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                self.0 += 1;
                Err(std::io::ErrorKind::Interrupted.into())
            }
        }
        let mut reader = Interrupted(0);
        match sha256_bounded::<4>(&mut reader, 10, || false) {
            Err(HashFailure::Io(error)) => {
                assert_eq!(error.kind(), std::io::ErrorKind::Interrupted)
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(reader.0, 1);
    }
}
