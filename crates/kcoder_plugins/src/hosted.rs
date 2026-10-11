//! Official hosted catalogs. Downloading a catalog never executes plugin code.
use crate::materialize::{MaterializedPlugin, download_https};
use crate::{InstallLimits, InstalledPluginSource, PluginCancellationToken, PluginId};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Cursor, Read, Write},
    path::{Component, Path},
    time::Instant,
};

mod qoder;
pub(crate) mod trae;
pub(crate) mod workbuddy;

pub(crate) const QODER_URL: &str = "https://qoder.com/marketplace";
pub(crate) fn is_catalog(url: &str) -> bool {
    url.trim_end_matches('/') == QODER_URL || trae::is_catalog(url) || workbuddy::is_catalog(url)
}
pub(crate) fn validate_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)),
        "invalid hosted plugin id"
    );
    Ok(())
}
pub(crate) fn plugin_name(name: &str) -> Result<String> {
    let name = name.to_ascii_lowercase().replace('_', "-");
    PluginId::new(&name, "qoder")?;
    Ok(name)
}

pub(crate) fn catalog(
    source: &str,
    limits: InstallLimits,
    proxy: Option<&str>,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<MaterializedPlugin> {
    if workbuddy::is_catalog(source) {
        return workbuddy::catalog(source, limits, proxy, deadline, cancel);
    }
    if trae::is_catalog(source) {
        return trae::catalog(proxy, deadline, cancel);
    }
    ensure!(
        source.trim_end_matches('/') == QODER_URL,
        "unsupported hosted catalog"
    );
    let temp = kcoder_config::create_private_temp_dir("kcoder-qoder-catalog")?;
    let mut entries = Vec::new();
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut complete = false;
    for page in 1..=50 {
        cancel.check()?;
        let url = format!(
            "https://qoder.com/apphub/api/v1/marketplace/catalog/extensions?extension_types=plugin&pagination.current_page={page}&pagination.page_size=100"
        );
        let value: Value = serde_json::from_slice(&download_https(
            &url,
            proxy,
            4 * 1024 * 1024,
            deadline,
            cancel,
        )?)?;
        let catalog = value
            .get("plugins")
            .context("Qoder catalog response is missing plugins")?;
        let items = catalog["items"]
            .as_array()
            .context("Qoder catalog is missing items")?;
        let current = catalog["pages"]["current_page"]
            .as_u64()
            .context("Qoder catalog is missing pagination")?;
        let last = catalog["pages"]["last_page"]
            .as_u64()
            .context("Qoder catalog is missing last_page")?;
        ensure!(current == page, "Qoder returned an unexpected page");
        for item in items {
            let id = required(item, "plugin_id")?;
            validate_id(id)?;
            ensure!(
                ids.insert(id.to_owned()),
                "Qoder catalog repeated plugin id"
            );
            let name = plugin_name(required(item, "plugin_name")?)?;
            ensure!(
                names.insert(name.clone()),
                "Qoder catalog contains ambiguous plugin names"
            );
            entries.push(json!({"name": name, "source": {"source":"qoder", "id":id},
                "displayName":item["display_name"], "description":item["description"],
                "displayNameZh":item["display_name_cn"], "descriptionZh":item["description_cn"],
                "interface": {"logo":item["icon_url"]}, "category":item["category"]}));
        }
        if page >= last {
            complete = true;
            break;
        }
        ensure!(
            !items.is_empty(),
            "Qoder catalog ended before its final page"
        );
    }
    ensure!(
        complete && !entries.is_empty(),
        "Qoder catalog is empty or exceeds pagination limit"
    );
    let manifest = json!({"name":"qoder", "interface":{"displayName":"Qoder"},"plugins":entries});
    let bytes = serde_json::to_vec(&manifest)?;
    ensure!(
        bytes.len() <= 1024 * 1024,
        "Qoder catalog exceeds manifest limit"
    );
    fs::create_dir(temp.path().join(".agents"))?;
    fs::create_dir(temp.path().join(".agents/plugins"))?;
    fs::write(temp.path().join(".agents/plugins/marketplace.json"), &bytes)?;
    Ok(MaterializedPlugin {
        root: temp.path().to_path_buf(),
        _temporary: temp,
        evidence: InstalledPluginSource::Hosted {
            url: QODER_URL.into(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        },
    })
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .with_context(|| format!("hosted marketplace response missing {key}"))
}

pub(crate) fn install(
    id: &str,
    expected_name: &str,
    limits: InstallLimits,
    proxy: Option<&str>,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<MaterializedPlugin> {
    validate_id(id)?;
    let detail_url = format!("https://qoder.com/apphub/api/v1/marketplace/plugins/{id}/detail");
    let detail: Value = serde_json::from_slice(&download_https(
        &detail_url,
        proxy,
        4 * 1024 * 1024,
        deadline,
        cancel,
    )?)?;
    ensure!(
        required(&detail, "plugin_id")? == id
            && plugin_name(required(&detail, "plugin_name")?)? == expected_name,
        "Qoder plugin identity changed; refresh the catalog"
    );
    let download = required(&detail, "download_url")?;
    let url = qoder::package_url(download)?;
    let digest = required(&detail, "file_hash")?;
    ensure!(
        digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()),
        "Qoder package has no valid SHA-256 digest"
    );
    let bytes = download_https(
        url.as_str(),
        proxy,
        limits.max_total_bytes,
        deadline,
        cancel,
    )?;
    ensure!(
        format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(digest),
        "Qoder package SHA-256 mismatch"
    );
    let temp = kcoder_config::create_private_temp_dir("kcoder-qoder-package")?;
    extract(&bytes, temp.path(), limits, deadline, cancel)?;
    let root = qoder::package_root(&detail, temp.path(), limits, deadline, cancel)?;
    // Select the Qoder manifest even when the archive contains other vendor manifests.
    // Discovery follows verified archive extraction; identity is checked again below.
    fs::write(
        root.join(".kcoder-marketplace-manifest"),
        ".qoder-plugin/plugin.json",
    )?;
    let manifest =
        crate::load_plugin_manifest(&root)?.context("Qoder package has no supported manifest")?;
    ensure!(
        plugin_name(&manifest.manifest.name)? == expected_name,
        "Qoder package manifest identity does not match the catalog; refresh the catalog"
    );
    Ok(MaterializedPlugin {
        root,
        _temporary: temp,
        evidence: InstalledPluginSource::Hosted {
            url: detail_url,
            sha256: digest.to_ascii_lowercase(),
        },
    })
}
pub(crate) fn safe_relative(value: &str) -> Result<&Path> {
    let value = value.trim_start_matches("./");
    let path = Path::new(value);
    ensure!(
        !value.is_empty()
            && !value.contains(['\\', ':', '\0'])
            && !path.is_absolute()
            && path.components().all(|c| matches!(c, Component::Normal(_))),
        "unsafe ZIP path"
    );
    // Windows treats trailing dots/spaces and device names specially.
    for part in value.split('/') {
        let stem = part
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        let port = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"));
        let reserved_port = port.is_some_and(|suffix| {
            matches!(
                suffix,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
        ensure!(
            !part.ends_with(['.', ' '])
                && !matches!(
                    stem.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                )
                && !reserved_port,
            "unsafe ZIP filename"
        );
    }
    Ok(path)
}
fn extract(
    bytes: &[u8],
    root: &Path,
    limits: InstallLimits,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<()> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
    ensure!(zip.len() <= limits.max_files, "ZIP has too many entries");
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        cancel.check()?;
        ensure!(Instant::now() < deadline, "plugin extraction timed out");
        let mut entry = zip.by_index(i)?;
        // Some publishers store UTF-8 names without ZIP's UTF-8 flag. Prefer
        // valid UTF-8 bytes; legacy non-UTF-8 names retain zip's decoder.
        let name = std::str::from_utf8(entry.name_raw())
            .unwrap_or(entry.name())
            .trim_end_matches('/')
            .to_owned();
        if name == "." && entry.is_dir() {
            let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
            ensure!(
                kind == 0 || kind == 0o040000,
                "ZIP symlinks and special files are forbidden"
            );
            continue;
        }
        let relative = safe_relative(&name)?;
        ensure!(
            name.len() <= limits.max_path_bytes
                && relative.components().count() <= limits.max_depth,
            "ZIP path exceeds limits"
        );
        ensure!(
            seen.insert(relative.to_string_lossy().to_lowercase()),
            "ZIP contains colliding paths"
        );
        let kind = entry.unix_mode().unwrap_or(0) & 0o170000;
        ensure!(
            kind == 0 || kind == 0o100000 || (kind == 0o040000 && entry.is_dir()),
            "ZIP symlinks and special files are forbidden"
        );
        let destination = root.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(destination)?;
            continue;
        }
        ensure!(
            entry.size() <= limits.max_file_bytes
                && entry.size() <= entry.compressed_size().max(1).saturating_mul(200),
            "ZIP entry exceeds limits"
        );
        fs::create_dir_all(destination.parent().unwrap())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)?;
        let mut count = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            cancel.check()?;
            ensure!(Instant::now() < deadline, "plugin extraction timed out");
            let n = entry.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            count += n as u64;
            total += n as u64;
            ensure!(
                count <= limits.max_file_bytes && total <= limits.max_total_bytes,
                "ZIP exceeds extracted byte limits"
            );
            output.write_all(&buffer[..n])?;
        }
        ensure!(count == entry.size(), "ZIP entry size mismatch");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                destination,
                fs::Permissions::from_mode(if entry.unix_mode().unwrap_or(0) & 0o111 != 0 {
                    0o700
                } else {
                    0o600
                }),
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    #[test]
    fn archives_are_bounded_and_do_not_escape_or_overwrite() {
        let temp = tempfile::tempdir().unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let cancel = PluginCancellationToken::default();
        let valid = archive(&[("demo/skills/x/SKILL.md", b"hello")]);
        extract(
            &valid,
            temp.path(),
            InstallLimits::default(),
            deadline,
            &cancel,
        )
        .unwrap();
        assert_eq!(
            fs::read(temp.path().join("demo/skills/x/SKILL.md")).unwrap(),
            b"hello"
        );
        assert!(
            extract(
                &valid,
                temp.path(),
                InstallLimits::default(),
                deadline,
                &cancel
            )
            .is_err()
        );
        for path in [
            "../escape",
            "/absolute",
            "C:/drive",
            "x\\escape",
            "NUL.txt",
            "x. ",
        ] {
            assert!(safe_relative(path).is_err(), "{path}");
        }
        for bytes in [
            archive(&[("a", b"1234")]),
            archive(&[("a", b"a"), ("A", b"b")]),
        ] {
            let target = tempfile::tempdir().unwrap();
            assert!(
                extract(
                    &bytes,
                    target.path(),
                    InstallLimits {
                        max_file_bytes: 3,
                        ..Default::default()
                    },
                    deadline,
                    &cancel
                )
                .is_err()
            );
        }
        let cancelled = PluginCancellationToken::default();
        cancelled.cancel();
        assert!(
            extract(
                &valid,
                temp.path(),
                InstallLimits::default(),
                deadline,
                &cancelled
            )
            .is_err()
        );
    }
    #[test]
    fn zip_dot_prefixes_and_unflagged_utf8_names_remain_contained() {
        let temp = tempfile::tempdir().unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let cancel = PluginCancellationToken::default();
        let mut bytes = archive(&[("./企业财税/.qoder-plugin/plugin.json", b"{}")]);
        // Clear UTF-8 bit in local and central headers, as in the real package.
        for offset in 0..bytes.len().saturating_sub(10) {
            let flag = if bytes[offset..].starts_with(b"PK\x03\x04") {
                Some(offset + 6)
            } else if bytes[offset..].starts_with(b"PK\x01\x02") {
                Some(offset + 8)
            } else {
                None
            };
            if let Some(flag) = flag {
                bytes[flag + 1] &= !8;
            }
        }
        extract(
            &bytes,
            temp.path(),
            InstallLimits::default(),
            deadline,
            &cancel,
        )
        .unwrap();
        assert!(
            temp.path()
                .join("企业财税/.qoder-plugin/plugin.json")
                .is_file()
        );
        for entries in [
            vec![("./a", b"x".as_slice()), ("a", b"y".as_slice())],
            vec![("./../escape", b"x".as_slice())],
        ] {
            let target = tempfile::tempdir().unwrap();
            assert!(
                extract(
                    &archive(&entries),
                    target.path(),
                    InstallLimits::default(),
                    deadline,
                    &cancel
                )
                .is_err()
            );
        }
    }

    #[test]
    fn rejects_symlinks_and_invalid_catalog_ids() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .add_symlink(
                "link",
                "../../escape",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let temp = tempfile::tempdir().unwrap();
        assert!(
            extract(
                &bytes,
                temp.path(),
                InstallLimits::default(),
                Instant::now() + std::time::Duration::from_secs(2),
                &PluginCancellationToken::default()
            )
            .is_err()
        );
        for id in ["../secret", "x?token=y", "", "a/b"] {
            assert!(validate_id(id).is_err());
        }
        assert_eq!(plugin_name("Presentations").unwrap(), "presentations");
    }
}
