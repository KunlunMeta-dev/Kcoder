use crate::{
    AuthPolicy, InstallPolicy, InstalledPluginSource, MarketplaceEntry, MarketplaceManifest,
    PluginId, PluginSource,
};
use anyhow::{Context, Result, bail};
use kcoder_config::{PrivateTempDir, create_private_temp_dir};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

pub const BUNDLED_MARKETPLACE_ID: &str = "kcoder-bundled";
const BUNDLE_ID: &str = "kcoder-workflow-basics";
const BUNDLE_DIGEST: &str =
    "sha256:05e2af75c5de4ca84879b909fc0a99dfac1089a256329be94ad8379b19eb0aaf";

const BUNDLE_FILES: &[(&str, &[u8])] = &[
    (
        ".codex-plugin/plugin.json",
        include_bytes!("../bundled/kcoder-workflow-basics/.codex-plugin/plugin.json"),
    ),
    (
        "skills/workflow-basics/SKILL.md",
        include_bytes!("../bundled/kcoder-workflow-basics/skills/workflow-basics/SKILL.md"),
    ),
    (
        "LICENSE",
        include_bytes!("../bundled/kcoder-workflow-basics/LICENSE"),
    ),
    (
        "bundle.json",
        include_bytes!("../bundled/kcoder-workflow-basics/bundle.json"),
    ),
];

pub(crate) fn marketplace() -> MarketplaceManifest {
    MarketplaceManifest {
        diagnostics: Vec::new(),
        name: BUNDLED_MARKETPLACE_ID.to_string(),
        path: PathBuf::from("builtin/kcoder-bundled/marketplace.json"),
        root: PathBuf::from("builtin/kcoder-bundled"),
        display_name: Some("KCoder Bundled".to_string()),
        plugins: vec![MarketplaceEntry {
            plugin_id: PluginId::new(BUNDLE_ID, BUNDLED_MARKETPLACE_ID)
                .expect("bundled plugin identity is valid"),
            source: PluginSource::Bundled {
                bundle: BUNDLE_ID.to_string(),
                digest: BUNDLE_DIGEST.to_string(),
            },
            version: Some("1.2.0".to_string()),
            install_policy: InstallPolicy::Available,
            auth_policy: AuthPolicy::OnInstall,
            manifest_fallback: Some(serde_json::json!({
                "packageIdentity": format!("{BUNDLE_ID}@{BUNDLED_MARKETPLACE_ID}"),
                "source": "KCoder repository",
                "resolvedVersion": "1.2.0",
                "license": "MIT",
                "digest": BUNDLE_DIGEST,
                "build": "embedded with Rust include_bytes! and materialized through PluginStore"
            })),
        }],
    }
}

pub(crate) struct MaterializedBundle {
    _temporary: PrivateTempDir,
    pub root: PathBuf,
    pub evidence: InstalledPluginSource,
}

pub(crate) fn materialize(bundle: &str, expected_digest: &str) -> Result<MaterializedBundle> {
    if bundle != BUNDLE_ID {
        bail!("unknown bundled plugin {bundle}");
    }
    let digest = bundle_digest();
    if expected_digest != BUNDLE_DIGEST || digest != BUNDLE_DIGEST {
        bail!("bundled plugin digest does not match the compiled manifest");
    }
    let temporary = create_private_temp_dir("kcoder-bundled-plugin")?;
    for (relative, bytes) in BUNDLE_FILES {
        let target = temporary.path().join(relative);
        let parent = target.parent().context("bundled file has no parent")?;
        fs::create_dir_all(parent)?;
        kcoder_config::set_user_only_dir_permissions(parent)?;
        fs::write(&target, bytes)?;
        kcoder_config::set_user_only_file_permissions(&target)?;
    }
    Ok(MaterializedBundle {
        root: temporary.path().to_path_buf(),
        _temporary: temporary,
        evidence: InstalledPluginSource::Bundled {
            bundle: bundle.to_string(),
            digest,
        },
    })
}

pub(crate) fn bundle_digest() -> String {
    let mut digest = Sha256::new();
    for (path, bytes) in BUNDLE_FILES {
        digest.update((path.len() as u64).to_be_bytes());
        digest.update(path.as_bytes());
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    format!("sha256:{:x}", digest.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_manifest_digest_and_license_are_stable_and_materializable() {
        let marketplace = marketplace();
        let PluginSource::Bundled { bundle, digest } = &marketplace.plugins[0].source else {
            panic!("bundled marketplace source changed kind");
        };

        let materialized = materialize(bundle, digest).unwrap();

        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(materialized.root.join(".codex-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["version"].as_str(),
            marketplace.plugins[0].version.as_deref()
        );
        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest, BUNDLE_DIGEST);
        assert!(materialized.root.join("LICENSE").is_file());
        assert!(
            materialized
                .root
                .join(".codex-plugin/plugin.json")
                .is_file()
        );
        assert!(matches!(
            materialized.evidence,
            InstalledPluginSource::Bundled { .. }
        ));
    }
}
