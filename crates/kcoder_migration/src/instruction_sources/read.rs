//! Relative observations remain pinned to the explicitly granted root, including absent inputs.
use super::{grant::RootBinding, model::*};
use anyhow::{Result, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use kcoder_config::{PortableLeaseIdentity, PrivateDirectory};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, ffi::OsStr, io::Read};
use zeroize::Zeroizing;

pub(super) fn open_directory(
    binding: &RootBinding,
    relative: &str,
    observations: &mut BTreeMap<String, DirectoryObservation>,
) -> Result<Option<PrivateDirectory>> {
    binding.verify()?;
    let parts = parts(relative)?;
    let mut directory = PrivateDirectory::open_existing(binding.root())
        .map_err(|_| anyhow::anyhow!("migration_instruction_source_changed"))?;
    let mut current = String::new();
    remember_directory(observations, "", Some(directory.directory_identity()?))?;
    for part in parts {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        match directory.open_child(OsStr::new(part), false) {
            Ok(child) => {
                child
                    .verify_trusted_config_directory()
                    .map_err(|_| anyhow::anyhow!("migration_instruction_source_unsafe"))?;
                remember_directory(observations, &current, Some(child.directory_identity()?))?;
                directory = child;
            }
            Err(error) if missing(&error) => {
                remember_directory(observations, &current, None)?;
                binding.verify()?;
                return Ok(None);
            }
            Err(_) => anyhow::bail!("migration_instruction_source_unsafe"),
        }
    }
    binding.verify()?;
    Ok(Some(directory))
}
fn remember_directory(
    observations: &mut BTreeMap<String, DirectoryObservation>,
    relative: &str,
    identity: Option<String>,
) -> Result<()> {
    let observed = DirectoryObservation {
        relative: relative.into(),
        identity,
    };
    if let Some(previous) = observations.get(relative) {
        ensure!(
            previous == &observed,
            "migration_instruction_source_changed"
        );
    } else {
        let bytes = observations
            .iter()
            .map(|(key, value)| {
                key.len()
                    + value.relative.len()
                    + value.identity.as_ref().map_or(0, String::len)
                    + 96
            })
            .sum::<usize>();
        ensure!(
            observations.len() < MAX_DIRECTORIES
                && bytes.saturating_add(
                    2 * relative.len() + observed.identity.as_ref().map_or(0, String::len) + 96
                ) <= MAX_METADATA_BYTES,
            "migration_instruction_source_budget_exceeded"
        );
        observations.insert(relative.into(), observed);
    }
    Ok(())
}
pub(super) fn read(
    binding: &RootBinding,
    relative: &str,
    directories: &mut BTreeMap<String, DirectoryObservation>,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<(FileObservation, Option<EncodedSource>)> {
    let (parent, name) = split(relative)?;
    validate_leaf(name)?;
    let absent = || FileObservation {
        relative: relative.into(),
        identity: None,
        bytes: 0,
        sha256: None,
    };
    let Some(directory) = open_directory(binding, parent, directories)? else {
        return Ok((absent(), None));
    };
    let mut file = match directory.open_single_link_regular_file(OsStr::new(name)) {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok((absent(), None)),
        Err(_) => anyhow::bail!("migration_instruction_source_unsafe"),
    };
    let identity = PortableLeaseIdentity::from_regular_handle(&file)?;
    let before = file.metadata()?;
    ensure!(
        before.len() <= MAX_FILE_BYTES as u64,
        "migration_instruction_source_budget_exceeded"
    );
    let mut bytes = Zeroizing::new(Vec::new());
    let mut buffer = [0; 32 * 1024];
    loop {
        ensure!(check(bytes.len() as u64), "migration_cancelled");
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        ensure!(
            bytes.len() + count <= MAX_FILE_BYTES,
            "migration_instruction_source_budget_exceeded"
        );
        bytes.extend_from_slice(&buffer[..count]);
    }
    let after = file.metadata()?;
    ensure!(
        before.len() == after.len()
            && after.len() == bytes.len() as u64
            && before.modified().ok() == after.modified().ok(),
        "migration_instruction_source_changed"
    );
    let digest = sha(&bytes);
    // The second bounded pass also checks hosts without a usable modification timestamp.
    let mut current = directory
        .open_single_link_regular_file(OsStr::new(name))
        .map_err(|_| anyhow::anyhow!("migration_instruction_source_changed"))?;
    ensure!(
        PortableLeaseIdentity::from_regular_handle(&current)? == identity,
        "migration_instruction_source_changed"
    );
    let mut hash = Sha256::new();
    let mut total = 0u64;
    loop {
        ensure!(check(total), "migration_cancelled");
        let count = current.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        ensure!(
            total <= MAX_FILE_BYTES as u64,
            "migration_instruction_source_changed"
        );
        hash.update(&buffer[..count]);
    }
    ensure!(
        total == bytes.len() as u64 && format!("{:x}", hash.finalize()) == digest,
        "migration_instruction_source_changed"
    );
    let final_parent = open_directory(binding, parent, &mut BTreeMap::new())?
        .ok_or_else(|| anyhow::anyhow!("migration_instruction_source_changed"))?;
    ensure!(
        final_parent.directory_identity()? == directory.directory_identity()?
            && PortableLeaseIdentity::from_regular_handle(
                &final_parent.open_single_link_regular_file(OsStr::new(name))?
            )? == identity,
        "migration_instruction_source_changed"
    );
    binding.verify()?;
    Ok((
        FileObservation {
            relative: relative.into(),
            identity: Some(identity),
            bytes: total,
            sha256: Some(digest),
        },
        Some(EncodedSource {
            relative: relative.into(),
            data: STANDARD.encode(&bytes),
        }),
    ))
}
pub(super) fn parts(relative: &str) -> Result<Vec<&str>> {
    ensure!(
        relative.len() <= 4096
            && !relative.contains(['\\', ':'])
            && !relative.chars().any(char::is_control),
        "migration_instruction_path_outside_grant"
    );
    let parts = if relative.is_empty() {
        Vec::new()
    } else {
        relative.split('/').collect::<Vec<_>>()
    };
    ensure!(
        parts.len() <= 64
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.len() <= 256 && !matches!(*part, "." | "..")),
        "migration_instruction_path_budget_exceeded"
    );
    Ok(parts)
}
fn split(relative: &str) -> Result<(&str, &str)> {
    let parts = parts(relative)?;
    ensure!(
        !parts.is_empty(),
        "migration_instruction_path_outside_grant"
    );
    Ok(relative.rsplit_once('/').unwrap_or(("", relative)))
}
pub(super) fn missing(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)
    })
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn marker(
    binding: &RootBinding,
    parent: &str,
    name: &str,
    directories: &mut BTreeMap<String, DirectoryObservation>,
) -> Result<MarkerObservation> {
    validate_leaf(name)?;
    let relative = if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    };
    let Some(directory) = open_directory(binding, parent, directories)? else {
        return Ok(MarkerObservation {
            relative,
            identity: None,
        });
    };
    let identity = match directory.entry_metadata(OsStr::new(name)) {
        Err(error) if missing(&error) => None,
        Err(_) => anyhow::bail!("migration_instruction_source_unsafe"),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            anyhow::bail!("migration_instruction_source_unsafe")
        }
        Ok(metadata) if metadata.is_dir() => Some(format!(
            "directory:{}",
            directory
                .open_child(OsStr::new(name), false)?
                .directory_identity()?
        )),
        Ok(metadata) if metadata.is_file() => {
            let file = directory.open_single_link_regular_file(OsStr::new(name))?;
            Some(format!(
                "file:{:x}",
                Sha256::digest(serde_json::to_vec(
                    &PortableLeaseIdentity::from_regular_handle(&file)?
                )?)
            ))
        }
        _ => anyhow::bail!("migration_instruction_source_unsafe"),
    };
    binding.verify()?;
    Ok(MarkerObservation { relative, identity })
}
