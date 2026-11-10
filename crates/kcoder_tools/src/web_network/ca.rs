//! Bounded loading of target-owned CA files; certificate verification stays enabled.
use kcoder_tool_error::ToolError;
use std::path::{Path, PathBuf};
use tokio::io::AsyncReadExt;
const MAX_BYTES: usize = 4 * 1024 * 1024;

async fn pem(path: &Path, budget: usize) -> Result<(Vec<reqwest::Certificate>, usize), ToolError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| ToolError::Execution("The target web CA file could not be opened".into()))?;
    let mut bytes = Vec::new();
    file.take((budget + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| ToolError::Execution("The target web CA file could not be read".into()))?;
    if bytes.len() > budget {
        return Err(ToolError::Execution(
            "The target web CA file exceeds the size limit".into(),
        ));
    }
    let certificates = reqwest::Certificate::from_pem_bundle(&bytes)
        .map_err(|_| ToolError::Execution("The target web CA file is invalid".into()))?;
    if certificates.is_empty() {
        return Err(ToolError::Execution(
            "The target web CA file contains no certificates".into(),
        ));
    }
    Ok((certificates, bytes.len()))
}

pub async fn add(
    mut builder: reqwest::ClientBuilder,
    file: Option<&str>,
    directories: Option<&str>,
) -> Result<reqwest::ClientBuilder, ToolError> {
    let mut paths = Vec::<PathBuf>::new();
    if let Some(file) = file.filter(|v| !v.is_empty()) {
        paths.push(file.into());
    }
    if let Some(directories) = directories.filter(|v| !v.is_empty()) {
        for directory in std::env::split_paths(directories) {
            let mut entries = tokio::fs::read_dir(directory).await.map_err(|_| {
                ToolError::Execution("The target web CA directory is unavailable".into())
            })?;
            while let Some(entry) = entries.next_entry().await.map_err(|_| {
                ToolError::Execution("The target web CA directory could not be read".into())
            })? {
                let path = entry.path();
                // OpenSSL directories contain hashed aliases; only load PEM/CRT
                // files here to avoid parsing duplicate aliases and private keys.
                if matches!(
                    path.extension().and_then(|s| s.to_str()),
                    Some("pem" | "crt")
                ) {
                    paths.push(path);
                    if paths.len() > 512 {
                        return Err(ToolError::Execution(
                            "The target web CA directory exceeds the file limit".into(),
                        ));
                    }
                }
            }
        }
    }
    let mut remaining = MAX_BYTES;
    for path in paths {
        let (certificates, bytes) = pem(&path, remaining).await?;
        remaining -= bytes;
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }
    Ok(builder)
}
