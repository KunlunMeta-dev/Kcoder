//! Portable Wiki transfers reuse connection-owned attachment staging and bounded frames.
use super::*;
use base64::Engine as _;
use kcoder_app_protocol::{
    KnowledgeAttachmentDigestParams, KnowledgeExportReadParams, KnowledgeImportArchiveParams,
    KnowledgeMarkdownImportParams, KnowledgeReadParams,
};
use std::io::{Read, Seek, SeekFrom};

pub(super) fn supports(method: &str) -> bool {
    matches!(
        method,
        kcoder_app_protocol::knowledge_method::ORIGINAL_EXPORT
            | kcoder_app_protocol::knowledge_method::ATTACHMENT_DIGEST
            | kcoder_app_protocol::knowledge_method::MARKDOWN_EXPORT
            | kcoder_app_protocol::knowledge_method::MARKDOWN_IMPORT
            | kcoder_app_protocol::knowledge_method::EXPORT
            | kcoder_app_protocol::knowledge_method::IMPORT_ARCHIVE
            | kcoder_app_protocol::knowledge_method::EXPORT_READ
    )
}
pub(super) fn request(
    method: &str,
    params: Value,
    settings: &std::path::Path,
    session: &str,
    attachments: &mut AttachmentDirectories,
) -> Result<Value> {
    use kcoder_app_protocol::knowledge_method as km;
    anyhow::ensure!(knowledge_requests::enabled(settings)?, "Wiki is disabled");
    if matches!(method, km::IMPORT_ARCHIVE | km::MARKDOWN_IMPORT) {
        anyhow::ensure!(
            knowledge_requests::organization_enabled(settings)?,
            "Wiki organization is disabled"
        );
    }
    if method == km::ATTACHMENT_DIGEST {
        use sha2::{Digest, Sha256};
        let input: KnowledgeAttachmentDigestParams = serde_json::from_value(params)?;
        let path = PathBuf::from(&input.attachment_path);
        anyhow::ensure!(
            attachments.contains(&path),
            "upload is not owned by this connection"
        );
        anyhow::ensure!(input.title.len() <= 4096, "invalid title");
        let file = std::fs::File::open(path)?;
        anyhow::ensure!(
            file.metadata()?.len() <= 64 * 1024 * 1024,
            "upload exceeds 64 MiB"
        );
        let mut reader = file.take(64 * 1024 * 1024 + 1);
        let mut hasher = Sha256::new();
        let mut total = 0usize;
        loop {
            let mut buffer = [0; 64 * 1024];
            let count = reader.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total += count;
            anyhow::ensure!(total <= 64 * 1024 * 1024, "upload exceeds 64 MiB");
            hasher.update(&buffer[..count]);
        }
        let raw = format!("{:x}", hasher.finalize());
        let key = format!(
            "{:x}",
            Sha256::digest(format!("{}\0{raw}", input.title).as_bytes())
        );
        return Ok(json!({"key":key}));
    }
    if method == km::EXPORT_READ {
        let input: KnowledgeExportReadParams = serde_json::from_value(params)?;
        let path = PathBuf::from(&input.attachment_path);
        anyhow::ensure!(
            attachments.contains(&path),
            "export is not owned by this connection"
        );
        let mut file = std::fs::File::open(path)?;
        let size = file.metadata()?.len();
        anyhow::ensure!(
            size <= 64 * 1024 * 1024 && input.offset <= size,
            "invalid export read range"
        );
        file.seek(SeekFrom::Start(input.offset))?;
        let mut bytes = Vec::new();
        file.take(192 * 1024).read_to_end(&mut bytes)?;
        return Ok(
            json!({"contentBase64":base64::engine::general_purpose::STANDARD.encode(&bytes),"nextOffset":input.offset + bytes.len() as u64,"size":size,"eof":input.offset + bytes.len() as u64 == size}),
        );
    }
    let (mut store, scope) = knowledge_requests::open_catalog(settings)?;
    if method == km::ORIGINAL_EXPORT {
        let input: kcoder_app_protocol::KnowledgeOriginalExportParams =
            serde_json::from_value(params)?;
        let (filename, format, bytes) = store.original_source(
            &scope,
            &input.library_id,
            &input.source_id,
            &input.revision_id,
        )?;
        let mime = match format.as_str() {
            "pdf" => "application/pdf",
            "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "markdown" => "text/markdown",
            "html" => "text/html",
            "text" => "text/plain",
            "image" if bytes.starts_with(b"\x89PNG") => "image/png",
            "image" if bytes.starts_with(b"\xff\xd8") => "image/jpeg",
            "image" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
                "image/webp"
            }
            _ => "application/octet-stream",
        };
        let result = stage_export(session, attachments, &bytes)?;
        return Ok(serde_json::to_value(
            kcoder_app_protocol::KnowledgeOriginalExportResult {
                path: PathBuf::from(result["path"].as_str().context("export path missing")?),
                size: bytes.len() as u64,
                filename,
                mime_type: mime.into(),
            },
        )?);
    }
    if method == km::MARKDOWN_IMPORT {
        let input: KnowledgeMarkdownImportParams = serde_json::from_value(params)?;
        let path = PathBuf::from(&input.attachment_path);
        anyhow::ensure!(
            attachments.contains(&path),
            "Markdown bundle was not staged by this connection"
        );
        let file = std::fs::File::open(&path)?;
        anyhow::ensure!(
            file.metadata()?.len() <= 16 * 1024 * 1024,
            "Markdown bundle exceeds 16 MiB"
        );
        let mut bytes = Vec::new();
        file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        return Ok(serde_json::to_value(store.import_markdown_bundle(
            &scope,
            &input.library_id,
            &input.idempotency_key,
            &bytes,
        )?)?);
    }

    if method == km::IMPORT_ARCHIVE {
        let input: KnowledgeImportArchiveParams = serde_json::from_value(params)?;
        let path = PathBuf::from(&input.attachment_path);
        anyhow::ensure!(
            attachments.contains(&path),
            "snapshot was not staged by this connection"
        );
        let file = std::fs::File::open(&path)?;
        anyhow::ensure!(
            file.metadata()?.len() <= 64 * 1024 * 1024,
            "Wiki snapshot exceeds 64 MiB"
        );
        let mut bytes = Vec::new();
        file.take(64 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        return Ok(serde_json::to_value(store.import_archive(
            &scope,
            &input.idempotency_key,
            &bytes,
        )?)?);
    }
    let input: KnowledgeReadParams = serde_json::from_value(params)?;
    let bytes = if method == km::MARKDOWN_EXPORT {
        store.export_markdown_bundle(&scope, &input.library_id)?
    } else {
        store.export_archive(&scope, &input.library_id)?
    };
    stage_export(session, attachments, &bytes)
}

fn stage_export(
    session: &str,
    attachments: &mut AttachmentDirectories,
    bytes: &[u8],
) -> Result<Value> {
    let upload = attachment_upload_start(
        session,
        &AttachmentUploadStartParams {
            filename: "wiki.kwiki".into(),
            size: bytes.len() as u64,
        },
        attachments,
    )?;
    let result = (|| -> Result<Value> {
        for (index, chunk) in bytes.chunks(192 * 1024).enumerate() {
            attachment_upload_chunk(
                &AttachmentUploadChunkParams {
                    upload_id: upload.upload_id.clone(),
                    index: index as u32,
                    content_base64: base64::engine::general_purpose::STANDARD.encode(chunk),
                },
                attachments,
            )?;
        }
        let file = attachment_upload_finish(
            &AttachmentUploadFinishParams {
                upload_id: upload.upload_id.clone(),
            },
            attachments,
        )?;
        Ok(json!({"path":file.path,"size":bytes.len()}))
    })();
    if result.is_err() {
        let _ = attachment_upload_cancel(&upload.upload_id, attachments);
    }
    result
}
