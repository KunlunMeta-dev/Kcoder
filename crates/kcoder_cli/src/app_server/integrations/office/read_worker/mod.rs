//! Owned pure-bytes document extraction. This entry never loads user configuration.
#[path = "fonts.rs"]
mod fonts;
#[path = "process.rs"]
mod process;
use anyhow::{Context, Result, ensure};
use kcoder_tools::{
    ToolContext,
    wiki_document::{MAX_DOCUMENT_BYTES, extract_document_report, format_for_file},
};
use kcoder_types::integrations::office::OfficeArtifactRef;
pub use process::OfficeReadWorker;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{BufRead, Read, Write};

pub const READ_WORKER_FLAG: &str = "--internal-office-read-worker";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfficeReadHeader {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    pub reference: OfficeArtifactRef,
    pub filename: String,
    pub byte_length: u64,
    pub sha256: String,
    pub scope_sha256: String,
    #[serde(default)]
    pub cursor: Option<String>,
    pub limit: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    version: u32,
    input_id: String,
    revision: u64,
    sha256: String,
    scope_sha256: String,
    index: usize,
}
impl OfficeReadHeader {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.schema_version == 1
                && !self.reference.id.is_empty()
                && self.reference.id.chars().count() <= 256
                && self.reference.revision == 1
                && self.byte_length <= MAX_DOCUMENT_BYTES as u64
                && (1..=4).contains(&self.limit)
                && self.filename.chars().count() <= 200
                && !self.filename.is_empty()
                && !self.filename.chars().any(char::is_control)
                && self.sha256.len() == 64
                && self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                && self.scope_sha256.len() == 64
                && self
                    .scope_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit())
                && self
                    .cursor
                    .as_ref()
                    .is_none_or(|cursor| cursor.len() <= 2048),
            "OFFICE_INVALID_INPUT"
        );
        Ok(())
    }
}

/// Synchronous pre-bootstrap CLI entry. Stdout is exactly one bounded JSON reply;
/// all errors and nonzero exits contain only the static OFFICE_READ_FAILED code.
pub fn run_read_worker() -> Result<()> {
    let result = (|| -> Result<Value> {
        let stdin = std::io::stdin();
        let mut reader = std::io::BufReader::new(stdin.lock());
        let mut header = Vec::new();
        std::io::Read::by_ref(&mut reader)
            .take(16 * 1024 + 1)
            .read_until(b'\n', &mut header)?;
        ensure!(
            header.len() <= 16 * 1024 && header.last() == Some(&b'\n'),
            "OFFICE_INVALID_INPUT"
        );
        let header: OfficeReadHeader = serde_json::from_slice(&header)?;
        header.validate()?;
        let mut bytes = Vec::new();
        reader
            .take(header.byte_length + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == header.byte_length,
            "OFFICE_INPUT_SIZE_MISMATCH"
        );
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(extract(header, bytes, &std::env::current_dir()?))
    })();
    let ok = result.is_ok();
    let value = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(_) => json!({"ok":false,"error":{"code":"OFFICE_READ_FAILED"}}),
    };
    let stdout = std::io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, &value).context("OFFICE_READ_FAILED")?;
    output.write_all(b"\n").context("OFFICE_READ_FAILED")?;
    output.flush().context("OFFICE_READ_FAILED")?;
    ensure!(ok, "OFFICE_READ_FAILED");
    Ok(())
}
async fn extract(
    header: OfficeReadHeader,
    bytes: Vec<u8>,
    workspace: &std::path::Path,
) -> Result<Value> {
    if header.operation.as_deref() == Some("probe_fonts") {
        ensure!(bytes.is_empty(), "OFFICE_INVALID_INPUT");
        return fonts::probe().await;
    }
    ensure!(header.operation.is_none(), "OFFICE_INVALID_INPUT");
    let _verified_workspace = kcoder_config::PrivateDirectory::open_existing(workspace)?;
    header.validate()?;
    ensure!(
        bytes.len() as u64 == header.byte_length
            && format!("{:x}", Sha256::digest(&bytes)) == header.sha256.to_ascii_lowercase(),
        "OFFICE_INPUT_HASH_MISMATCH"
    );
    let offset = match &header.cursor {
        None => 0,
        Some(cursor) => {
            let cursor: Cursor = serde_json::from_str(cursor).context("OFFICE_INVALID_CURSOR")?;
            ensure!(
                cursor.version == 1
                    && cursor.input_id == header.reference.id
                    && cursor.revision == header.reference.revision
                    && cursor.sha256 == header.sha256
                    && cursor.scope_sha256 == header.scope_sha256,
                "OFFICE_STALE_CURSOR"
            );
            cursor.index
        }
    };
    let directory = tempfile::Builder::new()
        .prefix("extract-")
        .tempdir_in(workspace)?;
    let path = directory.path().join("source");
    std::fs::write(&path, &bytes)?;
    drop(bytes);
    let (format, capability) =
        format_for_file(&header.filename).map_err(|_| anyhow::anyhow!("OFFICE_READ_FAILED"))?;
    ensure!(capability.available != Some(false), "OFFICE_READ_FAILED");
    let context = ToolContext::new(kcoder_state::AppState::new(directory.path()));
    let extracted = extract_document_report(&path, format, &context)
        .await
        .map_err(|_| anyhow::anyhow!("OFFICE_READ_FAILED"))?;
    ensure!(offset <= extracted.chunks.len(), "OFFICE_INVALID_CURSOR");
    let mut chunks = Vec::new();
    let mut end = offset;
    for (index, chunk) in extracted
        .chunks
        .iter()
        .enumerate()
        .skip(offset)
        .take(header.limit)
    {
        let value = json!({"index":index,"text":chunk.text,"page":chunk.page,"byteRange":{"start":chunk.byte_range.start,"end":chunk.byte_range.end}});
        let mut candidate = chunks.clone();
        candidate.push(value.clone());
        if serde_json::to_vec(&candidate)?.len() > 48 * 1024 {
            break;
        }
        chunks.push(value);
        end = index + 1;
    }
    ensure!(
        end > offset || offset == extracted.chunks.len(),
        "OFFICE_READ_REPLY_TOO_LARGE"
    );
    let complete = end == extracted.chunks.len();
    let next_cursor = if complete {
        None
    } else {
        Some(serde_json::to_string(&Cursor {
            version: 1,
            input_id: header.reference.id.clone(),
            revision: header.reference.revision,
            sha256: header.sha256.clone(),
            scope_sha256: header.scope_sha256.clone(),
            index: end,
        })?)
    };
    let value = json!({"reference":header.reference,"sha256":header.sha256,"report":extracted.report,"chunks":chunks,"nextCursor":next_cursor,"complete":complete,"omittedChunks":extracted.chunks.len()-end,"untrustedSourceData":true,"ocrPerformed":false});
    ensure!(
        serde_json::to_vec(&value)?.len() <= 64 * 1024,
        "OFFICE_READ_REPLY_TOO_LARGE"
    );
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn extraction_reads_actual_literal_material_and_rejects_corrupt_identity() {
        let bytes = "会议决议：试点项目A。金额1234.56元；日期和责任人待确认。\n"
            .as_bytes()
            .to_vec();
        let header = OfficeReadHeader {
            schema_version: 1,
            operation: None,
            reference: OfficeArtifactRef {
                id: "actual-input".into(),
                revision: 1,
            },
            filename: "material.txt".into(),
            byte_length: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            scope_sha256: "a".repeat(64),
            cursor: None,
            limit: 2,
        };
        let workspace = tempfile::tempdir().unwrap();
        let value = extract(header.clone(), bytes.clone(), workspace.path())
            .await
            .unwrap();
        assert!(
            value["chunks"][0]["text"]
                .as_str()
                .unwrap()
                .contains("1234.56")
        );
        assert_eq!(value["ocrPerformed"], false);
        assert!(value.get("path").is_none());
        let mut bad = header;
        bad.sha256 = "f".repeat(64);
        assert!(extract(bad, bytes, workspace.path()).await.is_err());
    }
}
