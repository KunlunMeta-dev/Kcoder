//! Actual CLI invocations use owned binaries, profiles and sources; no model or MCP is executed.
#[path = "guide_cli.rs"]
mod guide;
use serde_json::{Value, json};
use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};
const KEY: &str = "SYNTHETIC_CLI_BATCH_KEY_PRIVATE";

#[test]
fn cli_batch_both_sources_jointly_import_selected_mcp_fields_and_provider_keys() {
    for source in ["claude-code", "codex"] {
        let f = Fixture::new(source);
        let unselected = "SYNTHETIC_CLI_UNSELECTED_MCP_VALUE";
        if source == "codex" {
            let mut text = std::fs::read_to_string(&f.config).unwrap();
            text.push_str(&format!(
                "[mcp_servers.docs0.env]\nTOKEN='{KEY}'\nUNSELECTED='{unselected}'\n"
            ));
            std::fs::write(&f.config, text).unwrap();
        } else {
            let mut value: Value =
                serde_json::from_slice(&std::fs::read(&f.config).unwrap()).unwrap();
            value["mcpServers"]["docs0"]["env"] = json!({"TOKEN":KEY,"UNSELECTED":unselected});
            std::fs::write(&f.config, value.to_string()).unwrap();
        }
        let original = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
        let scanned = f.scan(source);
        let page = f.call(&[
            "migrate",
            "items",
            "--target-profile",
            f.profile.to_str().unwrap(),
            "--job-id",
            scanned["job"]["jobId"].as_str().unwrap(),
        ]);
        let mcp = page["mcps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == "docs0")
            .unwrap();
        let path = f.options(&scanned, source, true, false);
        let mut options: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        options["mcpCredentials"] = json!([{"itemId":mcp["itemId"],"fields":[{"kind":"environment","name":"TOKEN"}],"consentPrivateValues":true}]);
        std::fs::write(&path, options.to_string()).unwrap();
        let planned = f.call(&[
            "migrate",
            "plan-batch",
            "--target-profile",
            f.profile.to_str().unwrap(),
            "--options",
            path.to_str().unwrap(),
        ]);
        assert_eq!(planned["batch"]["credentialActions"], 2);
        assert!(!f.profile.join("credentials.json").exists());
        let applied = f.operate(&planned, false);
        assert_eq!(applied["batch"]["publishedCredentials"], 2);
        let public = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
        assert!(!public.to_string().contains(KEY));
        let config: kcoder_types::McpServerConfig = serde_json::from_value(
            public["mcp_servers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|server| server["policy"]["credential_ref"].is_object())
                .unwrap()
                .clone(),
        )
        .unwrap();
        let values = kcoder_config::imported_credentials::ImportedCredentialStore::open(&f.profile)
            .unwrap()
            .resolve_mcp_with_mode(
                &config,
                kcoder_config::CredentialStoreMode::File,
                &kcoder_config::OsCredentialBackend::new(),
            )
            .unwrap();
        assert_eq!(values.env["TOKEN"], KEY);
        assert!(!values.env.contains_key("UNSELECTED"));
        assert!(
            !std::fs::read_to_string(f.profile.join("credentials.json"))
                .unwrap()
                .contains(unselected)
        );
        std::fs::remove_file(&f.config).unwrap();
        let undone = f.operate(&applied, true);
        assert_eq!(undone["job"]["status"], "rolled_back");
        assert_eq!(
            undone["batch"]["publishedCredentials"]
                .as_u64()
                .unwrap_or(0),
            0
        );
        assert_eq!(
            kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
            original
        );
    }
}

struct Fixture {
    root: tempfile::TempDir,
    binary: PathBuf,
    profile: PathBuf,
    home: PathBuf,
    config: PathBuf,
}
impl Fixture {
    fn new(source: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        for name in ["bin", "profile", "source-home", "ambient-home", "workspace"] {
            std::fs::create_dir(root.path().join(name)).unwrap();
        }
        let binary = root.path().join("bin").join(if cfg!(windows) {
            "kcoder.exe"
        } else {
            "kcoder"
        });
        if std::fs::hard_link(env!("CARGO_BIN_EXE_kcoder"), &binary).is_err() {
            std::fs::copy(env!("CARGO_BIN_EXE_kcoder"), &binary).unwrap();
        }
        let profile = root.path().join("profile");
        std::fs::write(
            profile.join("settings.json"),
            "{\n  \"credential_store\": \"file\"\n}\n",
        )
        .unwrap();
        let home = root.path().join("source-home");
        let vendor = home.join(if source == "codex" {
            ".codex"
        } else {
            ".claude"
        });
        std::fs::create_dir(&vendor).unwrap();
        let config = vendor.join(if source == "codex" {
            "config.toml"
        } else {
            "settings.json"
        });
        if source == "codex" {
            let mut text = "model='office-fixture'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\nenv_key='MIGRATION_CLI_TEST_API_KEY'\n".to_owned();
            for n in 0..14 {
                text.push_str(&format!(
                    "[mcp_servers.docs{n}]\ncommand='MUST_NOT_RUN_DURING_MIGRATION'\n"
                ));
            }
            std::fs::write(&config, text).unwrap();
        } else {
            let servers = (0..14)
                .map(|n| {
                    (
                        format!("docs{n}"),
                        json!({"command":"MUST_NOT_RUN_DURING_MIGRATION"}),
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            std::fs::write(&config, json!({"model":"office-fixture","env":{"ANTHROPIC_BASE_URL":"https://example.invalid/v1","ANTHROPIC_API_KEY":KEY},"mcpServers":servers}).to_string()).unwrap();
        }
        let skills = vendor.join("skills/office-report");
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("SKILL.md"), "---\nname: office-report\ndescription: Summarize office reports\n---\nCite the user's documents.\n").unwrap();
        std::fs::write(
            vendor.join(if source == "codex" {
                "AGENTS.md"
            } else {
                "CLAUDE.md"
            }),
            "Preserve the original documents.\n",
        )
        .unwrap();
        std::fs::write(
            vendor.join("auth.json"),
            "MUST_NOT_READ_OR_MIGRATE_AUTH_CACHE",
        )
        .unwrap();
        Self {
            root,
            binary,
            profile,
            home,
            config,
        }
    }
    fn invoke(&self, args: &[&str]) -> Output {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .current_dir(self.root.path().join("workspace"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", self.root.path().join("ambient-home"))
            .env("USERPROFILE", self.root.path().join("ambient-home"))
            .env("KCODER_CONFIG_DIR", self.root.path().join("unused-profile"))
            .env("MIGRATION_CLI_TEST_API_KEY", KEY)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().unwrap();
        let reader = |stream: Box<dyn Read + Send>| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                stream
                    .take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .unwrap();
                assert!(bytes.len() <= 2 * 1024 * 1024);
                bytes
            })
        };
        let stdout = reader(Box::new(child.stdout.take().unwrap()));
        let stderr = reader(Box::new(child.stderr.take().unwrap()));
        let start = Instant::now();
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                let result = Output {
                    status,
                    stdout: stdout.join().unwrap(),
                    stderr: stderr.join().unwrap(),
                };
                assert!(!String::from_utf8_lossy(&result.stdout).contains(KEY));
                assert!(!String::from_utf8_lossy(&result.stderr).contains(KEY));
                return result;
            }
            if start.elapsed() > Duration::from_secs(20) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned CLI migration exceeded its deadline");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn call(&self, args: &[&str]) -> Value {
        let result = self.invoke(args);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        serde_json::from_slice(&result.stdout).unwrap()
    }
    fn scan(&self, source: &str) -> Value {
        self.call(&[
            "migrate",
            "batch-scan",
            "--source",
            source,
            "--source-home",
            self.home.to_str().unwrap(),
            "--target-profile",
            self.profile.to_str().unwrap(),
        ])
    }
    fn options(&self, scanned: &Value, source: &str, credentials: bool, reuse: bool) -> PathBuf {
        let page = self.call(&[
            "migrate",
            "items",
            "--target-profile",
            self.profile.to_str().unwrap(),
            "--job-id",
            scanned["job"]["jobId"].as_str().unwrap(),
        ]);
        let item = page["providers"][0]["itemId"].as_str().unwrap();
        let path = self.root.path().join("choices.json");
        std::fs::write(&path, json!({"jobId":scanned["job"]["jobId"],"expectedSequence":scanned["job"]["sequence"],"includeDefaultItems":true,"reuseExisting":reuse,
            "choices":[{"kind":"provider","itemId":item,"targetName":"ImportedOffice","contextWindowTokens":128000,"outputHeadroomTokens":8192,"maxOutputTokens":8192}],
            "credentials":if credentials {vec![json!({"itemId":item,"source":if source=="codex" {"environment"} else {"configuration"},"consentApiKey":true})]}else{vec![]}}).to_string()).unwrap();
        path
    }
    fn plan(&self, scanned: &Value, source: &str, credentials: bool, reuse: bool) -> Value {
        let options = self.options(scanned, source, credentials, reuse);
        self.call(&[
            "migrate",
            "plan-batch",
            "--target-profile",
            self.profile.to_str().unwrap(),
            "--options",
            options.to_str().unwrap(),
        ])
    }
    fn operate(&self, job: &Value, undo: bool) -> Value {
        self.call(&[
            "migrate",
            if undo {
                "rollback-batch"
            } else {
                "apply-batch"
            },
            "--target-profile",
            self.profile.to_str().unwrap(),
            "--job-id",
            job["job"]["jobId"].as_str().unwrap(),
            "--plan-id",
            job["batch"]["planId"].as_str().unwrap(),
            "--request-id",
            if undo { "undo" } else { "apply" },
            "--expected-sequence",
            &job["job"]["sequence"].to_string(),
        ])
    }
}

#[test]
fn cli_explicit_template_choices_publish_after_their_connections_and_undo_together() {
    let f = Fixture::new("codex");
    let base = "profile='review'\nmodel='base-model'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\nenv_key='MIGRATION_CLI_TEST_API_KEY'\n[profiles.review]\nmodel='legacy-model'\n";
    std::fs::write(&f.config, base).unwrap();
    std::fs::write(
        f.config.parent().unwrap().join("review.config.toml"),
        "model='current-model'\nmodel_reasoning_effort='high'\n",
    )
    .unwrap();
    let scanned = f.scan("codex");
    let original = std::fs::read(f.profile.join("settings.json")).unwrap();
    let args = [
        "migrate",
        "items",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        scanned["job"]["jobId"].as_str().unwrap(),
    ];
    let legacy_shape = f.call(&args);
    assert!(legacy_shape.get("templates").is_none());
    let mut with_templates = args.to_vec();
    with_templates.push("--include-templates");
    let items = f.call(&with_templates);
    assert_eq!(items["templates"].as_array().unwrap().len(), 2);
    let choose = |items: &Value| {
        let mut choices = items["providers"].as_array().unwrap().iter().map(|provider| json!({
        "kind":"provider", "itemId":provider["itemId"], "targetName":format!("Imported-{}",provider["model"].as_str().unwrap()),
        "contextWindowTokens":128000,"outputHeadroomTokens":8192,"maxOutputTokens":8192,
    })).collect::<Vec<_>>();
        for template in items["templates"].as_array().unwrap() {
            choices.insert(0, json!({"kind":"template", "itemId":template["itemId"],
            "providerItemId":template["providerItemId"],
            "targetName":if template["name"].as_str().unwrap().starts_with("profiles.") {"legacy-review"} else {"current-review"},
        }));
        }
        choices
    };
    let choices = choose(&items);
    let credentials = items["providers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|provider| {
            json!({
                "itemId":provider["itemId"],"source":"environment","consentApiKey":true,
            })
        })
        .collect::<Vec<_>>();
    let path = f.root.path().join("templates-plan.json");
    std::fs::write(&path, json!({"jobId":scanned["job"]["jobId"],"expectedSequence":scanned["job"]["sequence"],"choices":choices,"credentials":credentials}).to_string()).unwrap();
    let planned = f.call(&[
        "migrate",
        "plan-batch",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--options",
        path.to_str().unwrap(),
    ]);
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
    assert!(!f.profile.join("templates/current-review.jsonc").exists());
    let applied = f.operate(&planned, false);
    assert_eq!(applied["job"]["committedItems"], 5);
    assert_eq!(applied["batch"]["publishedCredentials"], 3);
    let native =
        kcoder_config::settings_templates::SettingsTemplateStore::open(&f.profile).unwrap();
    assert!(native.list().unwrap().default_id.is_none());
    let current: Value =
        serde_json::from_str(&native.read("current-review").unwrap().content).unwrap();
    assert_eq!(current["active_provider"], "Imported-current-model");
    assert_eq!(current["model_reasoning_effort"], "high");
    let template_index = std::fs::read(f.profile.join("templates/index.json")).unwrap();
    let credential_bytes = std::fs::read(f.profile.join("credentials.json")).unwrap();
    let repeated = f.scan("codex");
    let repeated_items = f.call(&[
        "migrate",
        "items",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        repeated["job"]["jobId"].as_str().unwrap(),
        "--include-templates",
    ]);
    std::fs::write(&path, json!({"jobId":repeated["job"]["jobId"], "expectedSequence":repeated["job"]["sequence"], "reuseExisting":true, "choices":choose(&repeated_items)}).to_string()).unwrap();
    let reused_plan = f.call(&[
        "migrate",
        "plan-batch",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--options",
        path.to_str().unwrap(),
    ]);
    let reused = f.operate(&reused_plan, false);
    assert_eq!(reused["batch"]["reusedItems"], 5);
    assert_eq!(reused["job"]["committedItems"], 0);
    assert_eq!(f.operate(&reused, true)["job"]["status"], "rolled_back");
    assert_eq!(
        std::fs::read(f.profile.join("templates/index.json")).unwrap(),
        template_index
    );
    assert!(
        std::fs::read(f.profile.join("credentials.json")).unwrap() == credential_bytes,
        "reuse and its undo must not rewrite credentials"
    );
    assert_eq!(
        serde_json::from_str::<Value>(&native.read("current-review").unwrap().content).unwrap(),
        current
    );
    assert_eq!(f.operate(&applied, true)["job"]["status"], "rolled_back");
    assert!(native.list().unwrap().templates.is_empty());
    assert_eq!(
        kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
        serde_json::from_slice::<Value>(&original).unwrap()
    );
}

#[test]
fn cli_preserves_current_and_legacy_profile_connections_and_their_credential_dependencies() {
    let f = Fixture::new("codex");
    let base = "profile='review'\nmodel='base-model'\nmodel_provider='Office'\n[model_providers.Office]\nbase_url='https://example.invalid/v1'\nwire_api='responses'\nenv_key='MIGRATION_CLI_TEST_API_KEY'\n[profiles.review]\nmodel='legacy-model'\n";
    std::fs::write(&f.config, base).unwrap();
    let named = f.config.parent().unwrap().join("review.config.toml");
    std::fs::write(&named, "model='current-model'\n").unwrap();
    let original = std::fs::read(f.profile.join("settings.json")).unwrap();
    let scanned = f.scan("codex");
    let page = f.call(&[
        "migrate",
        "items",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        scanned["job"]["jobId"].as_str().unwrap(),
    ]);
    let providers = page["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 3, "{page}");
    let mut models = providers
        .iter()
        .map(|provider| provider["model"].as_str().unwrap())
        .collect::<Vec<_>>();
    models.sort();
    assert_eq!(models, ["base-model", "current-model", "legacy-model"]);
    let choices = providers
        .iter()
        .map(|provider| {
            json!({
                "kind":"provider", "itemId":provider["itemId"],
                "targetName":format!("Imported-{}", provider["model"].as_str().unwrap()),
                "contextWindowTokens":128000, "outputHeadroomTokens":8192, "maxOutputTokens":8192,
            })
        })
        .collect::<Vec<_>>();
    let credentials = providers
        .iter()
        .map(|provider| {
            json!({
                "itemId":provider["itemId"], "source":"environment", "consentApiKey":true,
            })
        })
        .collect::<Vec<_>>();
    let options = f.root.path().join("profile-choices.json");
    std::fs::write(
        &options,
        json!({
            "jobId":scanned["job"]["jobId"], "expectedSequence":scanned["job"]["sequence"],
            "choices":choices, "credentials":credentials,
        })
        .to_string(),
    )
    .unwrap();
    let planned = f.call(&[
        "migrate",
        "plan-batch",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--options",
        options.to_str().unwrap(),
    ]);
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        original
    );
    let applied = f.operate(&planned, false);
    assert_eq!(applied["batch"]["publishedCredentials"], 3);
    let target = kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap();
    let keys =
        kcoder_config::CredentialStore::load_from(&f.profile.join("credentials.json")).unwrap();
    for model in models {
        let name = format!("Imported-{model}");
        assert_eq!(target["providers"][&name]["default_model"], model);
        assert_eq!(keys.credentials[&name], KEY);
    }
    // Only the three selected connections complete; template conversion remains unresolved.
    assert_eq!(applied["job"]["status"], "completed");
    assert_eq!(applied["batch"]["selectedItems"], 3);
    assert!(applied["job"]["requiresActionItems"].as_u64().unwrap() >= 2);
    assert_eq!(std::fs::read_to_string(&f.config).unwrap(), base);
    assert_eq!(
        std::fs::read_to_string(&named).unwrap(),
        "model='current-model'\n"
    );
    std::fs::remove_file(&f.config).unwrap();
    std::fs::remove_file(named).unwrap();
    assert_eq!(f.operate(&applied, true)["job"]["status"], "rolled_back");
    assert_eq!(
        kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
        serde_json::from_slice::<Value>(&original).unwrap()
    );
}

#[test]
fn cli_direct_profile_selection_inherits_base_and_refuses_a_changed_base_before_publication() {
    let f = Fixture::new("codex");
    let named = f.config.parent().unwrap().join("review.config.toml");
    std::fs::write(&named, "model='current-model'\n").unwrap();
    let scan = f.call(&[
        "migrate",
        "scan",
        "--source",
        "codex",
        "--config",
        named.to_str().unwrap(),
    ]);
    let provider = scan["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["provider"].is_object())
        .unwrap();
    assert_eq!(provider["provider"]["model"], "current-model");
    assert_eq!(
        provider["provider"]["endpoint"],
        "https://example.invalid/v1"
    );
    let item_id = provider["preview"]["id"].as_str().unwrap();
    let planned = f.call(&[
        "migrate",
        "plan-provider",
        "--source",
        "codex",
        "--config",
        named.to_str().unwrap(),
        "--item-id",
        item_id,
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--target-name",
        "ProfileCurrent",
        "--context-window-tokens",
        "128000",
        "--output-headroom-tokens",
        "8192",
        "--max-output-tokens",
        "8192",
    ]);
    let before = std::fs::read(f.profile.join("settings.json")).unwrap();
    let base = std::fs::read_to_string(&f.config).unwrap();
    std::fs::write(&f.config, format!("# changed after preview\n{base}")).unwrap();
    let result = f.invoke(&[
        "migrate",
        "apply-provider",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--config",
        named.to_str().unwrap(),
        "--job-id",
        planned["jobId"].as_str().unwrap(),
        "--plan-id",
        planned["providerPlans"][0]["planId"].as_str().unwrap(),
        "--expected-sequence",
        &planned["sequence"].to_string(),
    ]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("migration_source_changed"));
    assert_eq!(
        std::fs::read(f.profile.join("settings.json")).unwrap(),
        before
    );
    assert!(!f.root.path().join("unused-profile").exists());
}

#[test]
fn cli_batch_both_sources_preview_page_publish_reuse_and_undo_with_private_credentials() {
    for source in ["claude-code", "codex"] {
        let f = Fixture::new(source);
        let original = std::fs::read(f.profile.join("settings.json")).unwrap();
        let source_bytes = std::fs::read(&f.config).unwrap();
        let scan = f.scan(source);
        assert!(scan["job"]["totalItems"].as_u64().unwrap() > 10);
        let page = f.call(&[
            "migrate",
            "items",
            "--target-profile",
            f.profile.to_str().unwrap(),
            "--job-id",
            scan["job"]["jobId"].as_str().unwrap(),
            "--page-index",
            "1",
        ]);
        assert!(
            !page["items"].as_array().unwrap().is_empty()
                && page["items"].as_array().unwrap().len() <= 10
        );
        let staged = f.plan(&scan, source, true, false);
        assert_eq!(staged["batch"]["atomicCredentials"], true);
        assert_eq!(
            std::fs::read(f.profile.join("settings.json")).unwrap(),
            original
        );
        assert!(!f.profile.join("credentials.json").exists());
        let applied = f.operate(&staged, false);
        // Saving definitions does not activate or validate the fourteen source MCP servers.
        assert_eq!(
            applied["job"]["status"], "completed_with_issues",
            "{source}: {applied}"
        );
        assert_eq!(
            applied["job"]["committedItems"],
            applied["job"]["totalItems"]
        );
        assert_eq!(applied["job"]["requiresActionItems"], 14);
        assert_eq!(applied["batch"]["unresolvedActions"], 0);
        assert_eq!(applied["batch"]["publishedCredentials"], 1);
        assert_eq!(
            kcoder_config::CredentialStore::load_from(&f.profile.join("credentials.json"))
                .unwrap()
                .credentials["ImportedOffice"],
            KEY
        );
        assert_eq!(f.operate(&staged, false), applied);
        let second = f.scan(source);
        let reused_plan = f.plan(&second, source, false, true);
        let reused = f.operate(&reused_plan, false);
        assert_eq!(reused["batch"]["reusedItems"], applied["job"]["totalItems"]);
        assert_eq!(f.operate(&reused, true)["job"]["status"], "rolled_back");
        let records = f.call(&[
            "migrate",
            "records",
            "--target-profile",
            f.profile.to_str().unwrap(),
        ]);
        assert_eq!(records["jobs"].as_array().unwrap().len(), 2);
        let status = f.call(&[
            "migrate",
            "status",
            "--target-profile",
            f.profile.to_str().unwrap(),
            "--job-id",
            applied["job"]["jobId"].as_str().unwrap(),
        ]);
        assert_eq!(status, applied);
        assert_eq!(std::fs::read(&f.config).unwrap(), source_bytes);
        std::fs::remove_file(&f.config).unwrap();
        assert_eq!(f.operate(&staged, false), applied);
        assert_eq!(f.operate(&applied, true)["job"]["status"], "rolled_back");
        assert_eq!(
            kcoder_config::read_settings_file(&f.profile.join("settings.json")).unwrap(),
            serde_json::from_slice::<Value>(&original).unwrap()
        );
        assert!(
            !kcoder_config::CredentialStore::load_from(&f.profile.join("credentials.json"))
                .unwrap()
                .credentials
                .contains_key("ImportedOffice")
        );
        assert!(!f.root.path().join("unused-profile").exists());
        assert!(!f.root.path().join("workspace/.kcoder").exists());
    }
}

#[test]
fn cli_batch_cancel_and_read_only_overlays_preserve_target_and_original_job() {
    let f = Fixture::new("claude-code");
    let scan = f.scan("claude-code");
    let options = f.options(&scan, "claude-code", true, false);
    let overlay = f.root.path().join("overlay.json");
    std::fs::write(&overlay, r#"{"mcp_disabled_servers":[]}"#).unwrap();
    let blocked = f.invoke(&[
        "--settings-file",
        overlay.to_str().unwrap(),
        "migrate",
        "plan-batch",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--options",
        options.to_str().unwrap(),
    ]);
    assert!(!blocked.status.success());
    assert!(
        String::from_utf8_lossy(&blocked.stderr).contains("migration_target_controlled_by_overlay")
    );
    let cancelled = f.call(&[
        "migrate",
        "cancel",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        scan["job"]["jobId"].as_str().unwrap(),
        "--expected-sequence",
        &scan["job"]["sequence"].to_string(),
    ]);
    assert_eq!(cancelled["job"]["status"], "cancelled");
    assert!(!f.profile.join("credentials.json").exists());
    let wrong = f.invoke(&[
        "migrate",
        "items",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        "../../auth",
    ]);
    assert!(!wrong.status.success());
}

#[test]
fn cli_batch_rejects_untrusted_projects_private_option_fields_and_linked_or_oversized_options() {
    let f = Fixture::new("claude-code");
    let project = f.root.path().join("workspace");
    let denied = f.invoke(&[
        "migrate",
        "batch-scan",
        "--source",
        "claude-code",
        "--source-home",
        f.home.to_str().unwrap(),
        "--project",
        project.to_str().unwrap(),
        "--target-profile",
        f.profile.to_str().unwrap(),
    ]);
    assert!(!denied.status.success());
    assert!(
        String::from_utf8_lossy(&denied.stderr).contains("migration_project_source_not_trusted")
    );
    let scanned = f.scan("claude-code");
    let options = f.options(&scanned, "claude-code", false, false);
    let original = std::fs::read(&options).unwrap();
    let mut value: Value = serde_json::from_slice(&original).unwrap();
    value["apiKey"] = json!(KEY);
    std::fs::write(&options, value.to_string()).unwrap();
    let run = || {
        f.invoke(&[
            "migrate",
            "plan-batch",
            "--target-profile",
            f.profile.to_str().unwrap(),
            "--options",
            options.to_str().unwrap(),
        ])
    };
    let rejected = run();
    assert!(!rejected.status.success());
    assert!(String::from_utf8_lossy(&rejected.stderr).contains("migration_invalid_options"));
    std::fs::write(&options, &original).unwrap();
    let alias = f.root.path().join("linked-options.json");
    std::fs::hard_link(&options, &alias).unwrap();
    assert!(!run().status.success());
    std::fs::remove_file(alias).unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&options)
        .unwrap()
        .set_len(2 * 1024 * 1024 + 1)
        .unwrap();
    let rejected = run();
    assert!(!rejected.status.success());
    assert!(
        String::from_utf8_lossy(&rejected.stderr).contains("migration_options_budget_exceeded")
    );
    let current = f.call(&[
        "migrate",
        "status",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        scanned["job"]["jobId"].as_str().unwrap(),
    ]);
    assert_eq!(current, scanned);
    assert!(!f.profile.join("credentials.json").exists());
}

#[test]
fn cli_batch_configuration_only_and_explicit_profile_catalog_do_not_read_ambient_assets() {
    let f = Fixture::new("claude-code");
    let scanned = f.call(&[
        "migrate",
        "batch-scan",
        "--source",
        "claude-code",
        "--source-home",
        f.home.to_str().unwrap(),
        "--configuration-only",
        "--target-profile",
        f.profile.to_str().unwrap(),
    ]);
    assert_eq!(scanned["job"]["totalItems"], 15);
    let full = f.scan("claude-code");
    let page = f.call(&[
        "migrate",
        "items",
        "--target-profile",
        f.profile.to_str().unwrap(),
        "--job-id",
        full["job"]["jobId"].as_str().unwrap(),
        "--page-index",
        "1",
    ]);
    let name = page["drafts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|draft| draft["choice"]["kind"] == "asset")
        .unwrap()["targetName"]
        .as_str()
        .unwrap();
    let ambient = f.root.path().join("unused-profile");
    let skill = ambient.join("skills").join(name);
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(skill.join("SKILL.md"), format!("---\nname: {name}\ndescription: Unrelated ambient profile\n---\nDo not use this profile.\n")).unwrap();
    let poisoned = "invalid ambient profile must never be parsed";
    std::fs::write(ambient.join("settings.json"), poisoned).unwrap();
    let preview = f.plan(&full, "claude-code", false, false);
    assert_eq!(preview["batch"]["selectedItems"], full["job"]["totalItems"]);
    assert_eq!(
        std::fs::read_to_string(ambient.join("settings.json")).unwrap(),
        poisoned
    );
    assert!(!f.profile.join("credentials.json").exists());
}
