use super::*;
use std::process::Command;

fn grant(path: &Path, permission: &str) {
    let result = Command::new("icacls.exe")
        .arg(path)
        .args(["/grant:r", &format!("*S-1-1-0:(OI)(CI)({permission})")])
        .output()
        .unwrap();
    assert!(result.status.success(), "owned source ACL update failed");
}

#[test]
fn windows_read_shared_claude_and_codex_sources_are_discovered_without_acl_changes() {
    let home = tempfile::tempdir().unwrap();
    kcoder_config::set_user_only_dir_permissions(home.path()).unwrap();
    let id = "11111111-1111-4111-8111-111111111111";
    for (kind, product, config, contents, history) in [
        (
            MigrationSourceKind::ClaudeCode,
            ".claude",
            "settings.json",
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.invalid","ANTHROPIC_MODEL":"synthetic"}}"#,
            format!("projects/owned/{id}.jsonl"),
        ),
        (
            MigrationSourceKind::Codex,
            ".codex",
            "config.toml",
            "model = 'synthetic'\nmodel_provider = 'owned'\n[model_providers.owned]\nbase_url = 'https://example.invalid/v1'\nwire_api = 'responses'\n",
            format!("sessions/2026/10/20/rollout-2026-10-20T00-00-00-{id}.jsonl"),
        ),
    ] {
        let root = home.path().join(product);
        let file = root.join(history);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"{}\n").unwrap();
        std::fs::write(root.join(config), contents).unwrap();
        grant(&root, "RX");
        let descriptor = Command::new("icacls.exe")
            .arg(&root)
            .output()
            .unwrap()
            .stdout;
        let mut registry = SourceRegistry::new(DiscoveryRoots {
            home: home.path().to_owned(),
            claude_config_dir: None,
            codex_home: None,
            project: None,
        });
        let (configurations, problems) = registry.discover_with_assets(&[kind], false, false);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(configurations.len(), 1);
        assert_eq!(configurations[0].kind, kind);
        let page = registry.discover_history(kind, |_| true).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(std::fs::read(&file).unwrap(), b"{}\n");
        assert_eq!(
            std::fs::read_to_string(root.join(config)).unwrap(),
            contents
        );
        assert_eq!(
            Command::new("icacls.exe")
                .arg(&root)
                .output()
                .unwrap()
                .stdout,
            descriptor
        );

        grant(&root, "M");
        let (configurations, problems) = registry.discover_with_assets(&[kind], false, false);
        assert!(configurations.is_empty());
        assert!(
            problems
                .iter()
                .any(|p| p.code == "migration_source_directory_untrusted")
        );
        assert_eq!(
            registry
                .discover_history(kind, |_| true)
                .err()
                .unwrap()
                .to_string(),
            "history_discovery_root_untrusted"
        );
    }
}
