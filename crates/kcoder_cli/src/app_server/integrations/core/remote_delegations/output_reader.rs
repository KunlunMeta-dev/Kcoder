//! Full native result pagination under the original operation deadline and owner.
use super::*;
use kcoder_office_worker::read_worker::{OfficeReadHeader, OfficeReadWorker};
use tokio_util::sync::CancellationToken;

pub async fn read_all(
    worker: &OfficeReadWorker,
    mut header: OfficeReadHeader,
    bytes: &[u8],
    deadline: tokio::time::Instant,
    cancel: &CancellationToken,
    mut verify: impl FnMut() -> Result<()> + Send,
) -> Result<Value> {
    let mut chunks = Vec::new();
    let mut text_bytes = 0usize;
    let mut cursors = std::collections::BTreeSet::new();
    for _ in 0..1024 {
        verify()?;
        ensure!(!cancel.is_cancelled(), "REMOTE_RESULT_READER_CANCELLED");
        let timeout = deadline
            .saturating_duration_since(tokio::time::Instant::now())
            .as_millis()
            .min(60_000) as u64;
        ensure!(timeout > 0, "REMOTE_NATIVE_DEADLINE_EXPIRED");
        let pending = worker.read(header.clone(), bytes.to_vec(), timeout, cancel);
        tokio::pin!(pending);
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_millis(250));
        let page = loop {
            tokio::select! { biased;
                _ = heartbeat.tick() => if let Err(error) = verify() {
                    cancel.cancel();
                    let _ = pending.as_mut().await;
                    return Err(error);
                },
                page = &mut pending => break page?,
            }
        };
        ensure!(
            page["sha256"] == header.sha256
                && page["reference"]["id"] == header.reference.id
                && page["reference"]["revision"] == header.reference.revision
                && page["untrustedSourceData"] == true,
            "REMOTE_RESULT_READER_IDENTITY_CHANGED"
        );
        for row in page["chunks"]
            .as_array()
            .context("REMOTE_RESULT_READER_SHAPE")?
        {
            ensure!(
                row["index"].as_u64() == Some(chunks.len() as u64),
                "REMOTE_RESULT_READER_SEQUENCE_CHANGED"
            );
            text_bytes = text_bytes
                .checked_add(
                    row["text"]
                        .as_str()
                        .context("REMOTE_RESULT_READER_SHAPE")?
                        .len(),
                )
                .context("REMOTE_RESULT_READER_CONTEXT_LIMIT")?;
            ensure!(
                text_bytes <= 2 * 1024 * 1024,
                "REMOTE_RESULT_READER_CONTEXT_LIMIT"
            );
            chunks.push(row.clone());
        }
        if page["complete"] == true {
            ensure!(
                page["nextCursor"].is_null() && page["omittedChunks"] == 0,
                "REMOTE_RESULT_READER_INCOMPLETE"
            );
            verify()?;
            let mut result = page;
            result["chunks"] = Value::Array(chunks);
            return Ok(result);
        }
        let next = page["nextCursor"]
            .as_str()
            .context("REMOTE_RESULT_READER_SHAPE")?
            .to_owned();
        ensure!(
            cursors.insert(next.clone()),
            "REMOTE_RESULT_READER_CURSOR_REPEATED"
        );
        header.cursor = Some(next);
    }
    anyhow::bail!("REMOTE_RESULT_READER_INCOMPLETE")
}
