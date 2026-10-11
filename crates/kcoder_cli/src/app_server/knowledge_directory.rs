//! Explicit UI directory selection is copied into the existing connection-owned upload boundary.
use super::*;
use anyhow::ensure;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

#[cfg(test)]
pub(super) fn stage(
    settings: &Path,
    directory: &Path,
    session: &str,
    attachments: &mut AttachmentDirectories,
) -> Result<Value> {
    stage_selected(settings, directory, session, attachments, None)
}

pub(super) fn preview(settings: &Path, directory: &Path) -> Result<Value> {
    ensure!(
        knowledge_requests::organization_enabled(settings)?,
        "Wiki organization is disabled"
    );
    let runtime_capabilities = kcoder_tools::wiki_document::runtime_file_capabilities();
    let runtime_available = |title: &str| {
        kcoder_tools::wiki_document::file_capability(title)
            .and_then(|declared| {
                runtime_capabilities
                    .iter()
                    .find(|item| item.format == declared.format)
            })
            .is_some_and(|item| item.available != Some(false))
    };
    let handle = kcoder_config::PrivateDirectory::open_existing(directory)?;
    let mut items = Vec::new();
    for (index, entry) in std::fs::read_dir(directory)?.enumerate() {
        ensure!(
            index < 1000,
            "Directory has too many entries; choose a smaller folder"
        );
        let entry = entry?;
        let name = entry.file_name();
        let Some(title) = name.to_str() else {
            continue;
        };
        if title.starts_with('.') || !entry.file_type()?.is_file() {
            continue;
        }
        let file = handle.open_regular_file(&name)?;
        let size = file.metadata()?.len();
        items.push(kcoder_app_protocol::KnowledgeDirectoryPreviewEntry {
            title: title.into(),
            size,
            available: runtime_available(title)
                && file_limit(title).is_some_and(|limit| size <= limit),
        });
    }
    items.sort_by(|a, b| a.title.cmp(&b.title));
    ensure!(
        !items.is_empty(),
        "No supported documents or images in this folder"
    );
    Ok(serde_json::to_value(
        kcoder_app_protocol::KnowledgeDirectoryPreviewResult { items },
    )?)
}

fn file_limit(title: &str) -> Option<u64> {
    kcoder_tools::wiki_document::file_capability(title)
        .map(|capability| capability.max_file_bytes as u64)
}

pub(super) fn stage_selected(
    settings: &Path,
    directory: &Path,
    session: &str,
    attachments: &mut AttachmentDirectories,
    selected: Option<&[String]>,
) -> Result<Value> {
    if let Some(names) = selected {
        ensure!(!names.is_empty() && names.len() <= 10, "Select 1..10 files");
        let unique = names.iter().collect::<std::collections::BTreeSet<_>>();
        ensure!(
            unique.len() == names.len()
                && names.iter().all(|name| !name.is_empty()
                    && !name.starts_with('.')
                    && !name.contains(['/', '\\', ':'])),
            "Select distinct supported leaf filenames"
        );
    }
    ensure!(
        knowledge_requests::organization_enabled(settings)?,
        "Wiki organization is disabled"
    );
    let runtime_capabilities = kcoder_tools::wiki_document::runtime_file_capabilities();
    let runtime_available = |title: &str| {
        kcoder_tools::wiki_document::file_capability(title)
            .and_then(|declared| {
                runtime_capabilities
                    .iter()
                    .find(|item| item.format == declared.format)
            })
            .is_some_and(|item| item.available != Some(false))
    };
    let handle = kcoder_config::PrivateDirectory::open_existing(directory)?;
    let mut files = Vec::new();
    let mut total = 0usize;
    for (index, entry) in std::fs::read_dir(directory)?.enumerate() {
        ensure!(
            index < 1000,
            "Directory has too many entries; choose a smaller folder"
        );
        let entry = entry?;
        let name = entry.file_name();
        let Some(title) = name.to_str() else {
            continue;
        };
        if title.starts_with('.') || !entry.file_type()?.is_file() {
            continue;
        }
        if selected.is_some_and(|names| !names.iter().any(|name| name == title)) {
            continue;
        }
        if file_limit(title).is_none() {
            continue;
        }
        ensure!(
            runtime_available(title),
            "PDF text reader unavailable on execution target; reinstall full Studio or install Poppler pdftotext. OCR is not performed"
        );
        ensure!(
            files.len() < 10,
            "Directory exceeds 10 supported files; select a smaller folder"
        );
        // The directory handle, not a concatenated path, authorizes this leaf.
        let file = handle.open_regular_file(&name)?;
        ensure!(
            file.metadata()?.len() <= file_limit(title).unwrap(),
            "Source exceeds its document/image size limit"
        );
        let mut bytes = Vec::new();
        file.take(file_limit(title).unwrap() + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= file_limit(title).unwrap(),
            "Source exceeds its document/image size limit"
        );
        total += bytes.len();
        ensure!(
            total <= 128 * 1024 * 1024,
            "Directory batch exceeds 128 MiB"
        );
        files.push((title.to_owned(), bytes));
    }
    if let Some(names) = selected {
        ensure!(
            files.len() == names.len(),
            "A selected file changed, disappeared or is unsupported; preview again"
        );
    }
    ensure!(
        !files.is_empty(),
        "No supported text, PDF, Office (.docx/.xlsx/.pptx) or image files in this folder"
    );
    let mut staged_paths = Vec::new();
    let result = (|| -> Result<Value> {
        let mut items = Vec::new();
        for (title, bytes) in files {
            let upload = attachment_upload_start(
                session,
                &AttachmentUploadStartParams {
                    retention: None,
                    filename: title.clone(),
                    size: bytes.len() as u64,
                },
                attachments,
            )?;
            let saved = (|| -> Result<_> {
                for (index, chunk) in bytes.chunks(192 * 1024).enumerate() {
                    attachment_upload_chunk(
                        &AttachmentUploadChunkParams {
                            retention: None,
                            upload_id: upload.upload_id.clone(),
                            index: index as u32,
                            content_base64: base64::engine::general_purpose::STANDARD.encode(chunk),
                        },
                        attachments,
                    )?;
                }
                attachment_upload_finish(
                    &AttachmentUploadFinishParams {
                        retention: None,
                        upload_id: upload.upload_id.clone(),
                    },
                    attachments,
                )
            })();
            let saved = match saved {
                Ok(saved) => saved,
                Err(error) => {
                    let _ = attachment_upload_cancel(&upload.upload_id, attachments);
                    return Err(error);
                }
            };
            staged_paths.push(PathBuf::from(&saved.path));
            let mut hash = Sha256::new();
            hash.update(title.as_bytes());
            hash.update([0]);
            hash.update(&bytes);
            items.push(json!({"title":title,"size":bytes.len(),"attachmentPath":saved.path,"idempotencyKey":format!("directory:{:x}",hash.finalize())}));
        }
        Ok(json!({"items":items,"totalBytes":total}))
    })();
    if result.is_err() {
        for path in staged_paths {
            let _ = attachments.consume(&path);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_preview_and_stage_share_image_and_document_byte_limits() -> Result<()> {
        let root = tempfile::tempdir()?;
        let settings = root.path().join("settings.json");
        std::fs::write(&settings, r#"{"knowledge":{"organization_enabled":true}}"#)?;
        let source = root.path().join("source");
        std::fs::create_dir(&source)?;
        for (name, size) in [
            ("中文.PNG", 10 * 1024 * 1024 + 1),
            ("文档.PDF", 32 * 1024 * 1024 + 1),
        ] {
            std::fs::File::create(source.join(name))?.set_len(size)?;
        }
        let preview = preview(&settings, &source)?;
        assert!(
            preview["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["available"] == false)
        );
        let mut attachments = AttachmentDirectories::default();
        for name in ["中文.PNG", "文档.PDF"] {
            assert!(
                stage_selected(
                    &settings,
                    &source,
                    "limits",
                    &mut attachments,
                    Some(&[name.into()])
                )
                .is_err()
            );
        }
        std::fs::write(source.join("legacy.doc"), b"not a supported container")?;
        let preview = super::preview(&settings, &source)?;
        assert!(
            preview["items"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["title"] == "legacy.doc" && item["available"] == false)
        );
        assert!(
            stage_selected(
                &settings,
                &source,
                "limits",
                &mut attachments,
                Some(&["legacy.doc".into()])
            )
            .is_err()
        );
        assert_eq!(file_limit("中文.PNG"), Some(10 * 1024 * 1024));
        assert_eq!(file_limit("文档.PDF"), Some(32 * 1024 * 1024));
        Ok(())
    }

    #[test]
    fn directory_import_stages_only_explicit_regular_sources_and_obeys_switch() -> Result<()> {
        let root = tempfile::tempdir()?;
        let settings = root.path().join("settings.json");
        std::fs::write(&settings, r#"{"knowledge":{"organization_enabled":true}}"#)?;
        let source = root.path().join("source");
        std::fs::create_dir(&source)?;
        std::fs::write(source.join("readme.md"), "Source evidence")?;
        std::fs::write(source.join(".hidden.md"), "Hidden")?;
        std::fs::write(source.join("ignored.bin"), "Other")?;
        let mut attachments = AttachmentDirectories::default();
        let result = stage(&settings, &source, "wiki-directory-test", &mut attachments)?;
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        let path = PathBuf::from(result["items"][0]["attachmentPath"].as_str().unwrap());
        assert!(attachments.contains(&path));
        assert_eq!(std::fs::read_to_string(&path)?, "Source evidence");
        std::fs::write(source.join("readme.md"), "Changed after preview")?;
        assert_eq!(std::fs::read_to_string(path)?, "Source evidence");
        std::fs::write(&settings, r#"{"knowledge":{"retrieval_enabled":true}}"#)?;
        assert!(stage(&settings, &source, "wiki-directory-test", &mut attachments).is_err());
        Ok(())
    }
}
