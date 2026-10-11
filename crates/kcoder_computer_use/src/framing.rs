//! Length-prefixed local broker frames. Reject an invalid length before allocating
//! its payload; callers close that connection on framing errors.
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_REPLY_BYTES: usize = 2 * 1024 * 1024;

/// Keeps partial input across cancellation of an individual request. Each read
/// await is cancellation-safe; header/body offsets remain owned by this reader.
pub struct FrameReader {
    header: [u8; 4],
    header_read: usize,
    body: Vec<u8>,
    body_read: usize,
    limit: usize,
    invalid: bool,
}
impl FrameReader {
    pub fn new(limit: usize) -> Self {
        Self {
            header: [0; 4],
            header_read: 0,
            body: Vec::new(),
            body_read: 0,
            limit,
            invalid: false,
        }
    }
    pub async fn read<R: AsyncRead + Unpin>(&mut self, input: &mut R) -> io::Result<Vec<u8>> {
        if self.invalid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid desktop frame length",
            ));
        }
        while self.header_read < 4 {
            let count = input.read(&mut self.header[self.header_read..]).await?;
            if count == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            self.header_read += count;
        }
        if self.body.is_empty() {
            let size = u32::from_be_bytes(self.header) as usize;
            if size == 0 || size > self.limit {
                self.invalid = true;
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid desktop frame length",
                ));
            }
            self.body.resize(size, 0);
        }
        while self.body_read < self.body.len() {
            let count = input.read(&mut self.body[self.body_read..]).await?;
            if count == 0 {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            self.body_read += count;
        }
        self.header_read = 0;
        self.body_read = 0;
        Ok(std::mem::take(&mut self.body))
    }
}

pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R, limit: usize) -> io::Result<Vec<u8>> {
    let size = reader.read_u32().await? as usize;
    if size == 0 || size > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid desktop frame length",
        ));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).await?;
    Ok(bytes)
}

pub async fn write_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
    limit: usize,
) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > limit || bytes.len() > u32::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid desktop frame length",
        ));
    }
    writer.write_u32(bytes.len() as u32).await?;
    writer.write_all(bytes).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn request_cancellation_preserves_partial_header_and_payload() {
        let (mut sender, mut receiver) = tokio::io::duplex(16);
        let mut reader = FrameReader::new(32);
        sender.write_all(&[0, 0]).await.unwrap();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(2),
                reader.read(&mut receiver)
            )
            .await
            .is_err()
        );
        sender.write_all(&[0, 5, b'h', b'e']).await.unwrap();
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(2),
                reader.read(&mut receiver)
            )
            .await
            .is_err()
        );
        sender.write_all(b"llo\0\0\0\x04next").await.unwrap();
        assert_eq!(reader.read(&mut receiver).await.unwrap(), b"hello");
        assert_eq!(reader.read(&mut receiver).await.unwrap(), b"next");
    }
    #[tokio::test]
    async fn preserves_fragmented_and_adjacent_frames() {
        let (mut sender, mut receiver) = tokio::io::duplex(2);
        let task = tokio::spawn(async move {
            write_frame(&mut sender, b"one", 32).await.unwrap();
            write_frame(&mut sender, b"two", 32).await.unwrap();
        });
        assert_eq!(read_frame(&mut receiver, 32).await.unwrap(), b"one");
        assert_eq!(read_frame(&mut receiver, 32).await.unwrap(), b"two");
        task.await.unwrap();
    }
    #[tokio::test]
    async fn rejects_lengths_before_payload_and_reports_truncated_input() {
        for size in [0u32, 33, u32::MAX] {
            let header = size.to_be_bytes();
            let mut input = &header[..];
            assert_eq!(
                read_frame(&mut input, 32).await.unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        }
        let mut input = &b"\0\0\0\x05xx"[..];
        assert_eq!(
            read_frame(&mut input, 32).await.unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
        let mut out = Vec::new();
        assert!(write_frame(&mut out, b"oversized", 4).await.is_err());
        assert!(out.is_empty());
    }
}
