//! Source/version-scoped results from the real installation audit. Local packages
//! are inspected dynamically instead of blacklisting names or freezing credentials.
use crate::marketplace::{InstallPolicy, MarketplaceEntry, PluginSource};
use serde::Deserialize;
use serde_json::json;
use std::sync::OnceLock;

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
    issues
        .as_array_mut()
        .unwrap()
        .push(json!({"code":code,"capability":null,"message":message}));
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
    static AUDIT: OnceLock<Audit> = OnceLock::new();
    let audit = AUDIT.get_or_init(|| {
        serde_json::from_str(include_str!("marketplace_availability.json"))
            .expect("validated bundled marketplace audit")
    });
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
        unavailable(
            entry,
            &rule.code,
            &format!("{} (Verified {})", rule.message, audit.checked_at),
        );
    }
    if entry.install_policy == InstallPolicy::NotAvailable && reason(entry).is_none() {
        unavailable(
            entry,
            "installation_unavailable",
            "The marketplace or this runtime does not currently make this plugin available for installation.",
        );
    }
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
}
