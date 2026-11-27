//! Qoder's uploaded packages and first-party qoder-mind packages share the
//! manifest contract, but only uploads consistently declare manifest_path.
use super::*;
use std::path::PathBuf;

pub(super) fn package_url(download: &str) -> Result<url::Url> {
    let url = url::Url::parse(download)?;
    let location = match url.host_str() {
        Some("qoder-skills.oss-accelerate.aliyuncs.com") => {
            url.path().starts_with("/public/extensions/plugin/")
                || url.path().starts_with("/plugins/public/")
        }
        Some("qoder-mind.oss-accelerate.aliyuncs.com") => {
            url.path().starts_with("/plugins/public/")
        }
        _ => false,
    };
    ensure!(
        url.scheme() == "https"
            && location
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Qoder returned an unsupported package source (expected an official Qoder HTTPS plugin archive)"
    );
    Ok(url)
}

pub(super) fn package_root(
    detail: &Value,
    extracted: &Path,
    limits: InstallLimits,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<PathBuf> {
    let declared = detail.pointer("/extra/package_metadata/manifest_path");
    if let Some(value) = declared.filter(|v| !v.is_null()) {
        let value = value
            .as_str()
            .context("Qoder manifest_path must be a string")?;
        if !value.is_empty() {
            let path = safe_relative(value)?;
            ensure!(
                path.ends_with(".qoder-plugin/plugin.json"),
                "Qoder package manifest layout is unsupported"
            );
            let manifest = extracted.join(path);
            ensure!(
                manifest.is_file(),
                "Qoder declared manifest_path does not exist in the package"
            );
            return Ok(manifest
                .parent()
                .and_then(Path::parent)
                .context("invalid Qoder package root")?
                .to_path_buf());
        }
    }
    // Only inspect this private, bounded archive extraction. Do not guess among
    // multiple plugin roots or silently fall back from an invalid declared path.
    let mut pending = vec![extracted.to_path_buf()];
    let mut roots = Vec::new();
    let mut count = 0usize;
    while let Some(dir) = pending.pop() {
        cancel.check()?;
        ensure!(
            Instant::now() < deadline,
            "Qoder manifest discovery timed out"
        );
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            count += 1;
            ensure!(
                count
                    <= limits
                        .max_files
                        .saturating_mul(limits.max_depth.saturating_add(1)),
                "Qoder manifest discovery exceeds package limits"
            );
            let kind = entry.file_type()?;
            ensure!(!kind.is_symlink(), "Qoder package contains a symlink");
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() && entry.path().ends_with(".qoder-plugin/plugin.json") {
                roots.push(
                    dir.parent()
                        .context("invalid Qoder package root")?
                        .to_path_buf(),
                );
                ensure!(
                    roots.len() == 1,
                    "Qoder package has multiple plugin manifests; manifest_path is required to select one"
                );
            }
        }
    }
    roots
        .pop()
        .context("Qoder package has no .qoder-plugin/plugin.json manifest")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_locations_and_encoded_names_only() {
        for value in [
            "https://qoder-skills.oss-accelerate.aliyuncs.com/public/extensions/plugin/id/产品.zip",
            "https://qoder-mind.oss-accelerate.aliyuncs.com/plugins/public/design-review/latest/design-review.zip",
            "https://qoder-skills.oss-accelerate.aliyuncs.com/plugins/public/wxz-cli/latest/wxz-cli.zip",
        ] {
            assert!(package_url(value).is_ok(), "{value}");
        }
        for value in [
            "https://qoder-mind.oss-accelerate.aliyuncs.com.evil.test/plugins/public/a.zip",
            "http://qoder-mind.oss-accelerate.aliyuncs.com/plugins/public/a.zip",
            "https://qoder-mind.oss-accelerate.aliyuncs.com/private/a.zip",
            "https://qoder-mind.oss-accelerate.aliyuncs.com/plugins/public/a.zip?token=secret",
            "https://u:p@qoder-mind.oss-accelerate.aliyuncs.com/plugins/public/a.zip",
        ] {
            assert!(package_url(value).is_err(), "{value}");
        }
    }
    #[test]
    fn discovers_missing_metadata_without_ambiguous_or_invalid_fallbacks() {
        let tmp = tempfile::tempdir().unwrap();
        let cancel = PluginCancellationToken::default();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let find = |detail: Value| {
            package_root(
                &detail,
                tmp.path(),
                InstallLimits::default(),
                deadline,
                &cancel,
            )
        };
        assert!(find(json!({})).is_err());
        let root = tmp.path().join("wrapper");
        fs::create_dir_all(root.join(".qoder-plugin")).unwrap();
        fs::write(root.join(".qoder-plugin/plugin.json"), "{}").unwrap();
        assert_eq!(find(json!({})).unwrap(), root);
        assert_eq!(
            find(json!({"extra":{"package_metadata":{"manifest_path":null}}})).unwrap(),
            root
        );
        for path in [
            "../escape/.qoder-plugin/plugin.json",
            "missing/.qoder-plugin/plugin.json",
            ".claude-plugin/plugin.json",
        ] {
            assert!(find(json!({"extra":{"package_metadata":{"manifest_path":path}}})).is_err());
        }
        fs::create_dir_all(tmp.path().join(".qoder-plugin")).unwrap();
        fs::write(tmp.path().join(".qoder-plugin/plugin.json"), "{}").unwrap();
        assert!(find(json!({})).is_err());
        assert_eq!(find(json!({"extra":{"package_metadata":{"manifest_path":"wrapper/.qoder-plugin/plugin.json"}}})).unwrap(), root);
        cancel.cancel();
        assert!(find(json!({})).is_err());
    }
}
