//! Source/version-scoped results from the real installation audit. Local packages
//! are inspected dynamically instead of blacklisting names or freezing credentials.
use crate::marketplace::{InstallPolicy, MarketplaceEntry, PluginSource};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::{
    ffi::OsStr,
    io::Read,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
struct Audit {
    checked_at: String,
    rules: Vec<Rule>,
}
#[derive(Deserialize)]
struct Rule {
    plugin_id: String,
    source: PluginSource,
    version: Option<String>,
    code: String,
    message: String,
    credential_env: Vec<String>,
    #[serde(default)]
    target: Option<String>,
}

pub(crate) fn unavailable(entry: &mut MarketplaceEntry, code: &str, message: &str) {
    entry.install_policy = InstallPolicy::NotAvailable;
    let manifest = entry.manifest_fallback.get_or_insert_with(|| json!({}));
    if !manifest.is_object() {
        *manifest = json!({});
    }
    let compatibility = manifest
        .as_object_mut()
        .unwrap()
        .entry("compatibility")
        .or_insert_with(|| json!({}));
    if !compatibility.is_object() {
        *compatibility = json!({});
    }
    let issues = compatibility
        .as_object_mut()
        .unwrap()
        .entry("issues")
        .or_insert_with(|| json!([]));
    if !issues.is_array() {
        *issues = json!([]);
    }
    issues.as_array_mut().unwrap().push(
        json!({"code":code,"capability":null,"message":message,"category":match code {
            "installation_package_integrity" => "integrity",
            "installation_download_unverified" => "network",
            "installation_credentials" => "credentials",
            "installation_unsupported" => "platform",
            "installation_unavailable" => "publisher",
            "installation_unverified" => "unverified",
            _ => "package",
        }}),
    );
}

pub(crate) fn reason(entry: &MarketplaceEntry) -> Option<&str> {
    entry
        .manifest_fallback
        .as_ref()?
        .pointer("/compatibility/issues")?
        .as_array()?
        .iter()
        .find_map(|issue| {
            issue
                .get("code")?
                .as_str()?
                .starts_with("installation_")
                .then(|| issue.get("message")?.as_str())
                .flatten()
        })
}

pub(crate) fn apply(entry: &mut MarketplaceEntry) {
    apply_with_env(entry, |name| {
        std::env::var(name).is_ok_and(|value| !value.trim().is_empty())
    });
}

fn apply_with_env(entry: &mut MarketplaceEntry, has_env: impl Fn(&str) -> bool) {
    let audit = audit();
    for rule in &audit.rules {
        if rule.plugin_id != entry.plugin_id.to_string()
            || rule.source != entry.source
            || rule.version != entry.version
        {
            continue;
        }
        if !rule.credential_env.is_empty() && rule.credential_env.iter().any(|name| has_env(name)) {
            continue;
        }
        if rule
            .target
            .as_deref()
            .is_some_and(|target| target != target_scope())
        {
            continue;
        }
        let original_policy = entry.install_policy;
        unavailable(
            entry,
            &rule.code,
            &format!("{} (Verified {})", rule.message, audit.checked_at),
        );
        if rule.code == "installation_credentials" {
            entry.manifest_fallback.as_mut().unwrap()["installationAvailability"] = json!({
                "category": "credentials", "retryable": false,
                "missingNames": rule.credential_env.iter().take(1).collect::<Vec<_>>(),
                "checkedAt": audit.checked_at, "originalInstallPolicy": original_policy,
            });
        }
        if rule.code == "installation_download_unverified" {
            entry.manifest_fallback.as_mut().unwrap()["installationAvailability"] = json!({
                "category": "network", "retryable": original_policy != InstallPolicy::NotAvailable,
                "checkedAt": audit.checked_at, "target": rule.target,
                "originalInstallPolicy": original_policy,
            });
        }
    }
    if entry.install_policy == InstallPolicy::NotAvailable
        && entry
            .manifest_fallback
            .as_ref()
            .and_then(|manifest| {
                manifest.pointer("/installationAvailability/originalInstallPolicy")
            })
            .is_some_and(|policy| policy == "NOT_AVAILABLE" || policy == "not_available")
        && !installation_codes(entry).any(|code| code == "installation_unavailable")
    {
        unavailable(
            entry,
            "installation_unavailable",
            "The publisher does not permit installation of this catalog entry.",
        );
        if let Some(issues) = entry
            .manifest_fallback
            .as_mut()
            .and_then(|manifest| manifest.pointer_mut("/compatibility/issues"))
            .and_then(serde_json::Value::as_array_mut)
        {
            issues.rotate_right(1);
        }
    }
    if entry.install_policy == InstallPolicy::NotAvailable && reason(entry).is_none() {
        unavailable(
            entry,
            "installation_unavailable",
            "The marketplace or this runtime does not currently make this plugin available for installation.",
        );
    }
}

fn audit() -> &'static Audit {
    static AUDIT: OnceLock<Audit> = OnceLock::new();
    AUDIT.get_or_init(|| {
        serde_json::from_str(include_str!("marketplace_availability.json"))
            .expect("validated bundled marketplace audit")
    })
}

/// Host values are scoped to this exact catalog identity. Publisher restrictions
/// and mixed/hard failures never become installable merely because a key exists.
pub(crate) fn apply_private_credentials(
    entry: &mut MarketplaceEntry,
    values: &std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let original = entry
        .manifest_fallback
        .as_ref()
        .and_then(|manifest| manifest.pointer("/installationAvailability/originalInstallPolicy"))
        .cloned();
    if original
        .as_ref()
        .is_none_or(|policy| policy == "NOT_AVAILABLE" || policy == "not_available")
    {
        return Ok(());
    }
    let issues = entry
        .manifest_fallback
        .as_ref()
        .and_then(|manifest| manifest.pointer("/compatibility/issues"))
        .and_then(serde_json::Value::as_array);
    let credential_only = issues.is_some_and(|issues| {
        let installation = issues
            .iter()
            .filter(|issue| {
                issue["code"]
                    .as_str()
                    .is_some_and(|code| code.starts_with("installation_"))
            })
            .collect::<Vec<_>>();
        !installation.is_empty()
            && installation.iter().all(|issue| {
                issue["code"] == "installation_credentials"
                    || (issue["code"] == "installation_configuration"
                        && issue["message"].as_str().is_some_and(|message| {
                            message.starts_with("MCP environment variable `")
                                || message.starts_with("MCP connector credential `")
                        }))
            })
    });
    if !credential_only {
        return Ok(());
    }
    let configured = match &entry.source {
        PluginSource::Local { path } => crate::load_plugin_manifest(path)?
            .and_then(|loaded| loaded.manifest.contributions.mcp_servers)
            .is_some_and(|declaration| {
                crate::contributions::mcp::resolve_with_env(
                    &entry.plugin_id.to_string(),
                    path,
                    &declaration,
                    |name| {
                        values
                            .get(name)
                            .cloned()
                            .or_else(|| std::env::var(name).ok())
                    },
                )
                .is_ok()
            }),
        _ => audit().rules.iter().any(|rule| {
            rule.plugin_id == entry.plugin_id.to_string()
                && rule.source == entry.source
                && rule.version == entry.version
                && rule.code == "installation_credentials"
                && rule.credential_env.iter().any(|name| {
                    values
                        .get(name)
                        .is_some_and(|value| !value.trim().is_empty())
                })
        }),
    };
    if !configured {
        return Ok(());
    }
    let manifest = entry.manifest_fallback.as_mut().unwrap();
    manifest
        .pointer_mut("/compatibility/issues")
        .and_then(serde_json::Value::as_array_mut)
        .unwrap()
        .retain(|issue| {
            issue["code"] != "installation_credentials"
                && issue["code"] != "installation_configuration"
        });
    manifest["installationAvailability"]["missingNames"] = json!([]);
    entry.install_policy = serde_json::from_value(original.unwrap())?;
    Ok(())
}

pub(crate) fn audited_credential_names(entry: &MarketplaceEntry) -> Vec<String> {
    audit()
        .rules
        .iter()
        .find(|rule| {
            rule.plugin_id == entry.plugin_id.to_string()
                && rule.source == entry.source
                && rule.version == entry.version
                && rule.code == "installation_credentials"
        })
        .map(|rule| rule.credential_env.iter().take(1).cloned().collect())
        .unwrap_or_default()
}

const EVIDENCE_TTL_SECS: u64 = 3600;

fn target_scope() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

pub(crate) fn fingerprint(entry: &MarketplaceEntry) -> Result<String> {
    let identity = serde_json::to_vec(&(
        entry.plugin_id.to_string(),
        &entry.source,
        &entry.version,
        target_scope(),
    ))?;
    Ok(format!("{:x}", Sha256::digest(identity)))
}

/// Only network evidence can be retried. A publisher restriction or another
/// hard issue still rejects preflight, even if a temporary issue is also present.
pub(crate) fn retryable(entry: &MarketplaceEntry) -> bool {
    // Catalog metadata is untrusted. Only a matching runtime-owned audit rule
    // may grant the network retry exception to a blocked publisher policy.
    let trusted_network_rule = audit().rules.iter().any(|rule| {
        rule.code == "installation_download_unverified"
            && rule.plugin_id == entry.plugin_id.to_string()
            && rule.source == entry.source
            && rule.version == entry.version
            && rule
                .target
                .as_deref()
                .is_none_or(|target| target == target_scope())
    });
    trusted_network_rule
        && entry
            .manifest_fallback
            .as_ref()
            .and_then(|value| value.pointer("/installationAvailability/retryable"))
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        && installation_codes(entry).any(|code| code == "installation_download_unverified")
        && installation_codes(entry).all(|code| code == "installation_download_unverified")
}

fn installation_codes(entry: &MarketplaceEntry) -> impl Iterator<Item = &str> {
    entry
        .manifest_fallback
        .as_ref()
        .and_then(|value| value.pointer("/compatibility/issues"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|issue| issue.get("code").and_then(serde_json::Value::as_str))
        .filter(|code| code.starts_with("installation_"))
}

#[derive(Serialize, Deserialize)]
struct Evidence {
    fingerprint: String,
    checked_at_unix: u64,
    #[serde(default)]
    verified_digest: Option<String>,
}

pub(crate) fn record_verified(
    store_root: &Path,
    entry: &MarketplaceEntry,
    observed: Option<&crate::InstalledPluginSource>,
) -> Result<()> {
    let digest = fingerprint(entry)?;
    let directory =
        kcoder_config::PrivateDirectory::open_or_create(&store_root.join("availability"))?;
    let evidence = Evidence {
        fingerprint: digest.clone(),
        checked_at_unix: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        verified_digest: observed.and_then(|source| match source {
            crate::InstalledPluginSource::Git { resolved_sha, .. } => Some(resolved_sha.clone()),
            crate::InstalledPluginSource::Hosted { sha256, .. } => Some(sha256.clone()),
            crate::InstalledPluginSource::Npm { integrity, .. } => Some(integrity.clone()),
            crate::InstalledPluginSource::Bundled { digest, .. } => Some(digest.clone()),
            _ => None,
        }),
    };
    directory.atomic_replace(
        OsStr::new(&format!("{digest}.json")),
        &serde_json::to_vec(&evidence)?,
    )
}

pub(crate) fn invalidate_verified(store_root: &Path, entry: &MarketplaceEntry) -> Result<()> {
    let directory = store_root.join("availability");
    if !directory.try_exists()? {
        return Ok(());
    }
    let directory = kcoder_config::PrivateDirectory::open_existing(&directory)?;
    match directory.remove_regular_file(OsStr::new(&format!("{}.json", fingerprint(entry)?))) {
        Ok(()) => Ok(()),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn apply_verified(store_root: &Path, entry: &mut MarketplaceEntry) -> Result<()> {
    let can_clear_network = retryable(entry);
    if entry.install_policy == InstallPolicy::NotAvailable && !can_clear_network {
        return Ok(());
    }
    let digest = fingerprint(entry)?;
    let path = store_root.join("availability");
    if !path.try_exists()? {
        return Ok(());
    }
    let directory = kcoder_config::PrivateDirectory::open_existing(&path)?;
    let file = match directory.open_regular_file(OsStr::new(&format!("{digest}.json"))) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    file.take(1025).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() <= 1024,
        "plugin availability evidence exceeds limit"
    );
    let evidence: Evidence =
        serde_json::from_slice(&bytes).context("invalid plugin availability evidence")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    if evidence.fingerprint != digest
        || evidence.checked_at_unix > now
        || now - evidence.checked_at_unix > EVIDENCE_TTL_SECS
    {
        return Ok(());
    }
    let manifest = entry.manifest_fallback.get_or_insert_with(|| json!({}));
    if !manifest.is_object() {
        *manifest = json!({});
    }
    let original = manifest
        .pointer("/installationAvailability/originalInstallPolicy")
        .cloned();
    if can_clear_network
        && let Some(issues) = manifest
            .pointer_mut("/compatibility/issues")
            .and_then(serde_json::Value::as_array_mut)
    {
        issues.retain(|issue| {
            issue.get("code").and_then(serde_json::Value::as_str)
                != Some("installation_download_unverified")
        });
    }
    if can_clear_network {
        entry.install_policy = serde_json::from_value(original.unwrap_or(json!("NOT_AVAILABLE")))?;
    }
    if !manifest
        .get("installationAvailability")
        .is_some_and(serde_json::Value::is_object)
    {
        manifest["installationAvailability"] = json!({"category":"verified", "retryable":false});
    }
    manifest["installationAvailability"]["verifiedDigest"] = json!(evidence.verified_digest);
    manifest["installationAvailability"]["verifiedTarget"] = json!(target_scope());
    manifest["installationAvailability"]["verifiedAtUnix"] = json!(evidence.checked_at_unix);
    manifest["installationAvailability"]["expiresAtUnix"] =
        json!(evidence.checked_at_unix + EVIDENCE_TTL_SECS);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(rule: &Rule) -> MarketplaceEntry {
        MarketplaceEntry {
            plugin_id: rule.plugin_id.parse().unwrap(),
            source: rule.source.clone(),
            version: rule.version.clone(),
            install_policy: InstallPolicy::Available,
            auth_policy: crate::marketplace::AuthPolicy::OnUse,
            manifest_fallback: Some(json!({})),
        }
    }
    #[test]
    fn audit_blocks_only_matching_sources_and_versions() {
        let audit: Audit =
            serde_json::from_str(include_str!("marketplace_availability.json")).unwrap();
        assert!(!audit.rules.is_empty());
        for rule in &audit.rules {
            if rule
                .target
                .as_deref()
                .is_some_and(|target| target != target_scope())
            {
                continue;
            }
            let mut tested = entry(rule);
            apply_with_env(&mut tested, |_| false);
            assert_eq!(tested.install_policy, InstallPolicy::NotAvailable);
            assert!(reason(&tested).is_some());
            let mut newer = entry(rule);
            newer.version = Some("future-corrected-version".into());
            apply_with_env(&mut newer, |_| false);
            assert_eq!(newer.install_policy, InstallPolicy::Available);
            let mut other = entry(rule);
            other.source = PluginSource::Local {
                path: "/different/source".into(),
            };
            apply_with_env(&mut other, |_| false);
            assert_eq!(other.install_policy, InstallPolicy::Available);
            if !rule.credential_env.is_empty() {
                let mut configured = entry(rule);
                apply_with_env(&mut configured, |_| true);
                assert_eq!(configured.install_policy, InstallPolicy::Available);
            }
        }
    }
    fn network_entry() -> MarketplaceEntry {
        let audit: Audit =
            serde_json::from_str(include_str!("marketplace_availability.json")).unwrap();
        let rule = audit
            .rules
            .iter()
            .find(|rule| rule.code == "installation_download_unverified")
            .unwrap();
        let mut tested = entry(rule);
        // The fixture models this target's static network audit only.
        unavailable(&mut tested, &rule.code, &rule.message);
        tested.manifest_fallback.as_mut().unwrap()["installationAvailability"] = json!({
            "retryable": true, "originalInstallPolicy": "AVAILABLE"
        });
        tested
    }

    #[test]
    fn success_evidence_is_scoped_and_never_clears_hard_failures() {
        let temp = tempfile::TempDir::new().unwrap();
        let tested = network_entry();
        assert!(retryable(&tested));
        record_verified(temp.path(), &tested, None).unwrap();
        let mut verified = tested.clone();
        apply_verified(temp.path(), &mut verified).unwrap();
        assert_eq!(verified.install_policy, InstallPolicy::Available);
        assert!(reason(&verified).is_none());
        invalidate_verified(temp.path(), &tested).unwrap();
        let mut failed_again = tested.clone();
        apply_verified(temp.path(), &mut failed_again).unwrap();
        assert_eq!(failed_again.install_policy, InstallPolicy::NotAvailable);
        record_verified(temp.path(), &tested, None).unwrap();
        for code in [
            "installation_package_integrity",
            "installation_unsupported",
            "installation_unavailable",
            "installation_credentials",
        ] {
            let mut hard = tested.clone();
            unavailable(&mut hard, code, "hard failure");
            assert!(!retryable(&hard));
            apply_verified(temp.path(), &mut hard).unwrap();
            assert_eq!(hard.install_policy, InstallPolicy::NotAvailable);
        }
        let mut different = tested.clone();
        different.version = Some("different-version".into());
        apply_verified(temp.path(), &mut different).unwrap();
        assert_eq!(different.install_policy, InstallPolicy::NotAvailable);
        let mut different = tested.clone();
        different.source = PluginSource::Local {
            path: "/other-source".into(),
        };
        apply_verified(temp.path(), &mut different).unwrap();
        assert_eq!(different.install_policy, InstallPolicy::NotAvailable);
        let other_target = tempfile::TempDir::new().unwrap();
        let mut different = tested;
        apply_verified(other_target.path(), &mut different).unwrap();
        assert_eq!(different.install_policy, InstallPolicy::NotAvailable);
    }

    #[test]
    fn expired_or_future_evidence_does_not_release_network_block() {
        let temp = tempfile::TempDir::new().unwrap();
        let tested = network_entry();
        let digest = fingerprint(&tested).unwrap();
        let directory =
            kcoder_config::PrivateDirectory::open_or_create(&temp.path().join("availability"))
                .unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        for checked_at_unix in [now - EVIDENCE_TTL_SECS - 1, now + 30] {
            directory
                .atomic_replace(
                    OsStr::new(&format!("{digest}.json")),
                    &serde_json::to_vec(&Evidence {
                        fingerprint: digest.clone(),
                        checked_at_unix,
                        verified_digest: None,
                    })
                    .unwrap(),
                )
                .unwrap();
            let mut expired = tested.clone();
            apply_verified(temp.path(), &mut expired).unwrap();
            assert_eq!(expired.install_policy, InstallPolicy::NotAvailable);
        }
    }

    #[test]
    fn publisher_policy_cannot_be_retried_even_with_network_audit() {
        let audit: Audit =
            serde_json::from_str(include_str!("marketplace_availability.json")).unwrap();
        let rule = audit
            .rules
            .iter()
            .find(|r| r.code == "installation_download_unverified")
            .unwrap();
        let mut blocked = entry(rule);
        blocked.install_policy = InstallPolicy::NotAvailable;
        apply_with_env(&mut blocked, |_| false);
        assert!(!retryable(&blocked));
    }
}
