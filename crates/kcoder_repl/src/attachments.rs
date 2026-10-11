use anyhow::{Context, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use kcoder_types::{ContentBlock, ImageSource, Message};
use std::path::{Path, PathBuf};

use crate::clipboard_image::ClipboardImage;

pub(crate) const MAX_IMAGE_ATTACHMENTS: usize = 8;
pub(crate) const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalImageAttachment {
    pub(crate) path: PathBuf,
    pub(crate) placeholder: String,
    pub(crate) media_type: String,
    pub(crate) clipboard_image: Option<ClipboardImage>,
}

#[derive(Debug, Clone)]
pub(crate) struct SubmittedMessage {
    pub(crate) visible_text: String,
    pub(crate) text: String,
    pub(crate) images: Vec<LocalImageAttachment>,
    pub(crate) remote_image_urls: Vec<String>,
    pub(crate) pending_pastes: Vec<(String, String)>,
}

impl SubmittedMessage {
    pub(crate) fn text(text: String) -> Self {
        Self {
            visible_text: text.clone(),
            text,
            images: Vec::new(),
            remote_image_urls: Vec::new(),
            pending_pastes: Vec::new(),
        }
    }

    pub(crate) fn text_with_visible(visible_text: String, text: String) -> Self {
        Self {
            visible_text,
            text,
            images: Vec::new(),
            remote_image_urls: Vec::new(),
            pending_pastes: Vec::new(),
        }
    }

    pub(crate) fn to_model_message(&self, text: String) -> Result<Message> {
        let mut content = Vec::new();
        if !text.is_empty() {
            content.push(ContentBlock::Text { text: text.clone() });
        }

        for image in self
            .images
            .iter()
            .filter(|image| text.contains(&image.placeholder))
        {
            let bytes = std::fs::read(&image.path)
                .with_context(|| format!("failed to read image {}", image.path.display()))?;
            if bytes.len() as u64 > MAX_IMAGE_BYTES {
                anyhow::bail!(
                    "image {} is larger than {} MB",
                    image.path.display(),
                    MAX_IMAGE_BYTES / 1024 / 1024
                );
            }
            content.push(ContentBlock::Image {
                source: ImageSource::base64(
                    image.media_type.clone(),
                    BASE64_STANDARD.encode(bytes),
                ),
            });
        }

        if content.is_empty() {
            anyhow::bail!("submitted message is empty");
        }
        Ok(Message::user_content(content))
    }
}

pub(crate) fn pasted_image_path(pasted: &str, cwd: &Path) -> Option<PathBuf> {
    let trimmed = pasted.trim();
    if trimmed.is_empty() || trimmed.lines().count() != 1 {
        return None;
    }
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| {
            trimmed
                .strip_prefix('\'')
                .and_then(|s| s.strip_suffix('\''))
        })
        .or_else(|| trimmed.strip_prefix('`').and_then(|s| s.strip_suffix('`')))
        .unwrap_or(trimmed);
    let path_text = unquoted.strip_prefix("file://").unwrap_or(unquoted);
    if path_text.is_empty() {
        return None;
    }
    let path = PathBuf::from(path_text);
    Some(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}

pub(crate) fn image_media_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}
