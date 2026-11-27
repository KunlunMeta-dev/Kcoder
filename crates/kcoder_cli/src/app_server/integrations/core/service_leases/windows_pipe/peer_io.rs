//! One bounded peer frame. Retrying a remaining pipe chunk never replays an operation.
use super::*;

impl ServicePipe {
    pub(super) fn read_peer_source(
        &mut self,
        budget: Duration,
        maximum: usize,
    ) -> Result<serde_json::Value> {
        let until = Instant::now() + budget;
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 16384];
        loop {
            self.verify()?;
            ensure!(
                Instant::now() < until,
                "PEER_SOURCE_WINDOWS_PIPE_REPLY_UNCONFIRMED"
            );
            let mut count = 0;
            let ok = unsafe {
                ReadFile(
                    self.file.as_raw_handle().cast(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    &mut count,
                    std::ptr::null_mut(),
                )
            };
            if ok == 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_DATA as i32) {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                anyhow::bail!("PEER_SOURCE_WINDOWS_PIPE_REPLY_UNCONFIRMED");
            }
            ensure!(count > 0, "PEER_SOURCE_WINDOWS_PIPE_REPLY_UNCONFIRMED");
            bytes.extend_from_slice(&buffer[..count as usize]);
            if let Some(end) = bytes.iter().position(|b| *b == b'\n') {
                ensure!(
                    end < maximum && end + 1 == bytes.len(),
                    "PEER_SOURCE_WINDOWS_PIPE_FRAME_INVALID"
                );
                self.verify()?;
                return serde_json::from_slice(&bytes[..end])
                    .context("PEER_SOURCE_WINDOWS_PIPE_FRAME_INVALID");
            }
            ensure!(
                bytes.len() < maximum,
                "PEER_SOURCE_WINDOWS_PIPE_FRAME_TOO_LARGE"
            );
        }
    }
    pub(super) fn write_peer_source(&mut self, bytes: &[u8]) -> Result<()> {
        let until = Instant::now() + Duration::from_secs(5);
        let mut offset = 0;
        while offset < bytes.len() {
            self.verify()?;
            ensure!(
                Instant::now() < until,
                "PEER_SOURCE_WINDOWS_PIPE_WRITE_UNCONFIRMED"
            );
            let end = bytes.len().min(offset + 16384);
            match self.file.write(&bytes[offset..end]) {
                Ok(0) => std::thread::sleep(Duration::from_millis(5)),
                Ok(n) => offset += n,
                Err(e)
                    if e.raw_os_error() == Some(ERROR_NO_DATA as i32)
                        || e.kind() == std::io::ErrorKind::WouldBlock =>
                {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(_) => anyhow::bail!("PEER_SOURCE_WINDOWS_PIPE_WRITE_UNCONFIRMED"),
            }
        }
        self.verify()
    }
}
