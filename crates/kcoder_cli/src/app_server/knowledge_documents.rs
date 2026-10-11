//! Import only connection-owned uploads; extraction never accepts an arbitrary host path.
use super::{AttachmentDirectories, knowledge_requests};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::KnowledgeImportAttachmentParams;
use kcoder_knowledge::SourceChunk;
use kcoder_tools::{
    ToolContext,
    wiki_document::{extract_document_report, format_for_file},
};
use std::path::{Path, PathBuf};

pub(super) fn authorize(
    input: &KnowledgeImportAttachmentParams,
    attachments: &AttachmentDirectories,
) -> Result<PathBuf> {
    let path = PathBuf::from(&input.attachment_path);
    ensure!(
        attachments.contains(&path),
        "attachment was not staged by this connection"
    );
    Ok(path)
}

pub(super) async fn import(
    settings: &Path,
    input: KnowledgeImportAttachmentParams,
    path: PathBuf,
    ctx: ToolContext,
) -> Result<serde_json::Value> {
    ensure!(
        knowledge_requests::organization_enabled(settings)?,
        "Wiki organization is disabled"
    );
    let extension = Path::new(&input.title)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let (format, capability) = format_for_file(&input.title)?;
    let name = capability.format;
    ensure!(
        tokio::fs::metadata(&path).await?.len() <= capability.max_file_bytes as u64,
        "file_too_large: {} limit is {} MiB",
        name,
        capability.max_file_bytes / (1024 * 1024)
    );
    ensure!(
        input.source_id.is_some() == input.expected_revision.is_some(),
        "source update requires both sourceId and expectedRevision"
    );
    if name == "image" {
        let original = tokio::fs::read(&path).await?;
        return super::knowledge_image_imports::accept_and_run(
            settings, &input, &original, &extension, &ctx,
        )
        .await;
    }
    let document = extract_document_report(&path, format, &ctx).await?;
    let (chunks, extraction) = (document.chunks, serde_json::to_value(document.report)?);
    let original = tokio::fs::read(&path)
        .await
        .context("read authorized Wiki upload")?;
    ensure!(
        original.len() <= capability.max_file_bytes,
        "file_too_large"
    );
    ensure!(
        knowledge_requests::organization_enabled(settings)?,
        "Wiki was disabled during import"
    );
    let (mut store, scope) = knowledge_requests::open_catalog(settings)?;
    let mut line = 1;
    let mut previous_page = None;
    let chunks = chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            if chunk.page.is_some() && chunk.page != previous_page {
                line = 1;
            }
            previous_page = chunk.page;
            let first_line = line;
            line += chunk.text.bytes().filter(|byte| *byte == b'\n').count();
            SourceChunk {
                ordinal: index + 1,
                chunk_id: format!("chunk-{}", index + 1),
                first_line,
                last_line: line,
                text: chunk.text,
                page: chunk.page,
            }
        })
        .collect();
    let source = match (
        input.source_id.as_deref(),
        input.expected_revision.as_deref(),
    ) {
        (Some(source), Some(expected)) => store.update_source_with_report(
            &scope,
            &input.library_id,
            source,
            expected,
            &input.idempotency_key,
            &input.title,
            &original,
            name,
            chunks,
            &extraction,
        )?,
        (None, None) => store.import_extracted_with_report(
            &scope,
            &input.library_id,
            &input.idempotency_key,
            &input.title,
            &original,
            name,
            chunks,
            &extraction,
        )?,
        _ => anyhow::bail!("source update requires both sourceId and expectedRevision"),
    };
    let mut result = serde_json::to_value(source)?;
    result["extraction"] = extraction;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Model-independent boundary: oversized input is rejected before vision or extraction.
    #[tokio::test]
    async fn upload_and_replacement_reject_the_same_oversized_image_before_model_access()
    -> Result<()> {
        let root = tempfile::tempdir()?;
        let settings = root.path().join("settings.json");
        std::fs::write(&settings, r#"{"knowledge":{"organization_enabled":true}}"#)?;
        let path = root.path().join("oversized.png");
        std::fs::File::create(&path)?.set_len(kcoder_tools::image_input::MAX_BYTES as u64 + 1)?;
        let ctx = ToolContext::new(kcoder_state::AppState::new(root.path()));
        for replacement in [false, true] {
            let mut input = serde_json::json!({"libraryId":uuid::Uuid::new_v4().to_string(),"idempotencyKey":"size-test","title":"中文.PNG","attachmentPath":path});
            if replacement {
                input["sourceId"] = uuid::Uuid::new_v4().to_string().into();
                input["expectedRevision"] = uuid::Uuid::new_v4().to_string().into();
            }
            let error = import(
                &settings,
                serde_json::from_value(input)?,
                path.clone(),
                ctx.clone(),
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("file_too_large"));
        }
        Ok(())
    }
}
