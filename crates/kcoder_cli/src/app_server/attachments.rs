use super::private_files::{
    ensure_private_artifact_directory, hex_sha256, write_private_artifact_file,
};
use anyhow::{Context, Result};
use base64::Engine as _;
use fs2::FileExt;
use kcoder_app_protocol::{
    AttachmentReadChunkParams, AttachmentReadChunkResult, AttachmentReadParams,
    AttachmentReadResult, AttachmentSaveParams, AttachmentSaveResult, AttachmentUploadChunkParams,
    AttachmentUploadFinishParams, AttachmentUploadStartParams, AttachmentUploadStartResult,
};
use kcoder_engine::QueryEngine;
use kcoder_types::{ContentBlock, ImageSource, Message};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_BROWSER_ATTACHMENT_BYTES: usize = 256 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;
const MAX_ATTACHMENT_CHUNK_BYTES: usize = 512 * 1024;
const MAX_STAGED_ATTACHMENT_BYTES: u64 = 200 * 1024 * 1024;
const MAX_PENDING_UPLOADS: usize = 4;
const MAX_ATTACHMENTS_PER_TURN: usize = 32;
const KCODER_ATTACHMENTS_OPEN: &str = "<kcoder_attachments version=\"1\">\n";
const KCODER_ATTACHMENTS_CLOSE: &str = "\n</kcoder_attachments>";
pub(super) const ATTACHMENT_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Default)]
pub(super) struct AttachmentDirectories {
    directories: HashSet<PathBuf>,
    staged_files: HashSet<PathBuf>,
    persisted_aliases: HashMap<PathBuf, PathBuf>,
    pending_uploads: HashMap<String, PendingAttachmentUpload>,
    owner: Option<AttachmentOwnerLease>,
}

struct PendingAttachmentUpload {
    directory: PathBuf,
    path: PathBuf,
    file: std::fs::File,
    expected_size: u64,
    received_size: u64,
    next_index: u32,
}

struct AttachmentOwnerLease {
    directory: PathBuf,
    lease_path: PathBuf,
    lease: Option<std::fs::File>,
}

impl AttachmentDirectories {
    fn owner_directory(&mut self) -> Result<&Path> {
        if self.owner.is_none() {
            self.owner = Some(create_attachment_owner_lease()?);
        }
        Ok(&self.owner.as_ref().expect("owner initialized").directory)
    }

    pub(super) fn track(&mut self, path: PathBuf) {
        if let Some(directory) = path.parent() {
            self.directories.insert(directory.to_path_buf());
        }
        self.staged_files.insert(path);
    }

    pub(super) fn contains(&self, path: &Path) -> bool {
        self.staged_files.contains(path)
    }

    pub(super) fn consume(&mut self, path: &Path) -> Result<()> {
        if !self.staged_files.remove(path) {
            anyhow::bail!("staged attachment was already consumed")
        }
        let Some(directory) = path.parent() else {
            return Ok(());
        };
        let directory_still_active = self
            .staged_files
            .iter()
            .any(|staged| staged.parent() == Some(directory));
        if !directory_still_active && self.directories.remove(directory) {
            match std::fs::remove_dir_all(directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(path = %directory.display(), %error, "failed to remove consumed staged attachment");
                }
            }
        }
        Ok(())
    }

    fn persist(&mut self, staged_path: PathBuf, durable_path: PathBuf) -> Result<()> {
        self.consume(&staged_path)?;
        self.persisted_aliases.insert(staged_path, durable_path);
        Ok(())
    }

    fn resolved_path<'a>(&'a self, path: &'a Path) -> &'a Path {
        self.persisted_aliases
            .get(path)
            .map(PathBuf::as_path)
            .unwrap_or(path)
    }

    fn reserved_bytes(&self) -> u64 {
        let staged = self
            .staged_files
            .iter()
            .filter_map(|path| std::fs::metadata(path).ok().map(|metadata| metadata.len()))
            .sum::<u64>();
        staged.saturating_add(
            self.pending_uploads
                .values()
                .map(|upload| upload.expected_size)
                .sum::<u64>(),
        )
    }
}

impl Drop for AttachmentDirectories {
    fn drop(&mut self) {
        for directory in self.directories.drain() {
            if let Err(error) = std::fs::remove_dir_all(&directory)
                && error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!(path = %directory.display(), %error, "failed to clean staged browser attachment");
            }
        }
        if let Some(owner) = self.owner.take() {
            drop(owner);
        }
    }
}

impl Drop for AttachmentOwnerLease {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.directory)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(path = %self.directory.display(), %error, "failed to clean attachment owner directory");
        }
        if let Some(lease) = self.lease.take() {
            let _ = lease.unlock();
            drop(lease);
        }
        if let Err(error) = std::fs::remove_file(&self.lease_path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(path = %self.lease_path.display(), %error, "failed to clean attachment owner lease");
        }
    }
}

pub(super) fn attachment_save(
    session_id: &str,
    params: &AttachmentSaveParams,
    staged: &mut AttachmentDirectories,
) -> Result<AttachmentSaveResult> {
    let filename = validate_attachment_filename(&params.filename)?;
    let encoded = params.content_base64.as_str();
    if encoded.len() > MAX_BROWSER_ATTACHMENT_BYTES.div_ceil(3) * 4 {
        anyhow::bail!("browser attachment exceeds the 256 KiB gateway limit")
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("attachment content_base64 is invalid")?;
    if bytes.len() > MAX_BROWSER_ATTACHMENT_BYTES {
        anyhow::bail!("browser attachment exceeds the 256 KiB gateway limit")
    }
    if staged.reserved_bytes().saturating_add(bytes.len() as u64) > MAX_STAGED_ATTACHMENT_BYTES {
        anyhow::bail!("staged attachments exceed the 200 MiB connection limit")
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let owner_directory = staged.owner_directory()?.to_path_buf();
    let directory = create_private_attachment_directory(&owner_directory, session_id, stamp)?;
    let path = directory.join(filename);
    if let Err(error) = write_private_attachment(&path, &bytes) {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(error);
    }
    staged.track(path.clone());
    Ok(AttachmentSaveResult {
        path: path.to_string_lossy().into_owned(),
    })
}

pub(super) fn attachment_upload_start(
    session_id: &str,
    params: &AttachmentUploadStartParams,
    staged: &mut AttachmentDirectories,
) -> Result<AttachmentUploadStartResult> {
    let filename = validate_attachment_filename(&params.filename)?;
    if params.size > MAX_ATTACHMENT_BYTES as u64 {
        anyhow::bail!("attachment exceeds the 100 MiB gateway limit")
    }
    if staged.pending_uploads.len() >= MAX_PENDING_UPLOADS {
        anyhow::bail!("too many attachment uploads are pending")
    }
    if staged.reserved_bytes().saturating_add(params.size) > MAX_STAGED_ATTACHMENT_BYTES {
        anyhow::bail!("staged attachments exceed the 200 MiB connection limit")
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let owner_directory = staged.owner_directory()?.to_path_buf();
    let directory = create_private_attachment_directory(&owner_directory, session_id, stamp)?;
    let path = directory.join(filename);
    let file = match create_private_attachment_file(&path) {
        Ok(file) => file,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&directory);
            return Err(error);
        }
    };
    let upload_id =
        hex_sha256(format!("upload:{session_id}:{stamp}:{}", path.display()).as_bytes())[..32]
            .to_string();
    staged.directories.insert(directory.clone());
    staged.pending_uploads.insert(
        upload_id.clone(),
        PendingAttachmentUpload {
            directory,
            path,
            file,
            expected_size: params.size,
            received_size: 0,
            next_index: 0,
        },
    );
    Ok(AttachmentUploadStartResult { upload_id })
}

pub(super) fn attachment_upload_chunk(
    params: &AttachmentUploadChunkParams,
    staged: &mut AttachmentDirectories,
) -> Result<()> {
    let upload = staged
        .pending_uploads
        .get_mut(&params.upload_id)
        .context("attachment upload is missing or already finished")?;
    if params.index != upload.next_index {
        anyhow::bail!("attachment chunk index is out of sequence")
    }
    if params.content_base64.len() > MAX_ATTACHMENT_CHUNK_BYTES.div_ceil(3) * 4 {
        anyhow::bail!("attachment chunk exceeds the 512 KiB limit")
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&params.content_base64)
        .context("attachment chunk content_base64 is invalid")?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_CHUNK_BYTES {
        anyhow::bail!("attachment chunk must contain 1 to 512 KiB")
    }
    let next_size = upload.received_size.saturating_add(bytes.len() as u64);
    if next_size > upload.expected_size || next_size > MAX_ATTACHMENT_BYTES as u64 {
        anyhow::bail!("attachment upload exceeds its declared size")
    }
    upload.file.write_all(&bytes)?;
    upload.received_size = next_size;
    upload.next_index = upload.next_index.saturating_add(1);
    Ok(())
}

pub(super) fn attachment_upload_finish(
    params: &AttachmentUploadFinishParams,
    staged: &mut AttachmentDirectories,
) -> Result<AttachmentSaveResult> {
    let upload = staged
        .pending_uploads
        .remove(&params.upload_id)
        .context("attachment upload is missing or already finished")?;
    if upload.received_size != upload.expected_size {
        let _ = std::fs::remove_dir_all(&upload.directory);
        staged.directories.remove(&upload.directory);
        anyhow::bail!("attachment upload size does not match its declaration")
    }
    if let Err(error) = upload.file.sync_all() {
        let _ = std::fs::remove_dir_all(&upload.directory);
        staged.directories.remove(&upload.directory);
        return Err(error.into());
    }
    let path = upload.path;
    staged.track(path.clone());
    Ok(AttachmentSaveResult {
        path: path.to_string_lossy().into_owned(),
    })
}

pub(super) fn attachment_upload_cancel(
    upload_id: &str,
    staged: &mut AttachmentDirectories,
) -> Result<()> {
    let upload = staged
        .pending_uploads
        .remove(upload_id)
        .context("attachment upload is missing or already finished")?;
    drop(upload.file);
    match std::fs::remove_dir_all(&upload.directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    staged.directories.remove(&upload.directory);
    Ok(())
}

fn validate_attachment_filename(filename: &str) -> Result<&str> {
    let filename_path = Path::new(filename);
    if filename_path.components().count() != 1
        || filename_path.file_name().and_then(|item| item.to_str()) != Some(filename)
        || filename
            .chars()
            .any(|character| character.is_control() || matches!(character, '<' | '>'))
    {
        anyhow::bail!("attachment filename is invalid")
    }
    Ok(filename)
}

pub(super) fn attachment_read(
    engine: &QueryEngine,
    params: &AttachmentReadParams,
    staged: &AttachmentDirectories,
) -> Result<AttachmentReadResult> {
    let canonical_path =
        resolve_thread_attachment(engine, &params.thread_id, &params.path, staged)?;
    if std::fs::metadata(&canonical_path)?.len() > MAX_BROWSER_ATTACHMENT_BYTES as u64 {
        anyhow::bail!("attachment preview exceeds the 256 KiB response limit")
    }
    let bytes = read_private_staged_attachment(&canonical_path)?;
    Ok(AttachmentReadResult {
        content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size: bytes.len() as u64,
    })
}

pub(super) fn attachment_read_chunk(
    engine: &QueryEngine,
    params: &AttachmentReadChunkParams,
    staged: &AttachmentDirectories,
) -> Result<AttachmentReadChunkResult> {
    let length = params.length as usize;
    if length == 0 || length > MAX_ATTACHMENT_CHUNK_BYTES {
        anyhow::bail!("attachment download chunk must contain 1 to 512 KiB")
    }
    let canonical_path =
        resolve_thread_attachment(engine, &params.thread_id, &params.path, staged)?;
    let (bytes, total_size) =
        read_private_staged_attachment_range(&canonical_path, params.offset, length)?;
    let size = bytes.len() as u64;
    Ok(AttachmentReadChunkResult {
        content_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        offset: params.offset,
        size,
        total_size,
        eof: params.offset.saturating_add(size) >= total_size,
    })
}

fn resolve_thread_attachment(
    engine: &QueryEngine,
    thread_id: &str,
    path: &str,
    staged: &AttachmentDirectories,
) -> Result<PathBuf> {
    let requested_alias = PathBuf::from(path);
    // Only unconsumed paths registered by this connection may use its staging root.
    // Persisted aliases must still pass the requested thread's durable boundary.
    let attachment_root = if staged.contains(&requested_alias) {
        staged
            .owner
            .as_ref()
            .context("attachment was not staged by this app-server connection")?
            .directory
            .clone()
    } else {
        engine
            .session_storage_dir_for(thread_id)
            .join("attachments")
    };
    let root_metadata =
        std::fs::symlink_metadata(&attachment_root).context("attachment directory is missing")?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        anyhow::bail!("attachment directory must not be a symbolic link or regular file")
    }
    let canonical_root =
        std::fs::canonicalize(&attachment_root).context("attachment directory is missing")?;
    let requested = staged.resolved_path(&requested_alias);
    let requested_metadata =
        std::fs::symlink_metadata(requested).context("attachment is missing")?;
    if requested_metadata.file_type().is_symlink() {
        anyhow::bail!("attachment path must not be a symbolic link")
    }
    if !requested_metadata.is_file() {
        anyhow::bail!("attachment is not a regular file")
    }
    let canonical_path = std::fs::canonicalize(requested).context("attachment is missing")?;
    if !canonical_path.starts_with(&canonical_root) {
        anyhow::bail!("attachment path escapes the active thread")
    }
    Ok(canonical_path)
}

pub(super) fn split_history_attachment_envelope(content: String) -> (String, Vec<Value>) {
    let Some(open_index) = content.rfind(KCODER_ATTACHMENTS_OPEN) else {
        return (content, Vec::new());
    };
    if !content.ends_with(KCODER_ATTACHMENTS_CLOSE) {
        return (content, Vec::new());
    }
    let body_start = open_index + KCODER_ATTACHMENTS_OPEN.len();
    let body_end = content.len() - KCODER_ATTACHMENTS_CLOSE.len();
    let lines = content[body_start..body_end].lines().collect::<Vec<_>>();
    if lines.is_empty() || lines.len() > MAX_ATTACHMENTS_PER_TURN {
        return (content, Vec::new());
    }
    let mut attachments = Vec::with_capacity(lines.len());
    for (index, line) in lines.into_iter().enumerate() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return (content, Vec::new());
        };
        let Some(object) = record.as_object() else {
            return (content, Vec::new());
        };
        if !object.get("filename").is_some_and(Value::is_string)
            || !object.get("path").is_some_and(Value::is_string)
        {
            return (content, Vec::new());
        }
        attachments.push(serde_json::json!({
            "id": format!("attachment-{index}"),
            "type": "attachment",
            "status": "done",
            "attachment": record,
        }));
    }
    (content[..open_index].trim_end().to_string(), attachments)
}

pub(super) fn materialize_turn_attachments(
    engine: &QueryEngine,
    thread_id: &str,
    turn_id: &str,
    prompt: &str,
    staged: &mut AttachmentDirectories,
) -> Result<String> {
    let attachment_root = engine
        .session_storage_dir_for(thread_id)
        .join("attachments");
    materialize_turn_attachments_in_root(&attachment_root, thread_id, turn_id, prompt, staged)
}

pub(super) fn model_message_from_materialized_prompt(prompt: &str) -> Result<Option<Message>> {
    let Some(open_index) = prompt.rfind(KCODER_ATTACHMENTS_OPEN) else {
        return Ok(None);
    };
    if !prompt.ends_with(KCODER_ATTACHMENTS_CLOSE) {
        return Ok(None);
    }

    let body_start = open_index + KCODER_ATTACHMENTS_OPEN.len();
    let body_end = prompt.len() - KCODER_ATTACHMENTS_CLOSE.len();
    let mut content = vec![ContentBlock::Text {
        text: prompt.to_string(),
    }];
    for line in prompt[body_start..body_end].lines() {
        let record: Value = serde_json::from_str(line).context("invalid turn attachment record")?;
        let Some(mime_type) = record.get("mimeType").and_then(Value::as_str) else {
            continue;
        };
        if !mime_type.starts_with("image/") {
            continue;
        }
        let path = record
            .get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .context("turn image attachment record is missing path")?;
        let bytes = read_private_staged_attachment(&path)
            .context("failed to read materialized image attachment")?;
        content.push(ContentBlock::Image {
            source: ImageSource::base64(
                mime_type,
                base64::engine::general_purpose::STANDARD.encode(bytes),
            ),
        });
    }

    if content.len() == 1 {
        return Ok(None);
    }
    Ok(Some(Message::user_content(content)))
}

fn materialize_turn_attachments_in_root(
    attachment_root: &Path,
    thread_id: &str,
    turn_id: &str,
    prompt: &str,
    staged: &mut AttachmentDirectories,
) -> Result<String> {
    let Some(open_index) = prompt.rfind(KCODER_ATTACHMENTS_OPEN) else {
        return Ok(prompt.to_string());
    };
    if !prompt.ends_with(KCODER_ATTACHMENTS_CLOSE) {
        return Ok(prompt.to_string());
    }
    let body_start = open_index + KCODER_ATTACHMENTS_OPEN.len();
    let body_end = prompt.len() - KCODER_ATTACHMENTS_CLOSE.len();
    let lines = prompt[body_start..body_end].lines().collect::<Vec<_>>();
    if lines.is_empty() || lines.len() > MAX_ATTACHMENTS_PER_TURN {
        anyhow::bail!("turn attachment block must contain 1 to {MAX_ATTACHMENTS_PER_TURN} items")
    }

    let mut records = Vec::with_capacity(lines.len());
    let mut unique_paths = HashSet::with_capacity(lines.len());
    for line in lines {
        let record: Value = serde_json::from_str(line).context("invalid turn attachment record")?;
        let path = record
            .get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .context("turn attachment record is missing path")?;
        if !unique_paths.insert(path.clone()) {
            anyhow::bail!("turn attachment block contains the same staged path more than once")
        }
        if !staged.contains(&path) {
            anyhow::bail!("turn attachment path was not staged by this app-server connection")
        }
        let filename = record
            .get("filename")
            .and_then(Value::as_str)
            .context("turn attachment record is missing filename")?
            .to_string();
        if path.file_name().and_then(|name| name.to_str()) != Some(filename.as_str()) {
            anyhow::bail!("turn attachment filename does not match its staged path")
        }
        records.push((record, path, filename));
    }

    ensure_private_artifact_directory(attachment_root)?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let digest = hex_sha256(format!("{thread_id}:{turn_id}:{stamp}").as_bytes());
    let durable_directory = attachment_root.join(format!("{turn_id}-{}", &digest[..16]));
    create_private_directory(&durable_directory)?;

    let mut persisted_aliases = Vec::with_capacity(records.len());
    let result = (|| -> Result<String> {
        let mut rewritten = Vec::with_capacity(records.len());
        for (index, (mut record, source, filename)) in records.iter().cloned().enumerate() {
            let bytes = read_private_staged_attachment(&source)?;
            let target = durable_directory.join(format!("{index:02}-{filename}"));
            write_private_artifact_file(&target, &bytes)?;
            persisted_aliases.push((source.clone(), target.clone()));
            let object = record
                .as_object_mut()
                .context("turn attachment record must be an object")?;
            object.insert(
                "path".into(),
                Value::String(target.to_string_lossy().into_owned()),
            );
            object.insert("fileSize".into(), Value::from(bytes.len() as u64));
            rewritten.push(serde_json::to_string(&record)?);
        }
        Ok(format!(
            "{}{}{}",
            &prompt[..body_start],
            rewritten.join("\n"),
            KCODER_ATTACHMENTS_CLOSE,
        ))
    })();
    match result {
        Ok(prompt) => {
            for (source, durable) in persisted_aliases {
                staged.persist(source, durable)?;
            }
            Ok(prompt)
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&durable_directory);
            Err(error)
        }
    }
}

#[cfg(not(windows))]
fn open_private_staged_attachment(path: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(path).context("failed to open attachment")?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_ATTACHMENT_BYTES as u64 {
        anyhow::bail!("staged attachment is not a bounded regular file")
    }
    Ok(file)
}

#[cfg(windows)]
fn open_private_staged_attachment(path: &Path) -> Result<std::fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_EXISTING,
    };

    // Canonicalize only the parent to obtain the extended-length Windows path.
    // Keep the leaf intact so FILE_FLAG_OPEN_REPARSE_POINT can still reject links.
    let parent = path.parent().context("attachment path has no parent")?;
    let name = path
        .file_name()
        .context("attachment path has no file name")?;
    let extended_path = std::fs::canonicalize(parent)?.join(name);
    let wide_path = extended_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: wide_path is NUL-terminated UTF-16; the returned handle is immediately owned by File.
    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error()).context("failed to open attachment");
    }
    // SAFETY: handle came from successful CreateFileW and ownership is transferred exactly once here.
    let file = unsafe { std::fs::File::from_raw_handle(handle) };
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: file owns a valid handle and information points to initialized writable storage.
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(std::io::Error::last_os_error()).context("failed to inspect staged attachment");
    }
    let attributes = information.dwFileAttributes;
    if attributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        anyhow::bail!("staged attachment is not a bounded regular file")
    }
    let length = ((information.nFileSizeHigh as u64) << 32) | information.nFileSizeLow as u64;
    if length > MAX_ATTACHMENT_BYTES as u64 {
        anyhow::bail!("staged attachment is not a bounded regular file")
    }
    Ok(file)
}

fn read_private_staged_attachment(path: &Path) -> Result<Vec<u8>> {
    let mut file = open_private_staged_attachment(path)?;
    let length = file.metadata()?.len() as usize;
    let mut bytes = Vec::with_capacity(length);
    file.read_to_end(&mut bytes)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        anyhow::bail!("staged attachment exceeds the gateway limit")
    }
    Ok(bytes)
}

fn read_private_staged_attachment_range(
    path: &Path,
    offset: u64,
    requested_length: usize,
) -> Result<(Vec<u8>, u64)> {
    let mut file = open_private_staged_attachment(path)?;
    let total_size = file.metadata()?.len();
    if offset > total_size {
        anyhow::bail!("attachment download offset exceeds file size")
    }
    let length = requested_length.min((total_size - offset) as usize);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0_u8; length];
    file.read_exact(&mut bytes)?;
    Ok((bytes, total_size))
}

pub(super) fn clone_fork_attachments(
    engine: &QueryEngine,
    source_thread_id: &str,
    fork_thread_id: &str,
    messages: &mut [kcoder_types::Message],
) -> Result<()> {
    clone_fork_attachments_between(engine, engine, source_thread_id, fork_thread_id, messages)
}

pub(super) fn clone_fork_attachments_between(
    engine: &QueryEngine,
    destination_engine: &QueryEngine,
    source_thread_id: &str,
    fork_thread_id: &str,
    messages: &mut [kcoder_types::Message],
) -> Result<()> {
    let has_attachments = messages.iter().any(message_has_attachments);
    if !has_attachments {
        return Ok(());
    }
    let source_root = engine
        .session_storage_dir_for(source_thread_id)
        .join("attachments");
    let source_root = std::fs::canonicalize(&source_root).with_context(|| {
        format!(
            "fork source attachment directory is missing: {}",
            source_root.display()
        )
    })?;
    let destination_root = destination_engine
        .session_storage_dir_for(fork_thread_id)
        .join("attachments");
    ensure_private_artifact_directory(&destination_root)?;
    let digest = hex_sha256(format!("{source_thread_id}:{fork_thread_id}").as_bytes());
    let destination = destination_root.join(format!("fork-{}", &digest[..16]));
    create_private_directory(&destination)?;

    let result = (|| -> Result<()> {
        let mut copied = HashMap::<PathBuf, PathBuf>::new();
        let mut next_index = 0usize;
        for message in messages {
            let kcoder_types::Message::User { content, .. } = message else {
                continue;
            };
            for block in content {
                let kcoder_types::ContentBlock::Text { text } = block else {
                    continue;
                };
                *text = clone_attachment_paths_in_prompt(
                    text,
                    &source_root,
                    &destination,
                    &mut copied,
                    &mut next_index,
                )?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&destination_root);
        return Err(error);
    }
    Ok(())
}

fn message_has_attachments(message: &kcoder_types::Message) -> bool {
    match message {
        kcoder_types::Message::User { content, .. } => content.iter().any(|block| {
            matches!(block, kcoder_types::ContentBlock::Text { text } if text.rfind(KCODER_ATTACHMENTS_OPEN).is_some() && text.ends_with(KCODER_ATTACHMENTS_CLOSE))
        }),
        kcoder_types::Message::Assistant { .. } => false,
    }
}

fn clone_attachment_paths_in_prompt(
    prompt: &str,
    source_root: &Path,
    destination: &Path,
    copied: &mut HashMap<PathBuf, PathBuf>,
    next_index: &mut usize,
) -> Result<String> {
    let Some(open_index) = prompt.rfind(KCODER_ATTACHMENTS_OPEN) else {
        return Ok(prompt.to_string());
    };
    if !prompt.ends_with(KCODER_ATTACHMENTS_CLOSE) {
        return Ok(prompt.to_string());
    }
    let body_start = open_index + KCODER_ATTACHMENTS_OPEN.len();
    let body_end = prompt.len() - KCODER_ATTACHMENTS_CLOSE.len();
    let mut rewritten = Vec::new();
    for line in prompt[body_start..body_end].lines() {
        let mut record: Value = serde_json::from_str(line)
            .context("invalid persisted attachment record while forking")?;
        let source = record
            .get("path")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .context("persisted attachment record is missing path")?;
        let source = std::fs::canonicalize(&source)
            .with_context(|| format!("persisted attachment is missing: {}", source.display()))?;
        if !source.starts_with(source_root) {
            anyhow::bail!("persisted attachment escapes its source thread")
        }
        let target = if let Some(target) = copied.get(&source) {
            target.clone()
        } else {
            let filename = source
                .file_name()
                .and_then(|name| name.to_str())
                .context("persisted attachment filename is invalid")?;
            let target = destination.join(format!("{:03}-{filename}", *next_index));
            *next_index = next_index.saturating_add(1);
            let bytes = read_private_staged_attachment(&source)?;
            write_private_artifact_file(&target, &bytes)?;
            copied.insert(source.clone(), target.clone());
            target
        };
        record
            .as_object_mut()
            .context("persisted attachment record must be an object")?
            .insert(
                "path".into(),
                Value::String(target.to_string_lossy().into_owned()),
            );
        rewritten.push(serde_json::to_string(&record)?);
    }
    Ok(format!(
        "{}{}{}",
        &prompt[..body_start],
        rewritten.join("\n"),
        KCODER_ATTACHMENTS_CLOSE
    ))
}

fn create_attachment_owner_lease() -> Result<AttachmentOwnerLease> {
    create_attachment_owner_lease_in(&std::env::temp_dir())
}

fn create_attachment_owner_lease_in(root: &Path) -> Result<AttachmentOwnerLease> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let digest = hex_sha256(format!("owner:{stamp}:{}", std::process::id()).as_bytes());
    let name = format!("kcoder-studio-attachment-owner-{}", &digest[..24]);
    let directory = root.join(&name);
    let lease_path = root.join(format!("{name}.lease"));
    let lease = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&lease_path)?;
    lease.lock_exclusive()?;
    if let Err(error) = create_private_directory(&directory) {
        let _ = lease.unlock();
        let _ = std::fs::remove_file(&lease_path);
        return Err(error);
    }
    Ok(AttachmentOwnerLease {
        directory,
        lease_path,
        lease: Some(lease),
    })
}

fn create_private_attachment_directory(
    owner_directory: &Path,
    session_id: &str,
    stamp: u128,
) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{session_id}:{stamp}:{}", std::process::id()));
    let directory = owner_directory.join(format!("item-{digest:x}"));
    create_private_directory(&directory)?;
    Ok(directory)
}

fn create_private_directory(directory: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700);
        builder.create(directory)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir(directory)?;
    Ok(())
}

pub(super) fn scavenge_stale_attachment_directories(
    root: &Path,
    now: SystemTime,
    ttl: Duration,
) -> Result<()> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("kcoder-studio-attachment-owner-") || !entry.file_type()?.is_dir() {
            continue;
        }
        let modified = entry.metadata()?.modified().unwrap_or(now);
        if now.duration_since(modified).unwrap_or_default() < ttl {
            continue;
        }
        let lease_path = root.join(format!("{name}.lease"));
        let lease = match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lease_path)
        {
            Ok(lease) => lease,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        match lease.try_lock_exclusive() {
            Ok(()) => {
                std::fs::remove_dir_all(&path)?;
                let _ = lease.unlock();
                drop(lease);
                std::fs::remove_file(lease_path)?;
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock
                    || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn write_private_attachment(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = create_private_attachment_file(path)?;
    file.write_all(bytes)?;
    Ok(())
}

fn create_private_attachment_file(path: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    Ok(options.open(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER_HELPER_ROOT_ENV: &str = "KCODER_TEST_ATTACHMENT_OWNER_ROOT";
    const OWNER_HELPER_READY_ENV: &str = "KCODER_TEST_ATTACHMENT_OWNER_READY";

    struct OwnerChild(std::process::Child);

    impl OwnerChild {
        fn terminate(&mut self) {
            if self.0.try_wait().unwrap().is_none() {
                self.0.kill().unwrap();
            }
            self.0.wait().unwrap();
        }
    }

    impl Drop for OwnerChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
    }

    fn spawn_owner_process(root: &Path, ready: &Path) -> OwnerChild {
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "app_server::attachments::tests::attachment_owner_process_helper",
                "--nocapture",
            ])
            .env(OWNER_HELPER_ROOT_ENV, root)
            .env(OWNER_HELPER_READY_ENV, ready)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        OwnerChild(child)
    }

    fn wait_for_owner(child: &mut OwnerChild, ready: &Path) -> PathBuf {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Ok(path) = std::fs::read_to_string(ready) {
                return PathBuf::from(path);
            }
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("attachment owner helper exited before ready: {status}");
            }
            assert!(
                std::time::Instant::now() < deadline,
                "attachment owner helper did not become ready"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn attachment_prompt(records: &[Value]) -> String {
        let records = records
            .iter()
            .map(|record| serde_json::to_string(record).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        format!("prompt\n{KCODER_ATTACHMENTS_OPEN}{records}{KCODER_ATTACHMENTS_CLOSE}")
    }

    fn record(path: &Path, filename: &str) -> Value {
        serde_json::json!({"path": path, "filename": filename})
    }

    #[test]
    fn attachment_owner_process_helper() {
        let Some(root) = std::env::var_os(OWNER_HELPER_ROOT_ENV) else {
            return;
        };
        let ready = PathBuf::from(
            std::env::var_os(OWNER_HELPER_READY_ENV).expect("owner helper ready path is set"),
        );
        let mut runtime = AttachmentDirectories {
            directories: HashSet::new(),
            staged_files: HashSet::new(),
            persisted_aliases: HashMap::new(),
            pending_uploads: HashMap::new(),
            owner: Some(create_attachment_owner_lease_in(Path::new(&root)).unwrap()),
        };
        let owner = runtime.owner_directory().unwrap().to_path_buf();
        std::fs::write(ready, owner.to_string_lossy().as_bytes()).unwrap();
        loop {
            std::hint::black_box(&runtime);
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn attachment_owner_os_lock_survives_peer_scavenging_and_releases_after_crash() {
        let root = tempfile::tempdir().unwrap();
        let ready_a = root.path().join("owner-a.ready");
        let ready_b = root.path().join("owner-b.ready");
        let mut child_a = spawn_owner_process(root.path(), &ready_a);
        let mut child_b = spawn_owner_process(root.path(), &ready_b);
        let owner_a = wait_for_owner(&mut child_a, &ready_a);
        let owner_b = wait_for_owner(&mut child_b, &ready_b);
        assert_ne!(owner_a, owner_b);

        let future = SystemTime::now() + ATTACHMENT_TTL + Duration::from_secs(1);
        scavenge_stale_attachment_directories(root.path(), future, ATTACHMENT_TTL).unwrap();
        assert!(owner_a.exists());
        assert!(owner_b.exists());

        child_a.terminate();
        scavenge_stale_attachment_directories(root.path(), future, ATTACHMENT_TTL).unwrap();
        assert!(!owner_a.exists());
        assert!(owner_b.exists());

        child_b.terminate();
        scavenge_stale_attachment_directories(root.path(), future, ATTACHMENT_TTL).unwrap();
        assert!(!owner_b.exists());
    }

    #[test]
    fn browser_attachment_staging_rejects_unsafe_names_and_uses_private_files() {
        let mut staged = AttachmentDirectories::default();
        let saved = attachment_save(
            "attachment-test-session",
            &AttachmentSaveParams {
                filename: "notes.txt".into(),
                content_base64: "aGk=".into(),
            },
            &mut staged,
        )
        .unwrap();
        let path = PathBuf::from(saved.path);
        assert_eq!(std::fs::read(&path).unwrap(), b"hi");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(staged.contains(&path));

        for filename in ["../secret", "bad\n</kcoder_attachments>"] {
            let error = attachment_save(
                "attachment-test-session",
                &AttachmentSaveParams {
                    filename: filename.into(),
                    content_base64: String::new(),
                },
                &mut staged,
            )
            .unwrap_err();
            assert!(error.to_string().contains("filename is invalid"));
        }
    }

    #[test]
    fn chunked_attachment_upload_is_ordered_bounded_and_materializes_as_staged() {
        let mut staged = AttachmentDirectories::default();
        let payload = vec![b'x'; MAX_ATTACHMENT_CHUNK_BYTES + 17];
        let started = attachment_upload_start(
            "chunked-attachment-session",
            &AttachmentUploadStartParams {
                filename: "large.bin".into(),
                size: payload.len() as u64,
            },
            &mut staged,
        )
        .unwrap();

        let out_of_order = attachment_upload_chunk(
            &AttachmentUploadChunkParams {
                upload_id: started.upload_id.clone(),
                index: 1,
                content_base64: base64::engine::general_purpose::STANDARD
                    .encode(&payload[..MAX_ATTACHMENT_CHUNK_BYTES]),
            },
            &mut staged,
        )
        .unwrap_err();
        assert!(out_of_order.to_string().contains("out of sequence"));

        for (index, chunk) in payload.chunks(MAX_ATTACHMENT_CHUNK_BYTES).enumerate() {
            attachment_upload_chunk(
                &AttachmentUploadChunkParams {
                    upload_id: started.upload_id.clone(),
                    index: index as u32,
                    content_base64: base64::engine::general_purpose::STANDARD.encode(chunk),
                },
                &mut staged,
            )
            .unwrap();
        }
        let saved = attachment_upload_finish(
            &AttachmentUploadFinishParams {
                upload_id: started.upload_id,
            },
            &mut staged,
        )
        .unwrap();
        let path = PathBuf::from(saved.path);
        assert!(staged.contains(&path));
        assert_eq!(std::fs::read(path).unwrap(), payload);
    }

    #[test]
    fn incomplete_chunked_attachment_is_removed_on_finish() {
        let mut staged = AttachmentDirectories::default();
        let started = attachment_upload_start(
            "incomplete-attachment-session",
            &AttachmentUploadStartParams {
                filename: "partial.bin".into(),
                size: 8,
            },
            &mut staged,
        )
        .unwrap();
        let directory = staged.pending_uploads[&started.upload_id].directory.clone();
        attachment_upload_chunk(
            &AttachmentUploadChunkParams {
                upload_id: started.upload_id.clone(),
                index: 0,
                content_base64: base64::engine::general_purpose::STANDARD.encode(b"half"),
            },
            &mut staged,
        )
        .unwrap();
        let error = attachment_upload_finish(
            &AttachmentUploadFinishParams {
                upload_id: started.upload_id,
            },
            &mut staged,
        )
        .unwrap_err();
        assert!(error.to_string().contains("does not match"));
        assert!(!directory.exists());
    }

    #[test]
    fn private_create_is_exclusive_and_uses_restrictive_unix_modes() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("private");
        create_private_directory(&directory).unwrap();
        let path = directory.join("note.txt");
        write_private_attachment(&path, b"first").unwrap();
        assert!(write_private_attachment(&path, b"second").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"first");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn staged_attachment_symlink_replacement_is_not_followed() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("staged");
        create_private_directory(&directory).unwrap();
        let staged_path = directory.join("note.txt");
        write_private_attachment(&staged_path, b"original").unwrap();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, b"outside").unwrap();
        std::fs::remove_file(&staged_path).unwrap();
        symlink(&outside, &staged_path).unwrap();

        assert!(read_private_staged_attachment(&staged_path).is_err());
        assert!(write_private_attachment(&staged_path, b"replacement").is_err());
        assert_eq!(std::fs::read(outside).unwrap(), b"outside");
    }

    #[cfg(windows)]
    #[test]
    fn windows_reparse_replacement_fails_materialization_without_reading_outside() {
        use std::os::windows::fs::symlink_file;

        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("staged");
        create_private_directory(&directory).unwrap();
        let staged_path = directory.join("note.txt");
        write_private_attachment(&staged_path, b"original").unwrap();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, b"outside").unwrap();
        std::fs::remove_file(&staged_path).unwrap();
        symlink_file(&outside, &staged_path).unwrap();
        let mut staged = AttachmentDirectories::default();
        staged.track(staged_path.clone());
        let prompt = attachment_prompt(&[record(&staged_path, "note.txt")]);

        assert!(
            materialize_turn_attachments_in_root(
                &root.path().join("durable"),
                "thread",
                "turn",
                &prompt,
                &mut staged,
            )
            .is_err()
        );
        assert_eq!(std::fs::read(outside).unwrap(), b"outside");
        assert!(staged.contains(&staged_path));
    }

    #[test]
    fn staged_attachment_cannot_be_consumed_twice() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("staged");
        create_private_directory(&directory).unwrap();
        let path = directory.join("note.txt");
        write_private_attachment(&path, b"secret").unwrap();
        let mut staged = AttachmentDirectories::default();
        staged.track(path.clone());

        staged.consume(&path).unwrap();
        assert!(staged.consume(&path).is_err());
        assert!(!directory.exists());
    }

    #[test]
    fn materialization_rejects_duplicate_staged_paths_without_consuming_source() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("staged");
        create_private_directory(&directory).unwrap();
        let path = directory.join("note.txt");
        write_private_attachment(&path, b"secret").unwrap();
        let mut staged = AttachmentDirectories::default();
        staged.track(path.clone());
        let prompt = attachment_prompt(&[record(&path, "note.txt"), record(&path, "note.txt")]);

        let error = materialize_turn_attachments_in_root(
            &root.path().join("durable"),
            "thread",
            "turn",
            &prompt,
            &mut staged,
        )
        .unwrap_err();
        assert!(error.to_string().contains("same staged path"));
        assert!(path.exists());
        assert!(staged.contains(&path));
    }

    #[test]
    fn partial_materialization_rolls_back_and_can_retry_sources() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("staged");
        create_private_directory(&directory).unwrap();
        let first = directory.join("first.txt");
        let second = directory.join("second.txt");
        write_private_attachment(&first, b"first").unwrap();
        std::fs::create_dir(&second).unwrap();
        let mut staged = AttachmentDirectories::default();
        staged.track(first.clone());
        staged.track(second.clone());
        let durable = root.path().join("durable");
        let prompt =
            attachment_prompt(&[record(&first, "first.txt"), record(&second, "second.txt")]);

        assert!(
            materialize_turn_attachments_in_root(&durable, "thread", "turn", &prompt, &mut staged,)
                .is_err()
        );
        assert!(first.exists());
        assert!(second.exists());
        assert!(staged.contains(&first));
        assert!(staged.contains(&second));
        assert_eq!(std::fs::read_dir(&durable).unwrap().count(), 0);

        std::fs::remove_dir(&second).unwrap();
        write_private_attachment(&second, b"second").unwrap();
        let rewritten =
            materialize_turn_attachments_in_root(&durable, "thread", "turn", &prompt, &mut staged)
                .unwrap();
        assert_ne!(rewritten, prompt);
        assert!(!directory.exists());
        assert_eq!(std::fs::read_dir(&durable).unwrap().count(), 1);
    }

    #[test]
    fn materialized_image_attachment_becomes_a_model_image_block() {
        let root = tempfile::tempdir().unwrap();
        let staged_directory = root.path().join("staged");
        create_private_directory(&staged_directory).unwrap();
        let path = staged_directory.join("photo.png");
        let image_bytes = b"image bytes";
        write_private_attachment(&path, image_bytes).unwrap();
        let mut staged = AttachmentDirectories::default();
        staged.track(path.clone());
        let prompt = attachment_prompt(&[serde_json::json!({
            "path": path,
            "filename": "photo.png",
            "mimeType": "image/png"
        })]);
        let rewritten = materialize_turn_attachments_in_root(
            &root.path().join("durable"),
            "thread",
            "turn",
            &prompt,
            &mut staged,
        )
        .unwrap();

        let message = model_message_from_materialized_prompt(&rewritten)
            .unwrap()
            .expect("image attachment should produce structured model content");
        let Message::User { content, .. } = message else {
            panic!("attachment model message must be a user message");
        };
        assert!(content.iter().any(|block| matches!(
            block,
            ContentBlock::Image { source } if source.media_type == "image/png"
                && source.data == base64::engine::general_purpose::STANDARD.encode(image_bytes)
        )));
    }

    #[test]
    fn fork_rejects_canonical_attachment_escape() {
        let root = tempfile::tempdir().unwrap();
        let source_root = root.path().join("source");
        let destination = root.path().join("destination");
        create_private_directory(&source_root).unwrap();
        create_private_directory(&destination).unwrap();
        let source_root = std::fs::canonicalize(source_root).unwrap();
        let outside = root.path().join("outside.txt");
        std::fs::write(&outside, b"outside").unwrap();
        let prompt = attachment_prompt(&[record(&outside, "outside.txt")]);

        let error = clone_attachment_paths_in_prompt(
            &prompt,
            &source_root,
            &destination,
            &mut HashMap::new(),
            &mut 0,
        )
        .unwrap_err();
        assert!(error.to_string().contains("escapes its source thread"));
        assert_eq!(std::fs::read(outside).unwrap(), b"outside");
    }

    #[test]
    fn private_attachment_range_reads_exact_bounded_chunks() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("large.bin");
        let payload = (0..(MAX_ATTACHMENT_CHUNK_BYTES + 37))
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        write_private_attachment(&path, &payload).unwrap();

        let (first, total) =
            read_private_staged_attachment_range(&path, 0, MAX_ATTACHMENT_CHUNK_BYTES).unwrap();
        let (last, last_total) = read_private_staged_attachment_range(
            &path,
            MAX_ATTACHMENT_CHUNK_BYTES as u64,
            MAX_ATTACHMENT_CHUNK_BYTES,
        )
        .unwrap();
        assert_eq!(total, payload.len() as u64);
        assert_eq!(last_total, total);
        assert_eq!(first, payload[..MAX_ATTACHMENT_CHUNK_BYTES]);
        assert_eq!(last, payload[MAX_ATTACHMENT_CHUNK_BYTES..]);
        assert!(read_private_staged_attachment_range(&path, total + 1, 1).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn private_attachment_reads_long_dos_paths_without_following_the_leaf() {
        let root = tempfile::tempdir().unwrap();
        let directory = root
            .path()
            .join("a".repeat(100))
            .join("b".repeat(100))
            .join("c".repeat(80));
        ensure_private_artifact_directory(&directory).unwrap();
        let path = directory.join("image.png");
        write_private_artifact_file(&path, b"image fixture").unwrap();
        let ordinary = PathBuf::from(path.to_string_lossy().trim_start_matches(r"\\?\"));
        assert!(ordinary.as_os_str().len() > 260);
        assert_eq!(
            read_private_staged_attachment(&ordinary).unwrap(),
            b"image fixture"
        );
        assert!(read_private_staged_attachment(&directory).is_err());
    }

    #[test]
    fn attachment_directory_guard_and_ttl_scavenger_remove_staged_data() {
        let root = tempfile::tempdir().unwrap();
        let mut first = AttachmentDirectories {
            directories: HashSet::new(),
            staged_files: HashSet::new(),
            persisted_aliases: HashMap::new(),
            pending_uploads: HashMap::new(),
            owner: Some(create_attachment_owner_lease_in(root.path()).unwrap()),
        };
        let mut second = AttachmentDirectories {
            directories: HashSet::new(),
            staged_files: HashSet::new(),
            persisted_aliases: HashMap::new(),
            pending_uploads: HashMap::new(),
            owner: Some(create_attachment_owner_lease_in(root.path()).unwrap()),
        };
        let first_owner = first.owner_directory().unwrap().to_path_buf();
        let second_owner = second.owner_directory().unwrap().to_path_buf();
        std::fs::write(first_owner.join("active.txt"), "first").unwrap();
        std::fs::write(second_owner.join("active.txt"), "second").unwrap();

        let stale_name = "kcoder-studio-attachment-owner-abandoned";
        let stale = root.path().join(stale_name);
        let stale_lease = root.path().join(format!("{stale_name}.lease"));
        let unrelated = root.path().join("other-data");
        for directory in [&stale, &unrelated] {
            std::fs::create_dir(directory).unwrap();
        }
        std::fs::write(&stale_lease, "abandoned").unwrap();
        std::fs::write(stale.join("note.txt"), "stale").unwrap();

        let future = SystemTime::now() + ATTACHMENT_TTL + Duration::from_secs(1);
        scavenge_stale_attachment_directories(root.path(), future, ATTACHMENT_TTL).unwrap();
        assert!(!stale.exists());
        assert!(!stale_lease.exists());
        assert!(first_owner.exists());
        assert!(second_owner.exists());
        assert!(unrelated.exists());

        drop(first);
        assert!(!first_owner.exists());
        assert!(second_owner.exists());
        drop(second);
        assert!(!second_owner.exists());
    }
}
