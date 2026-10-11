//! WorkBuddy's public, product-declared Tencent CDN catalogs.
use super::extract;
use crate::materialize::{MaterializedPlugin, download_https};
use crate::{InstallLimits, InstalledPluginSource, PluginCancellationToken};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, time::Instant};

pub(crate) const OFFICIAL_URL: &str =
    "https://download.codebuddy.cn/plugin-marketplace/codebuddy-plugins-official.zip";
pub(crate) const TEAMS_URL: &str =
    "https://download.codebuddy.cn/plugin-marketplace/cb_teams_marketplace.zip";
pub(crate) fn is_catalog(source: &str) -> bool {
    matches!(source, OFFICIAL_URL | TEAMS_URL)
}

pub(crate) fn catalog(
    source: &str,
    limits: InstallLimits,
    proxy: Option<&str>,
    deadline: Instant,
    cancel: &PluginCancellationToken,
) -> Result<MaterializedPlugin> {
    let (upstream_name, name, label) = match source {
        OFFICIAL_URL => ("codebuddy-plugins-official", "workbuddy", "WorkBuddy"),
        TEAMS_URL => ("cb_teams_marketplace", "workbuddy-teams", "WorkBuddy Teams"),
        _ => anyhow::bail!("unsupported WorkBuddy catalog source"),
    };
    let bytes = download_https(
        source,
        proxy,
        limits.max_total_bytes.min(64 * 1024 * 1024),
        deadline,
        cancel,
    )?;
    // The CDN does not publish a package SHA-256 in its index. Record the observed
    // archive digest as provenance; do not present it as a publisher signature.
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let temp = kcoder_config::create_private_temp_dir("kcoder-workbuddy-catalog")?;
    extract(&bytes, temp.path(), limits, deadline, cancel)?;
    let manifest_path = crate::find_marketplace_manifest_path(temp.path())
        .context("WorkBuddy archive is missing its root marketplace manifest")?;
    let mut manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    ensure!(
        manifest["name"] == upstream_name,
        "WorkBuddy catalog identity mismatch"
    );
    ensure!(
        manifest["plugins"]
            .as_array()
            .is_some_and(|p| !p.is_empty()),
        "WorkBuddy catalog is empty"
    );
    // WorkBuddy's CDN and CodeBuddy's Git catalog share an upstream name but are
    // released independently. Keep separate KCoder namespaces, never overwrite.
    manifest["name"] = json!(name);
    manifest["interface"] = json!({"displayName":label});
    fs::write(&manifest_path, serde_json::to_vec(&manifest)?)?;
    crate::load_marketplace_manifest(&manifest_path)?;
    Ok(MaterializedPlugin {
        root: temp.path().to_path_buf(),
        _temporary: temp,
        evidence: InstalledPluginSource::Hosted {
            url: source.into(),
            sha256,
        },
    })
}
