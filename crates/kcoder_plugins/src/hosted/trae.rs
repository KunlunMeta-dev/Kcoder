//! TRAE CN's public catalog and checksummed plugin packages; no account cookies.
use super::{extract, required, validate_id};
use crate::materialize::{MaterializedPlugin, download_https};
use crate::{InstallLimits, InstalledPluginSource, PluginCancellationToken, PluginId};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

pub(crate) const CATALOG_URL: &str = "https://api.trae.com.cn/extensions/api/-/plugin/list";
pub(crate) const LEGACY_URL: &str = "https://work.trae.cn/marketplace";
pub(crate) fn is_catalog(source: &str) -> bool {
    matches!(source.trim_end_matches('/'), CATALOG_URL | LEGACY_URL)
}
const API: &str = "https://api.trae.com.cn/extensions/api/-/plugin";
const REGISTRY: &str = "trae-remote-official";
const CDN: &str = "p11-market.byteimg.com";

pub(crate) fn validate_version(version: &str) -> Result<()> {
    ensure!(
        !version.is_empty()
            && version.len() <= 128
            && version.as_bytes()[0].is_ascii_alphanumeric()
            && version
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(&c)),
        "invalid TRAE plugin version"
    );
    Ok(())
}
fn data(response: &Value) -> Result<&Value> {
    ensure!(
        response["success"] == true || response["success"] == "true",
        "TRAE marketplace rejected the request"
    );
    response
        .get("data")
        .filter(|v| v.is_object())
        .context("TRAE response is missing data")
}
fn localized(item: &Value, field: &str, language: &str) -> String {
    item.pointer(&format!("/i18n/{field}/{language}"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| item[field].as_str())
        .unwrap_or("")
        .to_owned()
}

pub(crate) fn catalog(
    proxy: Option<&str>,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<MaterializedPlugin> {
    let temp = kcoder_config::create_private_temp_dir("kcoder-trae-catalog")?;
    let mut entries = Vec::new();
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut tokens = BTreeSet::new();
    let mut token = String::new();
    let mut complete = false;
    for _ in 0..50 {
        cancel.check()?;
        let mut url = url::Url::parse(&format!("{API}/list"))?;
        url.query_pairs_mut()
            .append_pair("registry", REGISTRY)
            .append_pair("page_size", "200");
        if !token.is_empty() {
            url.query_pairs_mut().append_pair("page_token", &token);
        }
        let response: Value = serde_json::from_slice(&download_https(
            url.as_str(),
            proxy,
            4 * 1024 * 1024,
            deadline,
            cancel,
        )?)?;
        let data = data(&response)?;
        let items = data["plugins"]
            .as_array()
            .context("TRAE catalog is missing plugins")?;
        for item in items {
            let id = required(item, "plugin_id")?;
            let name = required(item, "origin_plugin_name")?;
            let version = required(item, "version")?;
            validate_id(id)?;
            validate_version(version)?;
            PluginId::new(name, REGISTRY)?;
            ensure!(
                required(item, "registry")? == REGISTRY,
                "TRAE returned an unexpected registry"
            );
            ensure!(
                ids.insert(id.to_owned()) && names.insert(name.to_owned()),
                "TRAE returned duplicate plugin identities"
            );
            entries.push(json!({"name":name,"version":version,
                "source":{"source":"trae","id":id,"version":version},
                "displayName":localized(item,"display_name","en"),
                "displayNameZh":localized(item,"display_name","zh-cn"),
                "description":localized(item,"description","en"),
                "descriptionZh":localized(item,"description","zh-cn"),
                "interface":{"logo":item["icon_url"]},
                "policy":{"installation":if item["local_available"] == true {"AVAILABLE"} else {"NOT_AVAILABLE"}}
            }));
        }
        token = match data.get("next_page_token") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(value)) => value.clone(),
            _ => anyhow::bail!("invalid TRAE pagination token"),
        };
        if token.is_empty() {
            complete = true;
            break;
        }
        ensure!(
            token.len() <= 2048 && tokens.insert(token.clone()),
            "TRAE pagination did not advance"
        );
    }
    ensure!(
        complete && !entries.is_empty(),
        "TRAE catalog is empty or exceeds page limit"
    );
    let bytes = serde_json::to_vec(
        &json!({"name":REGISTRY,"interface":{"displayName":"TRAE Code / Work"},"plugins":entries}),
    )?;
    ensure!(
        bytes.len() <= 1024 * 1024,
        "TRAE catalog exceeds manifest limit"
    );
    fs::create_dir_all(temp.path().join(".agents/plugins"))?;
    fs::write(temp.path().join(".agents/plugins/marketplace.json"), &bytes)?;
    Ok(MaterializedPlugin {
        root: temp.path().to_path_buf(),
        _temporary: temp,
        evidence: InstalledPluginSource::Hosted {
            url: CATALOG_URL.into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
        },
    })
}

fn checked_download_url(value: &str, id: &str, version: &str) -> Result<url::Url> {
    let url = url::Url::parse(value)?;
    // The official service uses multiple numeric distribution namespaces
    // (observed: 1 and 1001). This segment is not the plugin identity.
    let location_matches = url
        .path()
        .strip_prefix("/tos-cn-i-17oceyzymr/plugins/")
        .is_some_and(|path| {
            let parts: Vec<_> = path.split('/').collect();
            parts.len() == 4
                && !parts[0].is_empty()
                && parts[0].bytes().all(|c| c.is_ascii_digit())
                && parts[0].parse::<u64>().is_ok_and(|n| n > 0)
                && parts[1] == id
                && parts[2] == version
                && parts[3] == "package.zip"
        });
    ensure!(
        url.scheme() == "https"
            && url.host_str() == Some(CDN)
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && location_matches,
        "TRAE returned an unsupported package source"
    );
    Ok(url)
}
/// Some CDN edges retain an older ZIP at the same official version URL.
/// Retry once with a checksum-specific cache key; never accept unverified bytes.
fn download_verified_package(
    url: &url::Url,
    size: u64,
    checksum: &str,
    mut download: impl FnMut(&url::Url) -> Result<Vec<u8>>,
) -> Result<Vec<u8>> {
    for refresh in [false, true] {
        let mut request = url.clone();
        if refresh {
            request
                .query_pairs_mut()
                .append_pair("kcoder_sha256", checksum);
        }
        let bytes = match download(&request) {
            Ok(bytes) => bytes,
            Err(error) => {
                // A stale CDN object can also be larger than the declared ZIP.
                // curl then rejects it before we can inspect bytes; refresh once
                // without raising the publisher's size bound.
                let message = format!("{error:#}").to_ascii_lowercase();
                if !refresh
                    && (message.contains("maximum file size exceeded")
                        || message.contains("maximum allowed file size")
                        || message.contains("exit code: 63")
                        || message.contains("exit status: 63"))
                {
                    continue;
                }
                return Err(error.context(if refresh {
                    "TRAE package download failed after cache refresh"
                } else {
                    "TRAE package download failed"
                }));
            }
        };
        let actual_hash = format!("{:x}", Sha256::digest(&bytes));
        if bytes.len() as u64 == size && actual_hash.eq_ignore_ascii_case(checksum) {
            return Ok(bytes);
        }
        if refresh {
            anyhow::bail!(
                "TRAE package size or SHA-256 mismatch after cache refresh: expected {size} bytes / {checksum}, received {} bytes / {actual_hash}; the official package and metadata may be out of sync. Installation was not performed",
                bytes.len()
            );
        }
    }
    unreachable!("cache refresh either returns verified bytes or an error")
}

fn find_root(root: &Path) -> Result<PathBuf> {
    let mut candidates = vec![root.to_path_buf()];
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        if entry.file_type()?.is_dir()
            && !name.to_string_lossy().starts_with('.')
            && name != "__MACOSX"
        {
            candidates.push(entry.path());
        }
    }
    let mut roots = Vec::new();
    for candidate in candidates {
        if crate::load_plugin_manifest(&candidate)?.is_some() {
            roots.push(candidate);
        }
    }
    ensure!(
        roots.len() == 1,
        "TRAE package must contain exactly one plugin root"
    );
    Ok(roots.remove(0))
}

pub(crate) fn install(
    id: &str,
    version: &str,
    expected_name: &str,
    limits: InstallLimits,
    proxy: Option<&str>,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<MaterializedPlugin> {
    validate_id(id)?;
    validate_version(version)?;
    PluginId::new(expected_name, REGISTRY)?;
    let mut detail_url = url::Url::parse(&format!("{API}/detail"))?;
    detail_url
        .query_pairs_mut()
        .append_pair("plugin_id", id)
        .append_pair("version", version)
        .append_pair("registry", REGISTRY);
    let response: Value = serde_json::from_slice(&download_https(
        detail_url.as_str(),
        proxy,
        4 * 1024 * 1024,
        deadline,
        cancel,
    )?)?;
    let detail = data(&response)?;
    let plugin = &detail["plugin"];
    ensure!(
        required(plugin, "plugin_id")? == id
            && required(plugin, "origin_plugin_name")? == expected_name
            && required(plugin, "registry")? == REGISTRY
            && required(plugin, "version")? == version
            && plugin["local_available"] == true,
        "TRAE plugin identity/version or availability changed; refresh the catalog"
    );
    let download = checked_download_url(required(detail, "download_url")?, id, version)?;
    let checksum = required(detail, "checksum")?;
    ensure!(
        checksum.len() == 64 && checksum.bytes().all(|c| c.is_ascii_hexdigit()),
        "TRAE package lacks a SHA-256 checksum"
    );
    let size = detail["file_size"]
        .as_u64()
        .context("TRAE package lacks file_size")?;
    ensure!(
        size > 0 && size <= limits.max_total_bytes,
        "TRAE package exceeds download size limit"
    );
    let bytes = download_verified_package(&download, size, checksum, |url| {
        download_https(url.as_str(), proxy, size, deadline, cancel)
    })?;
    let temp = kcoder_config::create_private_temp_dir("kcoder-trae-package")?;
    extract(&bytes, temp.path(), limits, deadline, cancel)?;
    let root = find_root(temp.path())?;
    if root.join(".trae-plugin/plugin.json").is_file() {
        fs::write(
            root.join(".kcoder-marketplace-manifest"),
            ".trae-plugin/plugin.json",
        )?;
    }
    let loaded = crate::load_plugin_manifest(&root)?.context("TRAE package manifest missing")?;
    ensure!(
        loaded
            .manifest
            .id
            .as_deref()
            .unwrap_or(&loaded.manifest.name)
            == expected_name,
        "TRAE package manifest identity mismatch"
    );
    ensure!(
        loaded
            .manifest
            .version
            .as_deref()
            .is_none_or(|v| v == version),
        "TRAE package manifest version mismatch"
    );
    Ok(MaterializedPlugin {
        root,
        _temporary: temp,
        evidence: InstalledPluginSource::Hosted {
            url: detail_url.to_string(),
            sha256: checksum.to_ascii_lowercase(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cn_packages_are_bound_to_declared_identity_and_version() {
        let url =
            "https://p11-market.byteimg.com/tos-cn-i-17oceyzymr/plugins/1/demo/1.0.0/package.zip";
        for channel in ["1", "1001", "2002"] {
            assert!(
                checked_download_url(
                    &url.replace("/plugins/1/", &format!("/plugins/{channel}/")),
                    "demo",
                    "1.0.0"
                )
                .is_ok()
            );
        }
        for bad in [
            url.replace("byteimg.com", "example.com"),
            url.replace("/demo/", "/other/"),
            url.replace("/1.0.0/", "/2.0.0/"),
            url.replace("/plugins/1/", "/plugins/0/"),
            url.replace("/plugins/1/", "/plugins/evil/"),
            url.replace("/plugins/1/", "/plugins/1/extra/"),
            url.replace("/plugins/1/", "/plugins/%31/"),
            url.replace("byteimg.com", "byteimg.com.evil.test"),
            url.replace("package.zip", "other.zip"),
            format!("{url}?token=x"),
            url.replace("https://", "http://"),
        ] {
            assert!(checked_download_url(&bad, "demo", "1.0.0").is_err());
        }
        for bad in ["../x", "", "a/b", "v1?query=x"] {
            assert!(validate_version(bad).is_err());
        }
        assert!(data(&json!({"success":false,"data":{"plugins":[]}})).is_err());
    }
    #[test]
    fn stale_cdn_package_retries_once_and_still_requires_size_and_hash() {
        let url = url::Url::parse(
            "https://p11-market.byteimg.com/tos-cn-i-17oceyzymr/plugins/1/demo/1.0.0/package.zip",
        )
        .unwrap();
        let good = b"fresh package".to_vec();
        let checksum = format!("{:x}", Sha256::digest(&good));
        let mut requests = Vec::new();
        let bytes = download_verified_package(&url, good.len() as u64, &checksum, |request| {
            requests.push(request.clone());
            Ok(if request.query().is_none() {
                b"stale package".to_vec()
            } else {
                good.clone()
            })
        })
        .unwrap();
        assert_eq!(bytes, good);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], url);
        assert_eq!(requests[1].host_str(), url.host_str());
        assert_eq!(requests[1].path(), url.path());
        assert_eq!(
            requests[1].query_pairs().collect::<Vec<_>>(),
            vec![("kcoder_sha256".into(), checksum.clone().into())]
        );
        let mut calls = 0;
        let error = download_verified_package(&url, good.len() as u64, &checksum, |_| {
            calls += 1;
            Ok(b"stale package".to_vec())
        })
        .unwrap_err()
        .to_string();
        assert_eq!(calls, 2);
        assert!(error.contains("Installation was not performed"));
        let mut calls = 0;
        download_verified_package(&url, good.len() as u64, &checksum, |_| {
            calls += 1;
            Ok(good.clone())
        })
        .unwrap();
        assert_eq!(calls, 1);
        let mut calls = 0;
        let recovered = download_verified_package(&url, good.len() as u64, &checksum, |_| {
            calls += 1;
            if calls == 1 {
                anyhow::bail!("curl exited with exit code: 63: Maximum file size exceeded")
            }
            Ok(good.clone())
        })
        .unwrap();
        assert_eq!(recovered, good);
        assert_eq!(calls, 2);
        let mut calls = 0;
        assert!(
            download_verified_package(&url, good.len() as u64, &checksum, |_| {
                calls += 1;
                anyhow::bail!("connection refused")
            })
            .is_err()
        );
        assert_eq!(calls, 1);
        assert!(
            download_verified_package(&url, good.len() as u64 + 1, &checksum, |_| Ok(good.clone()))
                .is_err()
        );
    }

    #[test]
    fn root_selection_accepts_flat_or_wrapped_but_rejects_multiple_plugins() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["first", "second"] {
            let root = temp.path().join(name);
            fs::create_dir_all(root.join(".trae-plugin")).unwrap();
            fs::write(
                root.join(".trae-plugin/plugin.json"),
                json!({"name":name}).to_string(),
            )
            .unwrap();
            if name == "first" {
                assert_eq!(find_root(temp.path()).unwrap(), root);
            }
        }
        assert!(find_root(temp.path()).is_err());
    }
}
