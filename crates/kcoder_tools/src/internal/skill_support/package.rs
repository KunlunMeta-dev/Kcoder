//! Read source packages before the tool applies policy and installs them.

use crate::SkillSupportError;
use flate2::read::{DeflateDecoder, GzDecoder};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

pub const MAX_HUB_SKILL_BYTES: usize = 256 * 1024;
const MAX_SUPPORTING_FILE_BYTES: usize = 1_048_576;
const MAX_SUPPORTING_TOTAL_BYTES: usize = 5 * 1_048_576;
const SUPPORTING_DIRS: &[&str] = &["references", "templates", "scripts", "assets"];
const ROOT_SUPPORT_FILES: &[&str] = &[
    "LICENSE",
    "LICENSE.txt",
    "LICENSE.md",
    "NOTICE",
    "NOTICE.txt",
    "NOTICE.md",
    "COPYING",
    "COPYING.txt",
    "COPYING.md",
];

#[derive(Debug, Clone)]
pub struct FetchedSkill {
    pub content: String,
    pub support_files: Vec<SupportFile>,
}

#[derive(Debug, Clone)]
pub struct SupportFile {
    pub relative_path: PathBuf,
    pub bytes: Vec<u8>,
}

pub async fn fetch_skill_package(
    url: &str,
    archive_root: Option<&Path>,
) -> Result<FetchedSkill, SkillSupportError> {
    // On Windows, URL parsers interpret an absolute path such as `C:\\skills\\foo`
    // as a URL with the one-letter scheme `c`. Resolve filesystem-looking inputs
    // before attempting URL parsing so native drive paths remain usable.
    let local_path = Path::new(url);
    if local_path.is_absolute() || local_path.exists() {
        return read_local_skill_package(local_path, archive_root);
    }
    let parsed = match reqwest::Url::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => return read_local_skill_package(Path::new(url), archive_root),
    };
    if parsed.scheme() == "file" {
        let path = parsed.to_file_path().map_err(|_| {
            SkillSupportError::InvalidInput("invalid file:// skill URL".to_string())
        })?;
        return read_local_skill_package(&path, archive_root);
    }
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err(SkillSupportError::InvalidInput(
            "url must use http, https, file, or a local path".to_string(),
        ));
    }
    let parsed_path = parsed.path().to_string();
    let is_archive = is_archive_location(&parsed_path);
    let response = if is_loopback_url(&parsed) {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .map_err(|e| {
                SkillSupportError::Execution(format!("failed to build skill fetch client: {e}"))
            })?
            .get(parsed.clone())
            .send()
            .await
    } else {
        reqwest::get(parsed).await
    }
    .map_err(|e| SkillSupportError::Execution(format!("failed to fetch skill: {e}")))?;
    if !response.status().is_success() {
        return Err(SkillSupportError::Execution(format!(
            "failed to fetch skill: HTTP {}",
            response.status()
        )));
    }
    if is_archive {
        let bytes = response.bytes().await.map_err(|e| {
            SkillSupportError::Execution(format!("failed to read skill archive: {e}"))
        })?;
        read_archive_skill_package(&parsed_path, &bytes, archive_root)
    } else {
        let content = response.text().await.map_err(|e| {
            SkillSupportError::Execution(format!("failed to read skill response: {e}"))
        })?;
        Ok(FetchedSkill {
            content,
            support_files: Vec::new(),
        })
    }
}

fn read_local_skill_package(
    path: &Path,
    archive_root: Option<&Path>,
) -> Result<FetchedSkill, SkillSupportError> {
    if path.is_dir() {
        let skill_path = path.join("SKILL.md");
        let content = std::fs::read_to_string(&skill_path).map_err(|e| {
            SkillSupportError::Execution(format!(
                "failed to read local skill {:?}: {e}",
                skill_path
            ))
        })?;
        return Ok(FetchedSkill {
            content,
            support_files: collect_support_files(path)?,
        });
    }
    if is_archive_location(&path.display().to_string()) {
        let bytes = std::fs::read(path).map_err(|e| {
            SkillSupportError::Execution(format!(
                "failed to read local skill archive {:?}: {e}",
                path
            ))
        })?;
        return read_archive_skill_package(&path.display().to_string(), &bytes, archive_root);
    }
    let content = std::fs::read_to_string(path).map_err(|e| {
        SkillSupportError::Execution(format!("failed to read local skill {:?}: {e}", path))
    })?;
    Ok(FetchedSkill {
        content,
        support_files: Vec::new(),
    })
}

fn is_archive_location(location: &str) -> bool {
    let lower = location.to_ascii_lowercase();
    lower.ends_with(".tar.gz")
        || lower.ends_with(".tgz")
        || lower.ends_with(".tar")
        || lower.ends_with(".zip")
}

fn is_loopback_url(url: &reqwest::Url) -> bool {
    url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost") || host == "::1" || host.starts_with("127.")
    })
}

pub fn read_archive_skill_package(
    location: &str,
    bytes: &[u8],
    archive_root: Option<&Path>,
) -> Result<FetchedSkill, SkillSupportError> {
    let lower = location.to_ascii_lowercase();
    if lower.ends_with(".zip") {
        return parse_zip_skill_package(location, bytes, archive_root);
    }
    let tar_bytes = if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let mut decoder = GzDecoder::new(bytes);
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).map_err(|e| {
            SkillSupportError::Execution(format!(
                "failed to decompress skill archive {location}: {e}"
            ))
        })?;
        decoded
    } else {
        bytes.to_vec()
    };
    parse_tar_skill_package(location, &tar_bytes, archive_root)
}

#[derive(Debug)]
struct ArchiveFile {
    path: PathBuf,
    bytes: Vec<u8>,
}

fn parse_tar_skill_package(
    location: &str,
    bytes: &[u8],
    archive_root: Option<&Path>,
) -> Result<FetchedSkill, SkillSupportError> {
    let files = parse_tar_files(location, bytes)?;
    package_from_archive_files(location, files, archive_root)
}

fn parse_zip_skill_package(
    location: &str,
    bytes: &[u8],
    archive_root: Option<&Path>,
) -> Result<FetchedSkill, SkillSupportError> {
    let files = parse_zip_files(location, bytes)?;
    package_from_archive_files(location, files, archive_root)
}

fn package_from_archive_files(
    location: &str,
    files: Vec<ArchiveFile>,
    archive_root: Option<&Path>,
) -> Result<FetchedSkill, SkillSupportError> {
    let skill_entry = if let Some(root) = archive_root {
        let mut suffix = root.to_path_buf();
        suffix.push("SKILL.md");
        files
            .iter()
            .filter(|file| archive_path_ends_with(&file.path, &suffix))
            .min_by_key(|file| file.path.components().count())
            .ok_or_else(|| {
                SkillSupportError::InvalidInput(format!(
                    "skill archive {location} does not contain SKILL.md under {}",
                    root.display()
                ))
            })?
    } else {
        files
            .iter()
            .filter(|file| file.path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md"))
            .min_by_key(|file| file.path.components().count())
            .ok_or_else(|| {
                SkillSupportError::InvalidInput(format!(
                    "skill archive {location} does not contain SKILL.md"
                ))
            })?
    };
    let skill_path = skill_entry.path.clone();
    let root = skill_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let content = std::str::from_utf8(&skill_entry.bytes)
        .map_err(|e| {
            SkillSupportError::InvalidInput(format!("archive SKILL.md is not UTF-8: {e}"))
        })?
        .to_string();
    let mut support_files = Vec::new();
    let mut total_bytes = 0usize;
    for file in files {
        if file.path == skill_path {
            continue;
        }
        let Ok(relative) = file.path.strip_prefix(&root) else {
            continue;
        };
        if relative.components().count() == 0 {
            continue;
        }
        if !is_allowed_support_path(relative) {
            continue;
        }
        validate_support_path(relative)?;
        if file.bytes.len() > MAX_SUPPORTING_FILE_BYTES {
            return Err(SkillSupportError::InvalidInput(format!(
                "supporting file {:?} exceeds {MAX_SUPPORTING_FILE_BYTES} bytes",
                relative
            )));
        }
        total_bytes += file.bytes.len();
        if total_bytes > MAX_SUPPORTING_TOTAL_BYTES {
            return Err(SkillSupportError::InvalidInput(format!(
                "supporting files exceed {MAX_SUPPORTING_TOTAL_BYTES} bytes total"
            )));
        }
        support_files.push(SupportFile {
            relative_path: relative.to_path_buf(),
            bytes: file.bytes,
        });
    }
    support_files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(FetchedSkill {
        content,
        support_files,
    })
}

fn archive_path_ends_with(path: &Path, suffix: &Path) -> bool {
    let path_components = normal_path_components(path);
    let suffix_components = normal_path_components(suffix);
    if suffix_components.is_empty() || path_components.len() < suffix_components.len() {
        return false;
    }
    path_components[path_components.len() - suffix_components.len()..] == suffix_components
}

fn normal_path_components(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str().map(str::to_string),
            _ => None,
        })
        .collect()
}

fn parse_tar_files(location: &str, bytes: &[u8]) -> Result<Vec<ArchiveFile>, SkillSupportError> {
    if !bytes.len().is_multiple_of(512) {
        return Err(SkillSupportError::InvalidInput(format!(
            "skill archive {location} is not a valid tar stream"
        )));
    }
    let mut files = Vec::new();
    let mut offset = 0usize;
    while offset + 512 <= bytes.len() {
        let header = &bytes[offset..offset + 512];
        offset += 512;
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let path = tar_header_path(header)?;
        let size = tar_header_size(header)? as usize;
        let typeflag = header[156];
        if offset + size > bytes.len() {
            return Err(SkillSupportError::InvalidInput(format!(
                "skill archive {location} has a truncated entry {:?}",
                path
            )));
        }
        let data = &bytes[offset..offset + size];
        let padded = size.div_ceil(512) * 512;
        offset = offset.checked_add(padded).ok_or_else(|| {
            SkillSupportError::InvalidInput(format!("skill archive {location} is too large"))
        })?;
        if matches!(typeflag, 0 | b'0') {
            validate_archive_path(&path)?;
            files.push(ArchiveFile {
                path,
                bytes: data.to_vec(),
            });
        }
    }
    Ok(files)
}

fn parse_zip_files(location: &str, bytes: &[u8]) -> Result<Vec<ArchiveFile>, SkillSupportError> {
    let eocd = find_zip_eocd(bytes).ok_or_else(|| {
        SkillSupportError::InvalidInput(format!("skill archive {location} is not a valid zip file"))
    })?;
    let disk = read_zip_u16(bytes, eocd + 4, location)?;
    let central_disk = read_zip_u16(bytes, eocd + 6, location)?;
    let entries_on_disk = read_zip_u16(bytes, eocd + 8, location)?;
    let entries = read_zip_u16(bytes, eocd + 10, location)?;
    if disk != 0 || central_disk != 0 || entries_on_disk != entries {
        return Err(SkillSupportError::InvalidInput(format!(
            "skill archive {location} uses unsupported multi-disk zip layout"
        )));
    }
    let central_size = read_zip_u32(bytes, eocd + 12, location)? as usize;
    let central_offset = read_zip_u32(bytes, eocd + 16, location)? as usize;
    checked_zip_slice(bytes, central_offset, central_size, location)?;

    let mut offset = central_offset;
    let central_end = central_offset + central_size;
    let mut files = Vec::new();
    for _ in 0..entries {
        if offset + 46 > central_end || read_zip_u32(bytes, offset, location)? != 0x0201_4b50 {
            return Err(SkillSupportError::InvalidInput(format!(
                "skill archive {location} has an invalid zip central directory"
            )));
        }
        let flags = read_zip_u16(bytes, offset + 8, location)?;
        if flags & 0x0001 != 0 {
            return Err(SkillSupportError::InvalidInput(format!(
                "skill archive {location} contains encrypted zip entries"
            )));
        }
        let method = read_zip_u16(bytes, offset + 10, location)?;
        let compressed_size = read_zip_u32(bytes, offset + 20, location)?;
        let uncompressed_size = read_zip_u32(bytes, offset + 24, location)?;
        let name_len = read_zip_u16(bytes, offset + 28, location)? as usize;
        let extra_len = read_zip_u16(bytes, offset + 30, location)? as usize;
        let comment_len = read_zip_u16(bytes, offset + 32, location)? as usize;
        let local_offset = read_zip_u32(bytes, offset + 42, location)? as usize;
        if compressed_size == u32::MAX || uncompressed_size == u32::MAX {
            return Err(SkillSupportError::InvalidInput(format!(
                "skill archive {location} uses unsupported zip64 entries"
            )));
        }
        let name_start = offset + 46;
        let name_bytes = checked_zip_slice(bytes, name_start, name_len, location)?;
        let name = std::str::from_utf8(name_bytes).map_err(|e| {
            SkillSupportError::InvalidInput(format!("zip entry path is not UTF-8: {e}"))
        })?;
        offset = name_start
            .checked_add(name_len)
            .and_then(|next| next.checked_add(extra_len))
            .and_then(|next| next.checked_add(comment_len))
            .ok_or_else(|| {
                SkillSupportError::InvalidInput(format!(
                    "skill archive {location} central directory is too large"
                ))
            })?;
        if offset > central_end {
            return Err(SkillSupportError::InvalidInput(format!(
                "skill archive {location} has a truncated zip central directory"
            )));
        }
        if name.ends_with('/') {
            continue;
        }
        let path = PathBuf::from(name);
        validate_archive_path(&path)?;
        let bytes = read_zip_file_data(
            location,
            bytes,
            local_offset,
            method,
            compressed_size as usize,
            uncompressed_size as usize,
        )?;
        files.push(ArchiveFile { path, bytes });
    }
    Ok(files)
}

fn find_zip_eocd(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 22 {
        return None;
    }
    let min = bytes.len().saturating_sub(22 + u16::MAX as usize);
    (min..=bytes.len() - 22)
        .rev()
        .find(|offset| bytes[*offset..].starts_with(&[0x50, 0x4b, 0x05, 0x06]))
}

fn read_zip_file_data(
    location: &str,
    archive: &[u8],
    local_offset: usize,
    method: u16,
    compressed_size: usize,
    uncompressed_size: usize,
) -> Result<Vec<u8>, SkillSupportError> {
    if uncompressed_size > MAX_SUPPORTING_TOTAL_BYTES + MAX_HUB_SKILL_BYTES {
        return Err(SkillSupportError::InvalidInput(format!(
            "zip entry in {location} exceeds supported skill package size"
        )));
    }
    if local_offset + 30 > archive.len()
        || read_zip_u32(archive, local_offset, location)? != 0x0403_4b50
    {
        return Err(SkillSupportError::InvalidInput(format!(
            "skill archive {location} has an invalid zip local header"
        )));
    }
    let name_len = read_zip_u16(archive, local_offset + 26, location)? as usize;
    let extra_len = read_zip_u16(archive, local_offset + 28, location)? as usize;
    let data_start = local_offset
        .checked_add(30)
        .and_then(|next| next.checked_add(name_len))
        .and_then(|next| next.checked_add(extra_len))
        .ok_or_else(|| {
            SkillSupportError::InvalidInput(format!("skill archive {location} is too large"))
        })?;
    let compressed = checked_zip_slice(archive, data_start, compressed_size, location)?;
    match method {
        0 => {
            if compressed.len() != uncompressed_size {
                return Err(SkillSupportError::InvalidInput(format!(
                    "stored zip entry in {location} has inconsistent size"
                )));
            }
            Ok(compressed.to_vec())
        }
        8 => {
            let mut decoder = DeflateDecoder::new(compressed);
            let mut decoded = Vec::new();
            decoder
                .by_ref()
                .take((uncompressed_size + 1) as u64)
                .read_to_end(&mut decoded)
                .map_err(|e| {
                    SkillSupportError::Execution(format!(
                        "failed to decompress zip entry in {location}: {e}"
                    ))
                })?;
            if decoded.len() != uncompressed_size {
                return Err(SkillSupportError::InvalidInput(format!(
                    "deflated zip entry in {location} has inconsistent size"
                )));
            }
            Ok(decoded)
        }
        _ => Err(SkillSupportError::InvalidInput(format!(
            "skill archive {location} uses unsupported zip compression method {method}"
        ))),
    }
}

fn read_zip_u16(bytes: &[u8], offset: usize, location: &str) -> Result<u16, SkillSupportError> {
    let bytes = checked_zip_slice(bytes, offset, 2, location)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_zip_u32(bytes: &[u8], offset: usize, location: &str) -> Result<u32, SkillSupportError> {
    let bytes = checked_zip_slice(bytes, offset, 4, location)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn checked_zip_slice<'a>(
    bytes: &'a [u8],
    offset: usize,
    len: usize,
    location: &str,
) -> Result<&'a [u8], SkillSupportError> {
    let end = offset.checked_add(len).ok_or_else(|| {
        SkillSupportError::InvalidInput(format!("skill archive {location} is too large"))
    })?;
    bytes.get(offset..end).ok_or_else(|| {
        SkillSupportError::InvalidInput(format!(
            "skill archive {location} has a truncated zip entry"
        ))
    })
}

fn tar_header_path(header: &[u8]) -> Result<PathBuf, SkillSupportError> {
    let name = trim_tar_string(&header[0..100]);
    let prefix = trim_tar_string(&header[345..500]);
    let path = if prefix.is_empty() {
        name
    } else if name.is_empty() {
        prefix
    } else {
        format!("{prefix}/{name}")
    };
    if path.is_empty() {
        return Err(SkillSupportError::InvalidInput(
            "tar entry path cannot be empty".to_string(),
        ));
    }
    Ok(PathBuf::from(path))
}

fn tar_header_size(header: &[u8]) -> Result<u64, SkillSupportError> {
    let size = trim_tar_string(&header[124..136]);
    u64::from_str_radix(size.trim(), 8)
        .map_err(|e| SkillSupportError::InvalidInput(format!("invalid tar entry size: {e}")))
}

fn trim_tar_string(bytes: &[u8]) -> String {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).trim().to_string()
}

fn validate_archive_path(path: &Path) -> Result<(), SkillSupportError> {
    if path.is_absolute() {
        return Err(SkillSupportError::InvalidInput(
            "archive paths must be relative".to_string(),
        ));
    }
    if path.to_string_lossy().contains('\\') {
        return Err(SkillSupportError::InvalidInput(
            "archive paths cannot contain backslashes".to_string(),
        ));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(SkillSupportError::InvalidInput(
                "archive paths cannot contain '.', '..', prefixes, or root components".to_string(),
            ));
        }
    }
    Ok(())
}

fn collect_support_files(dir: &Path) -> Result<Vec<SupportFile>, SkillSupportError> {
    let mut files = Vec::new();
    let mut total_bytes = 0usize;
    for entry in WalkDir::new(dir).min_depth(1).follow_links(false) {
        let entry = entry.map_err(|e| {
            SkillSupportError::Execution(format!("failed to walk support files: {e}"))
        })?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(dir).map_err(|e| {
            SkillSupportError::Execution(format!("failed to normalize support path: {e}"))
        })?;
        if !is_allowed_support_path(relative) {
            continue;
        }
        validate_support_path(relative)?;
        let bytes = std::fs::read(entry.path()).map_err(|e| {
            SkillSupportError::Execution(format!(
                "failed to read support file {:?}: {e}",
                entry.path()
            ))
        })?;
        if bytes.len() > MAX_SUPPORTING_FILE_BYTES {
            return Err(SkillSupportError::InvalidInput(format!(
                "supporting file {:?} exceeds {MAX_SUPPORTING_FILE_BYTES} bytes",
                relative
            )));
        }
        total_bytes += bytes.len();
        if total_bytes > MAX_SUPPORTING_TOTAL_BYTES {
            return Err(SkillSupportError::InvalidInput(format!(
                "supporting files exceed {MAX_SUPPORTING_TOTAL_BYTES} bytes total"
            )));
        }
        files.push(SupportFile {
            relative_path: relative.to_path_buf(),
            bytes,
        });
    }
    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

fn validate_support_path(path: &Path) -> Result<(), SkillSupportError> {
    let mut components = path.components();
    let Some(Component::Normal(first)) = components.next() else {
        return Err(SkillSupportError::InvalidInput(
            "supporting file path cannot be empty".to_string(),
        ));
    };
    let Some(first) = first.to_str() else {
        return Err(SkillSupportError::InvalidInput(
            "supporting file path must be UTF-8".to_string(),
        ));
    };
    if ROOT_SUPPORT_FILES.contains(&first) {
        if components.next().is_none() {
            return Ok(());
        }
        return Err(SkillSupportError::InvalidInput(
            "root supporting files cannot contain child paths".to_string(),
        ));
    }
    if !SUPPORTING_DIRS.contains(&first) {
        return Err(SkillSupportError::InvalidInput(format!(
            "supporting file path must be a recognized root legal file or start with one of: {}",
            SUPPORTING_DIRS.join(", "),
        )));
    }
    for component in components {
        if !matches!(component, Component::Normal(_)) {
            return Err(SkillSupportError::InvalidInput(
                "supporting file path cannot contain '.', '..', prefixes, or root components"
                    .to_string(),
            ));
        }
    }
    Ok(())
}

fn is_allowed_support_path(path: &Path) -> bool {
    let components = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>();
    match components.as_slice() {
        [file] => ROOT_SUPPORT_FILES.contains(file),
        [directory, ..] => SUPPORTING_DIRS.contains(directory),
        [] => false,
    }
}
