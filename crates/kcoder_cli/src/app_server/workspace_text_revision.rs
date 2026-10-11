//! Validate text and hash its original bytes without changing the save contract.
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};
#[cfg(test)]
use tokio::io::{AsyncRead, AsyncReadExt};

const READ_WINDOW_BYTES: usize = 64 * 1024;

#[cfg(test)]
pub(super) async fn read(reader: &mut (impl AsyncRead + Unpin)) -> Result<(String, u64)> {
    let mut bytes = [0_u8; READ_WINDOW_BYTES + 3];
    let mut tail = 0;
    let mut size = 0_u64;
    let mut digest = Sha256::new();
    loop {
        let count = reader
            .read(&mut bytes[tail..tail + READ_WINDOW_BYTES])
            .await?;
        if count == 0 {
            // EOF may split a character. Incomplete tails are errors, not text
            // that can be replaced or silently omitted from the revision.
            std::str::from_utf8(&bytes[..tail]).context("workspace file is not valid UTF-8")?;
            return Ok((format!("sha256:{:x}", digest.finalize()), size));
        }
        digest.update(&bytes[tail..tail + count]);
        size = size
            .checked_add(count as u64)
            .context("workspace file size overflow")?;
        let length = tail + count;
        tail = match std::str::from_utf8(&bytes[..length]) {
            Ok(_) => 0,
            Err(error) if error.error_len().is_none() => {
                let incomplete = length - error.valid_up_to();
                bytes.copy_within(error.valid_up_to()..length, 0);
                incomplete
            }
            Err(error) => return Err(error).context("workspace file is not valid UTF-8"),
        };
    }
}

pub(super) fn read_sync(reader: &mut impl std::io::Read) -> Result<(String, u64)> {
    let mut bytes = [0_u8; READ_WINDOW_BYTES + 3];
    let mut tail = 0;
    let mut size = 0_u64;
    let mut digest = Sha256::new();
    loop {
        let count = reader.read(&mut bytes[tail..tail + READ_WINDOW_BYTES])?;
        if count == 0 {
            // EOF may split a character. Incomplete tails are errors, not text
            // that can be replaced or silently omitted from the revision.
            std::str::from_utf8(&bytes[..tail]).context("workspace file is not valid UTF-8")?;
            return Ok((format!("sha256:{:x}", digest.finalize()), size));
        }
        digest.update(&bytes[tail..tail + count]);
        size = size
            .checked_add(count as u64)
            .context("workspace file size overflow")?;
        let length = tail + count;
        tail = match std::str::from_utf8(&bytes[..length]) {
            Ok(_) => 0,
            Err(error) if error.error_len().is_none() => {
                let incomplete = length - error.valid_up_to();
                bytes.copy_within(error.valid_up_to()..length, 0);
                incomplete
            }
            Err(error) => return Err(error).context("workspace file is not valid UTF-8"),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Cursor,
        pin::Pin,
        task::{Context as TaskContext, Poll},
    };
    use tokio::io::ReadBuf;

    struct ObservedReader {
        data: Cursor<Vec<u8>>,
        max_request: usize,
        request_limit: usize,
    }
    impl AsyncRead for ObservedReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            self.max_request = self.max_request.max(buffer.remaining());
            let limit = self.request_limit.min(buffer.remaining());
            let length = std::io::Read::read(&mut self.data, buffer.initialize_unfilled_to(limit))?;
            buffer.advance(length);
            Poll::Ready(Ok(()))
        }
    }
    fn observed(bytes: Vec<u8>, request_limit: usize) -> ObservedReader {
        ObservedReader {
            data: Cursor::new(bytes),
            max_request: 0,
            request_limit,
        }
    }

    #[tokio::test]
    async fn multi_mib_original_has_a_bounded_read_window_and_exact_full_revision() {
        let bytes = "中😀é\r\n".repeat(400_000).into_bytes();
        let expected = format!("sha256:{:x}", Sha256::digest(&bytes));
        let size = bytes.len() as u64;
        let mut source = observed(bytes, usize::MAX);
        let result = read(&mut source).await.unwrap();
        assert_eq!(result, (expected, size));
        assert!(
            source.max_request <= READ_WINDOW_BYTES,
            "old original reads requested {} bytes",
            source.max_request
        );
        assert_eq!(source.data.position(), size);
    }

    #[tokio::test]
    async fn unicode_and_bom_hashes_are_exact_even_with_one_byte_reads() {
        for input in ["", "ascii\r\n", "\u{feff}中😀é"] {
            for limit in [1, 2, 3, 7, READ_WINDOW_BYTES] {
                let mut source = observed(input.as_bytes().to_vec(), limit);
                assert_eq!(
                    read_sync(&mut std::io::Cursor::new(input.as_bytes())).unwrap(),
                    (
                        format!("sha256:{:x}", Sha256::digest(input.as_bytes())),
                        input.len() as u64
                    )
                );
                assert_eq!(
                    read(&mut source).await.unwrap(),
                    (
                        format!("sha256:{:x}", Sha256::digest(input.as_bytes())),
                        input.len() as u64
                    )
                );
            }
        }
    }

    #[tokio::test]
    async fn all_invalid_utf8_classes_are_rejected_at_any_read_boundary() {
        for invalid in [
            vec![0xff],
            vec![0xc0, 0xaf],
            vec![0xed, 0xa0, 0x80],
            vec![0xf4, 0x90, 0x80, 0x80],
            vec![0xe4, 0xb8],
            vec![0xf0, b'x'],
        ] {
            for limit in [1, 2, 3, READ_WINDOW_BYTES] {
                let mut bytes = vec![b'a'; READ_WINDOW_BYTES - 1];
                bytes.extend_from_slice(&invalid);
                assert!(std::str::from_utf8(&bytes).is_err());
                assert_eq!(
                    read_sync(&mut std::io::Cursor::new(&bytes))
                        .unwrap_err()
                        .to_string(),
                    "workspace file is not valid UTF-8"
                );
                let mut source = observed(bytes, limit);
                assert_eq!(
                    read(&mut source).await.unwrap_err().to_string(),
                    "workspace file is not valid UTF-8"
                );
            }
        }
    }

    #[tokio::test]
    async fn read_errors_are_not_converted_to_successful_revisions() {
        struct Failed;
        impl AsyncRead for Failed {
            fn poll_read(
                self: Pin<&mut Self>,
                _: &mut TaskContext<'_>,
                _: &mut ReadBuf<'_>,
            ) -> Poll<std::io::Result<()>> {
                Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "owned read failure",
                )))
            }
        }
        let error = read(&mut Failed).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().kind(),
            std::io::ErrorKind::PermissionDenied
        );
    }

    #[tokio::test]
    async fn dropping_a_pending_validation_does_not_leave_a_background_reader() {
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        struct Pending(Arc<AtomicUsize>);
        impl AsyncRead for Pending {
            fn poll_read(
                self: Pin<&mut Self>,
                _: &mut TaskContext<'_>,
                _: &mut ReadBuf<'_>,
            ) -> Poll<std::io::Result<()>> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Poll::Pending
            }
        }
        let polls = Arc::new(AtomicUsize::new(0));
        let mut source = Pending(polls.clone());
        let mut validation = Box::pin(read(&mut source));
        assert!(futures::poll!(validation.as_mut()).is_pending());
        drop(validation);
        tokio::task::yield_now().await;
        assert_eq!(polls.load(Ordering::SeqCst), 1);
    }
}
