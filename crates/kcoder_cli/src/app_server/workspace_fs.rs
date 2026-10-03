use anyhow::{Context, Result};
use base64::Engine as _;
use serde_json::{Value, json};
use sha2::Digest as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tokio::io::AsyncReadExt;

pub(super) const MAX_WORKSPACE_TEXT_BYTES: usize = 256 * 1024;
const MAX_WORKSPACE_BINARY_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_WORKSPACE_TREE_SCAN_ENTRIES: usize = 10_000;

pub(super) async fn read_text_file(
    workspace_root: &Path,
    parent: &Path,
    name: &str,
    max_bytes: usize,
) -> Result<Value> {
    let name_path = Path::new(name);
    if name_path.components().count() != 1
        || name_path.file_name().and_then(|item| item.to_str()) != Some(name)
    {
        anyhow::bail!("workspace filename is invalid")
    }
    let root = canonicalize_for_client(workspace_root).with_context(|| {
        format!(
            "failed to resolve workspace root {}",
            workspace_root.display()
        )
    })?;
    let parent = path(&root, parent).await?;
    let file_path = path(&root, &parent.join(name)).await?;
    let metadata = tokio::fs::metadata(&file_path).await?;
    if !metadata.is_file() {
        anyhow::bail!("workspace path is not a file")
    }
    let file = tokio::fs::File::open(&file_path).await?;
    let mut bytes = Vec::with_capacity(max_bytes.min(metadata.len() as usize));
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    let truncated = bytes.len() > max_bytes;
    if truncated {
        bytes.truncate(max_bytes);
    }
    let valid_utf8 = std::str::from_utf8(&bytes).is_ok();
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().to_string());
    let revision = format!("sha256:{:x}", sha2::Sha256::digest(&bytes));
    Ok(json!({
        "path": file_path,
        "name": name,
        "content": content,
        "editable": valid_utf8 && !truncated,
        "revision": revision,
        "truncated": truncated,
        "size": metadata.len(),
        "modified_at": modified_at,
    }))
}

pub(super) async fn read_file_chunk(
    workspace_root: &Path,
    parent: &Path,
    name: &str,
    offset: u64,
) -> Result<Value> {
    let (file_path, metadata) = file(workspace_root, parent, name).await?;
    let mut file = tokio::fs::File::open(&file_path).await?;
    tokio::io::AsyncSeekExt::seek(&mut file, std::io::SeekFrom::Start(offset)).await?;
    let mut bytes = vec![0_u8; MAX_WORKSPACE_BINARY_CHUNK_BYTES];
    let bytes_read = file.read(&mut bytes).await?;
    bytes.truncate(bytes_read);
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().to_string());
    Ok(json!({
        "path": file_path,
        "name": name,
        "content_base64": base64::engine::general_purpose::STANDARD.encode(bytes),
        "offset": offset,
        "eof": offset.saturating_add(bytes_read as u64) >= metadata.len(),
        "size": metadata.len(),
        "modified_at": modified_at,
    }))
}

pub(super) async fn write_text_file(
    workspace_root: &Path,
    parent: &Path,
    name: &str,
    expected_revision: &str,
    content: &str,
) -> Result<Value> {
    if content.len() > MAX_WORKSPACE_TEXT_BYTES {
        anyhow::bail!("workspace file content exceeds 256 KiB")
    }
    let (file_path, metadata) = file(workspace_root, parent, name).await?;
    let current = tokio::fs::read(&file_path).await?;
    std::str::from_utf8(&current).context("workspace file is not valid UTF-8")?;
    let current_revision = format!("sha256:{:x}", sha2::Sha256::digest(&current));
    if current_revision != expected_revision {
        // A file larger than the read limit can only ever produce the revision of
        // its truncated preview, so a mismatch here is the truncation itself, not
        // a concurrent edit. Naming it keeps a corrupted save from looking like a
        // race the user cannot explain (S3/R044).
        if current.len() > MAX_WORKSPACE_TEXT_BYTES {
            anyhow::bail!(
                "workspace file is larger than the {} KiB preview limit, so this revision came from a truncated preview; refusing to overwrite",
                MAX_WORKSPACE_TEXT_BYTES / 1024
            )
        }
        anyhow::bail!("workspace file has changed on disk")
    }
    let file_path_for_write = file_path.clone();
    let permissions = metadata.permissions();
    let saved_content = content.to_string();
    let content_bytes = saved_content.as_bytes().to_vec();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let parent = file_path_for_write
            .parent()
            .context("workspace file parent directory is missing")?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        temporary.write_all(&content_bytes)?;
        temporary.as_file_mut().sync_all()?;
        std::fs::set_permissions(temporary.path(), permissions)?;
        temporary
            .persist(&file_path_for_write)
            .map_err(|error| error.error)?;
        Ok(())
    })
    .await
    .context("workspace writer task failed")??;
    let saved_metadata = tokio::fs::metadata(&file_path).await?;
    let saved_revision = format!(
        "sha256:{:x}",
        sha2::Sha256::digest(saved_content.as_bytes())
    );
    let modified_at = saved_metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().to_string());
    Ok(json!({
        "path": file_path,
        "name": name,
        "content": saved_content,
        "editable": true,
        "revision": saved_revision,
        "truncated": false,
        "size": saved_metadata.len(),
        "modified_at": modified_at,
    }))
}

pub(super) async fn create_text_file(
    workspace_root: &Path,
    parent: &Path,
    name: &str,
    content: &str,
) -> Result<Value> {
    if content.len() > MAX_WORKSPACE_TEXT_BYTES {
        anyhow::bail!("workspace file content exceeds 256 KiB")
    }
    let file_path = new_entry_path(workspace_root, parent, name).await?;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
        .await
        .with_context(|| format!("failed to create {}", file_path.display()))?;
    tokio::io::AsyncWriteExt::write_all(&mut file, content.as_bytes()).await?;
    tokio::io::AsyncWriteExt::flush(&mut file).await?;
    read_text_file(workspace_root, parent, name, MAX_WORKSPACE_TEXT_BYTES).await
}

pub(super) async fn create_workspace_directory(
    workspace_root: &Path,
    parent: &Path,
    name: &str,
) -> Result<Value> {
    let directory = new_entry_path(workspace_root, parent, name).await?;
    tokio::fs::create_dir(&directory)
        .await
        .with_context(|| format!("failed to create {}", directory.display()))?;
    entry_value(&directory, name).await
}

pub(super) async fn rename_entry(
    workspace_root: &Path,
    parent: &Path,
    name: &str,
    new_name: &str,
) -> Result<Value> {
    let source = existing_entry_path(workspace_root, parent, name).await?;
    let destination = new_entry_path(workspace_root, parent, new_name).await?;
    tokio::fs::rename(&source, &destination)
        .await
        .with_context(|| {
            format!(
                "failed to rename {} to {}",
                source.display(),
                destination.display()
            )
        })?;
    entry_value(&destination, new_name).await
}

pub(super) async fn delete_entry(
    workspace_root: &Path,
    parent: &Path,
    name: &str,
    recursive: bool,
) -> Result<Value> {
    let entry = existing_entry_path(workspace_root, parent, name).await?;
    let metadata = tokio::fs::symlink_metadata(&entry).await?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        tokio::fs::remove_file(&entry).await?;
    } else if metadata.is_dir() {
        if recursive {
            tokio::fs::remove_dir_all(&entry).await?;
        } else {
            tokio::fs::remove_dir(&entry).await?;
        }
    } else {
        anyhow::bail!("workspace entry type cannot be deleted")
    }
    Ok(json!({"deleted": true}))
}

fn validate_entry_name(name: &str) -> Result<()> {
    let name_path = Path::new(name);
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name_path.components().count() != 1
        || name_path.file_name().and_then(|item| item.to_str()) != Some(name)
    {
        anyhow::bail!("workspace entry name is invalid")
    }
    Ok(())
}

async fn workspace_parent(workspace_root: &Path, parent: &Path) -> Result<PathBuf> {
    let root = canonicalize_for_client(workspace_root)?;
    let parent = path(&root, parent).await?;
    if !tokio::fs::metadata(&parent).await?.is_dir() {
        anyhow::bail!("workspace entry parent is not a directory")
    }
    Ok(parent)
}

async fn new_entry_path(workspace_root: &Path, parent: &Path, name: &str) -> Result<PathBuf> {
    validate_entry_name(name)?;
    let candidate = workspace_parent(workspace_root, parent).await?.join(name);
    if tokio::fs::try_exists(&candidate).await? {
        anyhow::bail!("workspace entry already exists")
    }
    Ok(candidate)
}

async fn existing_entry_path(workspace_root: &Path, parent: &Path, name: &str) -> Result<PathBuf> {
    validate_entry_name(name)?;
    let candidate = workspace_parent(workspace_root, parent).await?.join(name);
    tokio::fs::symlink_metadata(&candidate)
        .await
        .with_context(|| format!("workspace entry does not exist: {}", candidate.display()))?;
    Ok(candidate)
}

async fn entry_value(path: &Path, name: &str) -> Result<Value> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().to_string());
    Ok(json!({
        "name": name,
        "path": path,
        "is_directory": metadata.is_dir(),
        "size": metadata.len(),
        "modified_at": modified_at,
    }))
}

async fn file(
    workspace_root: &Path,
    parent: &Path,
    name: &str,
) -> Result<(PathBuf, std::fs::Metadata)> {
    let name_path = Path::new(name);
    if name_path.components().count() != 1
        || name_path.file_name().and_then(|item| item.to_str()) != Some(name)
    {
        anyhow::bail!("workspace filename is invalid")
    }
    let root = canonicalize_for_client(workspace_root)?;
    let parent = path(&root, parent).await?;
    if !tokio::fs::metadata(&parent).await?.is_dir() {
        anyhow::bail!("workspace file parent is not a directory")
    }
    let file_path = path(&root, &parent.join(name)).await?;
    let metadata = tokio::fs::metadata(&file_path).await?;
    if !metadata.is_file() {
        anyhow::bail!("workspace path is not a file")
    }
    Ok((file_path, metadata))
}

pub(super) async fn tree(workspace_root: &Path, requested: &Path) -> Result<Value> {
    let root = canonicalize_for_client(workspace_root).with_context(|| {
        format!(
            "failed to resolve workspace root {}",
            workspace_root.display()
        )
    })?;
    let directory = path(&root, requested).await?;
    let metadata = tokio::fs::metadata(&directory)
        .await
        .with_context(|| format!("failed to inspect {}", directory.display()))?;
    if !metadata.is_dir() {
        anyhow::bail!("workspace_tree path is not a directory")
    }
    let mut reader = tokio::fs::read_dir(&directory)
        .await
        .with_context(|| format!("failed to list {}", directory.display()))?;
    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        if entries.len() >= MAX_WORKSPACE_TREE_SCAN_ENTRIES {
            anyhow::bail!("workspace_tree contains more than 10,000 entries")
        }
        let metadata = entry.metadata().await?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis().to_string());
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "is_directory": metadata.is_dir(),
            "size": metadata.len(),
            "modified_at": modified_at,
        }));
    }
    entries.sort_by(|left, right| {
        let left_dir = left["is_directory"].as_bool().unwrap_or(false);
        let right_dir = right["is_directory"].as_bool().unwrap_or(false);
        right_dir.cmp(&left_dir).then_with(|| {
            left["name"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["name"].as_str().unwrap_or_default())
        })
    });
    let result = json!({"path": directory, "entries": entries});
    if serde_json::to_vec(&result)?.len() > super::MAX_DEVICE_RESULT_BYTES {
        anyhow::bail!("workspace_tree response exceeds the gateway transport limit")
    }
    Ok(result)
}

pub(super) async fn list_directories(_workspace_root: &Path, requested: &Path) -> Result<Value> {
    if !requested.is_absolute() {
        anyhow::bail!("directory path must be absolute")
    }
    let directory = canonicalize_for_client(requested)
        .with_context(|| format!("failed to resolve {}", requested.display()))?;
    if !tokio::fs::metadata(&directory).await?.is_dir() {
        anyhow::bail!("workspace path is not a directory")
    }
    let mut reader = tokio::fs::read_dir(&directory).await?;
    let mut directories = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        if entry.file_type().await?.is_dir() {
            directories.push(entry.file_name().to_string_lossy().into_owned());
        }
    }
    directories.sort();
    Ok(json!(directories))
}

pub(super) async fn create_directory(_workspace_root: &Path, requested: &Path) -> Result<Value> {
    if !requested.is_absolute() {
        anyhow::bail!("directory path must be absolute")
    }
    if tokio::fs::try_exists(requested).await? {
        let existing = canonicalize_for_client(requested)?;
        if !tokio::fs::metadata(&existing).await?.is_dir() {
            anyhow::bail!("workspace path is not a directory")
        }
        return Ok(Value::String(existing.to_string_lossy().into_owned()));
    }
    tokio::fs::create_dir_all(requested).await?;
    let resolved = canonicalize_for_client(requested)?;
    Ok(Value::String(resolved.to_string_lossy().into_owned()))
}

/// Canonicalizes a workspace path for client-facing responses.
///
/// `dunce` keeps ordinary Win32 semantics while dropping the Windows verbatim
/// namespace prefix, so protocol output never carries `\\?\` spellings.
pub(super) fn canonicalize_for_client(path: &Path) -> std::io::Result<PathBuf> {
    dunce::canonicalize(path)
}

pub(super) async fn path(root: &Path, requested: &Path) -> Result<PathBuf> {
    if !requested.is_absolute() {
        anyhow::bail!("workspace path must be absolute")
    }
    let resolved = canonicalize_for_client(requested)
        .with_context(|| format!("failed to resolve {}", requested.display()))?;
    if resolved != root && !resolved.starts_with(root) {
        anyhow::bail!("workspace path is outside the configured workspace")
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_for_client_never_keeps_a_verbatim_prefix() {
        let directory = tempfile::tempdir().unwrap();
        let resolved = canonicalize_for_client(directory.path()).unwrap();
        assert!(
            !resolved.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            resolved.display()
        );
    }

    #[cfg(windows)]
    #[test]
    fn dunce_simplified_strips_windows_namespaces() {
        assert_eq!(
            dunce::simplified(Path::new(r"\\?\C:\Users\dev\project")),
            Path::new(r"C:\Users\dev\project")
        );
    }

    #[tokio::test]
    async fn device_workspace_tree_is_bounded_to_the_configured_root() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("src")).unwrap();
        std::fs::write(workspace.path().join("README.md"), "hello").unwrap();
        let result = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(
                json!({"command_key": "workspace_tree", "path": workspace.path()}),
            )
            .unwrap(),
        )
        .await
        .unwrap();
        assert!(result.success);
        assert_eq!(result.stdout["entries"][0]["name"], "src");
        assert_eq!(result.stdout["entries"][0]["is_directory"], true);
        assert!(
            result.stdout["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["name"] == "README.md")
        );
        let file = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(json!({
                "command_key": "workspace_read_text_file",
                "path": workspace.path(),
                "args": ["README.md"],
                "max_output_bytes": 1024,
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(file.stdout["content"], "hello");
        assert_eq!(file.stdout["editable"], true);
        assert_eq!(
            file.stdout["revision"],
            format!("sha256:{:x}", sha2::Sha256::digest(b"hello"))
        );

        let revision = file.stdout["revision"].as_str().unwrap().to_string();
        let saved = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(json!({
                "command_key": "workspace_write_text_file",
                "path": workspace.path(),
                "args": ["README.md", revision],
                "stdin": "updated",
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(saved.stdout["content"], "updated");
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("README.md")).unwrap(),
            "updated"
        );

        let stale = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(json!({
                "command_key": "workspace_write_text_file",
                "path": workspace.path(),
                "args": ["README.md", "sha256:stale"],
                "stdin": "must-not-win",
            }))
            .unwrap(),
        )
        .await
        .unwrap_err();
        assert!(stale.to_string().contains("changed on disk"));
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("README.md")).unwrap(),
            "updated"
        );

        std::fs::write(workspace.path().join("bytes.bin"), [0_u8, 1, 2, 3]).unwrap();
        let chunk = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(json!({
                "command_key": "workspace_read_file_chunk",
                "path": workspace.path(),
                "args": ["bytes.bin", "1"],
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(chunk.stdout["content_base64"], "AQID");
        assert_eq!(chunk.stdout["offset"], 1);
        assert_eq!(chunk.stdout["eof"], true);

        let outside = tempfile::tempdir().unwrap();
        let error = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(
                json!({"command_key": "workspace_tree", "path": outside.path()}),
            )
            .unwrap(),
        )
        .await
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("outside the configured workspace")
        );

        for index in 0..200 {
            std::fs::write(workspace.path().join(format!("entry-{index:03}.txt")), "x").unwrap();
        }
        let full_tree = tree(workspace.path(), workspace.path()).await.unwrap();
        assert_eq!(full_tree["entries"].as_array().unwrap().len(), 203);
        assert!(
            full_tree["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["name"] == "README.md")
        );
    }

    #[tokio::test]
    async fn a_truncated_preview_revision_can_never_overwrite_the_file() {
        let workspace = tempfile::tempdir().unwrap();
        let oversized = "0123456789\n".repeat(MAX_WORKSPACE_TEXT_BYTES / 8);
        assert!(oversized.len() > MAX_WORKSPACE_TEXT_BYTES);
        std::fs::write(workspace.path().join("big.txt"), &oversized).unwrap();

        let preview = read_text_file(
            workspace.path(),
            workspace.path(),
            "big.txt",
            MAX_WORKSPACE_TEXT_BYTES,
        )
        .await
        .unwrap();
        assert_eq!(preview["truncated"], true);
        assert_eq!(preview["editable"], false);
        assert_eq!(
            preview["content"].as_str().unwrap().len(),
            MAX_WORKSPACE_TEXT_BYTES
        );

        // The revision a truncated read can produce never matches the whole
        // file, so the refusal must say why instead of blaming a concurrent
        // edit the user never made.
        let error = write_text_file(
            workspace.path(),
            workspace.path(),
            "big.txt",
            preview["revision"].as_str().unwrap(),
            "short",
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("truncated preview"),
            "a truncated preview must be named as the reason: {error}"
        );
        assert!(
            !error.contains("changed on disk"),
            "the refusal must not blame a concurrent edit: {error}"
        );
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("big.txt")).unwrap(),
            oversized
        );
    }

    #[tokio::test]
    async fn workspace_crud_stays_inside_the_configured_root() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();

        create_workspace_directory(workspace.path(), workspace.path(), "created")
            .await
            .unwrap();
        create_text_file(
            workspace.path(),
            &workspace.path().join("created"),
            "note.txt",
            "hello",
        )
        .await
        .unwrap();
        let renamed = rename_entry(
            workspace.path(),
            &workspace.path().join("created"),
            "note.txt",
            "renamed.txt",
        )
        .await
        .unwrap();
        assert_eq!(renamed["name"], "renamed.txt");
        assert_eq!(
            std::fs::read_to_string(workspace.path().join("created/renamed.txt")).unwrap(),
            "hello"
        );

        assert!(
            create_text_file(workspace.path(), outside.path(), "escaped.txt", "bad")
                .await
                .unwrap_err()
                .to_string()
                .contains("outside")
        );
        assert!(
            rename_entry(
                workspace.path(),
                &workspace.path().join("created"),
                "renamed.txt",
                "../escaped.txt",
            )
            .await
            .is_err()
        );

        delete_entry(
            workspace.path(),
            &workspace.path().join("created"),
            "renamed.txt",
            false,
        )
        .await
        .unwrap();
        delete_entry(workspace.path(), workspace.path(), "created", true)
            .await
            .unwrap();
        assert!(!workspace.path().join("created").exists());
    }

    #[tokio::test]
    async fn device_directory_commands_can_select_another_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir(workspace.path().join("existing")).unwrap();
        std::fs::write(workspace.path().join("README.md"), "hello").unwrap();

        let listed = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(json!({
                "command_key": "ls_dirs",
                "path": workspace.path(),
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(listed.stdout, json!(["existing"]));

        let created_path = workspace.path().join("created");
        let created = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(json!({
                "command_key": "mkdir_p",
                "args": [created_path],
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(created.stdout, json!(created_path));
        assert!(created_path.is_dir());

        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(outside.path().join("another-workspace")).unwrap();
        let outside_result = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(json!({
                "command_key": "ls_dirs",
                "path": outside.path(),
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(outside_result.stdout, json!(["another-workspace"]));

        let relative_error = super::super::device_execute(
            workspace.path(),
            &serde_json::from_value(json!({
                "command_key": "ls_dirs",
                "path": "relative/path",
            }))
            .unwrap(),
        )
        .await
        .unwrap_err();
        assert!(relative_error.to_string().contains("must be absolute"));
    }
}
