//! Windows-only bundled guidance. The native host supplies tools after approval.
use super::*;
const ID: &str = "kcoder-windows-computer-use";
#[cfg(any(windows, test))]
const VERSION: &str = "0.1.6";
const DIGEST: &str = "sha256:dc6a58f0e979505bdc63960bb289915a34b358041a44e07234504f67283870c8";
pub(super) fn digest() -> &'static str {
    DIGEST
}
const FILES: &[(&str, &[u8])] = &[
    (
        ".codex-plugin/plugin.json",
        include_bytes!("../bundled/kcoder-windows-computer-use/.codex-plugin/plugin.json"),
    ),
    (
        "skills/windows-computer-use/SKILL.md",
        include_bytes!(
            "../bundled/kcoder-windows-computer-use/skills/windows-computer-use/SKILL.md"
        ),
    ),
    (
        "LICENSE",
        include_bytes!("../bundled/kcoder-windows-computer-use/LICENSE"),
    ),
    (
        "bundle.json",
        include_bytes!("../bundled/kcoder-windows-computer-use/bundle.json"),
    ),
];
#[cfg(any(windows, test))]
pub(super) fn entry() -> MarketplaceEntry {
    MarketplaceEntry {
        plugin_id: PluginId::new(ID, BUNDLED_MARKETPLACE_ID).unwrap(),
        source: PluginSource::Bundled {
            bundle: ID.into(),
            digest: DIGEST.into(),
        },
        version: Some(VERSION.into()),
        install_policy: InstallPolicy::Available,
        auth_policy: AuthPolicy::OnInstall,
        manifest_fallback: Some(
            serde_json::json!({"packageIdentity":format!("{ID}@{BUNDLED_MARKETPLACE_ID}"),"source":"KCoder / Windows-MCP integration","resolvedVersion":VERSION,"license":"MIT","digest":DIGEST}),
        ),
    }
}
pub(super) fn materialize(expected: &str) -> Result<MaterializedBundle> {
    anyhow::ensure!(
        cfg!(windows) || cfg!(test),
        "Computer Use bundle requires Windows"
    );
    let mut hash = Sha256::new();
    for (path, bytes) in FILES {
        hash.update((path.len() as u64).to_be_bytes());
        hash.update(path.as_bytes());
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    anyhow::ensure!(
        expected == DIGEST && format!("sha256:{:x}", hash.finalize()) == DIGEST,
        "desktop bundle integrity mismatch"
    );
    let temporary = create_private_temp_dir("kcoder-computer-use-plugin")?;
    for (relative, bytes) in FILES {
        let path = temporary.path().join(relative);
        let parent = path.parent().unwrap();
        fs::create_dir_all(parent)?;
        kcoder_config::set_user_only_dir_permissions(parent)?;
        fs::write(&path, bytes)?;
        kcoder_config::set_user_only_file_permissions(&path)?;
    }
    Ok(MaterializedBundle {
        root: temporary.path().to_path_buf(),
        _temporary: temporary,
        evidence: InstalledPluginSource::Bundled {
            bundle: ID.into(),
            digest: DIGEST.into(),
        },
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_bundle_is_pinned_materializable_and_not_a_fake_mcp_server() {
        let entry = entry();
        let PluginSource::Bundled { digest, .. } = entry.source else {
            panic!()
        };
        let bundle = materialize(&digest).unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(
            &fs::read(bundle.root.join(".codex-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], ID);
        assert!(manifest.get("mcpServers").is_none());
        assert!(
            bundle
                .root
                .join("skills/windows-computer-use/SKILL.md")
                .is_file()
        );
        assert!(materialize("sha256:wrong").is_err());
        assert!(!crate::computer_use_guidance_needs_update(&bundle.evidence));
        assert!(crate::computer_use_guidance_needs_update(
            &InstalledPluginSource::Bundled {
                bundle: ID.into(),
                digest: "sha256:old".into()
            }
        ));
        assert!(!crate::computer_use_guidance_needs_update(
            &InstalledPluginSource::Bundled {
                bundle: "another-plugin".into(),
                digest: "sha256:old".into()
            }
        ));
    }
}
