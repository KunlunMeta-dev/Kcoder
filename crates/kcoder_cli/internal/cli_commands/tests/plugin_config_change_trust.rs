use kcoder_cli_commands::entry_modes::{cli_folder_trusted, run_cli_config_change_hook};
use kcoder_config::{CONFIG_DIR_ENV, FolderTrustStore};
use serde_json::json;
use std::path::Path;

fn shell_literal(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        format!("'{}'", value.replace('\'', "''"))
    }
    #[cfg(not(windows))]
    {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

#[tokio::test]
async fn config_change_skips_project_plugin_hooks_until_folder_is_trusted() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let config = temp.path().join("config");
    let workspace = temp.path().join("workspace");
    let marker = temp.path().join("plugin-hook-ran");
    for directory in [&home, &config, &workspace] {
        std::fs::create_dir_all(directory).unwrap();
    }

    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var(CONFIG_DIR_ENV, &config);
        std::env::remove_var("KCODER_TRUST_ALL");
    }
    FolderTrustStore::load(&config).revoke(&workspace).unwrap();

    let plugin = workspace.join(".kcoder/plugins/project-plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    let command = if cfg!(windows) {
        format!(
            "Set-Content -LiteralPath {} -Value ran",
            shell_literal(&marker)
        )
    } else {
        format!("printf ran > {}", shell_literal(&marker))
    };
    std::fs::write(
        plugin.join("plugin.json"),
        serde_json::to_vec(&json!({
            "name": "project-plugin",
            "hooks": {
                "ConfigChange": [{
                    "hooks": [{"type": "command", "command": command}]
                }]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    assert!(!cli_folder_trusted(&workspace));
    run_cli_config_change_hook(&workspace, "test", json!({"action":"set"})).await;
    assert!(!marker.exists(), "untrusted project hook must not execute");

    FolderTrustStore::load(&config).trust(&workspace).unwrap();
    assert!(cli_folder_trusted(&workspace));
    run_cli_config_change_hook(&workspace, "test", json!({"action":"set"})).await;
    assert!(
        marker.exists(),
        "explicitly trusted project hook should execute"
    );
}
