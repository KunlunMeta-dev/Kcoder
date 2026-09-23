mod dependency_graph;
mod schema;
mod validation;

#[allow(unused_imports)]
pub use schema::{
    ExpectedSkips, PlatformExpectedSkips, RequiredExecutable, Suite, SummaryParser, SummaryPolicy,
    TestMatrix,
};

#[cfg(test)]
mod tests {
    use super::*;
    use kcoder_test_harness::workspace_root;
    use std::path::PathBuf;

    fn matrix_path() -> PathBuf {
        workspace_root()
            .expect("应解析当前 KCoder 工作区")
            .join("tests/matrix.toml")
    }

    #[test]
    fn rejects_shell_string_and_parent_directory_shapes() {
        let shell_string = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='bad'\ntiers=['pr']\ncommand='cargo test'",
        );
        assert!(shell_string.is_err());

        let matrix = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='bad'\ntiers=['pr']\ncommand=['cargo','test']\ncwd='../outside'",
        )
        .unwrap();
        assert!(matrix.validate().is_err());
    }

    #[test]
    fn rejects_literal_secrets_in_matrix_environment() {
        let matrix = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='bad'\ntiers=['pr']\ncommand=['true']\n[suite.env]\nAPI_KEY='secret'",
        )
        .unwrap();

        assert!(matrix.validate().is_err());
    }

    #[test]
    fn explicit_secret_and_any_environment_metadata_must_be_forwarded() {
        let missing_secret = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='bad'\ntiers=['pr']\ncommand=['true']\nsecret_env=['ENDPOINT']",
        )
        .unwrap();
        assert!(missing_secret.validate().is_err());

        let valid = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='browser'\ntiers=['full']\ncommand=['true']\nrequires_any_env=[['SANDBOX','NO_SANDBOX']]\npass_env=['SANDBOX','NO_SANDBOX','ENDPOINT','SELECTOR']\nsecret_env=['ENDPOINT']\nsecret_env_selectors=['SELECTOR']",
        )
        .unwrap();
        assert!(valid.validate().is_ok());
    }

    #[test]
    fn executable_environment_metadata_is_strict_and_must_be_forwarded() {
        let missing_pass = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='desktop'\ntiers=['platform']\ncommand=['true']\nconsent='desktop'\nconsent_env='ALLOW_DESKTOP'\npass_env=['ALLOW_DESKTOP']\nrequires_executables=[{env='CODEX_BIN',allow_external=true}]",
        )
        .unwrap();
        assert!(missing_pass.validate().is_err());

        let valid = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='desktop'\ntiers=['platform']\ncommand=['true']\nconsent='desktop'\nconsent_env='ALLOW_DESKTOP'\npass_env=['ALLOW_DESKTOP','CODEX_BIN']\nrequires_executables=[{env='CODEX_BIN',allow_external=true}]",
        )
        .unwrap();
        assert!(valid.validate().is_ok());
        assert_eq!(valid.suite[0].requires_executables[0].env, "CODEX_BIN");
        assert!(valid.suite[0].requires_executables[0].allow_external);

        assert!(
            toml::from_str::<TestMatrix>(
                "schema_version=2\n[[suite]]\nid='bad'\ntiers=['pr']\ncommand=['true']\npass_env=['BIN']\nrequires_executables=[{env='BIN',allow_outside=true}]"
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_unknown_matrix_and_suite_fields() {
        assert!(
            toml::from_str::<TestMatrix>(
                "schema_version=2\nunknown=true\n[[suite]]\nid='ok'\ntiers=['pr']\ncommand=['true']"
            )
            .is_err()
        );
        assert!(
            toml::from_str::<TestMatrix>(
                "schema_version=2\n[[suite]]\nid='bad'\ntiers=['pr']\ncommand=['true']\nsecrect_env=['TOKEN']"
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_obsolete_schema_version() {
        let matrix = toml::from_str::<TestMatrix>(
            "schema_version=1\n[[suite]]\nid='old'\ntiers=['pr']\ncommand=['true']",
        )
        .unwrap();

        let error = matrix.validate().unwrap_err();
        assert!(error.to_string().contains("不支持的 matrix schema"));
    }

    #[test]
    fn protected_tiers_require_matching_double_consent_metadata() {
        let missing = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='live'\ntiers=['real-model']\ncommand=['true']",
        )
        .unwrap();
        assert!(missing.validate().is_err());

        let valid = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='live'\ntiers=['real-model']\ncommand=['true']\nconsent='real-model'\nconsent_env='ALLOW_LIVE'\npass_env=['ALLOW_LIVE']",
        )
        .unwrap();
        assert!(valid.validate().is_ok());

        let generic_platform = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='gpu'\ntiers=['platform']\ncommand=['true']\nconsent='linux-gpu'\nconsent_env='ALLOW_GPU'\npass_env=['ALLOW_GPU']",
        )
        .unwrap();
        assert!(generic_platform.validate().is_ok());
    }

    #[test]
    fn setup_dependency_may_cover_full_and_protected_tiers_without_consent() {
        let matrix = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='build'\ntiers=['full','real-model']\ncommand=['cargo','build']\nsetup=true\n[[suite]]\nid='smoke'\ntiers=['full']\ncommand=['true']\ndepends_on=['build']\n[[suite]]\nid='live'\ntiers=['real-model']\ncommand=['true']\ndepends_on=['build']\nconsent='real-model'\nconsent_env='ALLOW_LIVE'\npass_env=['ALLOW_LIVE']",
        )
        .unwrap();

        assert!(matrix.validate().is_ok());
    }

    #[test]
    fn rejects_dependency_without_consumer_tier_coverage_and_cycles() {
        let missing_tier = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='build'\ntiers=['full']\ncommand=['true']\nsetup=true\n[[suite]]\nid='live'\ntiers=['real-model']\ncommand=['true']\ndepends_on=['build']\nconsent='real-model'\nconsent_env='ALLOW_LIVE'\npass_env=['ALLOW_LIVE']",
        )
        .unwrap();
        assert!(missing_tier.validate().is_err());

        let cycle = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='a'\ntiers=['pr']\ncommand=['true']\ndepends_on=['b']\n[[suite]]\nid='b'\ntiers=['pr']\ncommand=['true']\ndepends_on=['a']",
        )
        .unwrap();
        assert!(cycle.validate().is_err());
    }

    #[test]
    fn studio_smoke_declares_nested_build_toolchain_requirements() {
        let matrix = TestMatrix::load(&matrix_path()).unwrap();
        let smoke = matrix
            .suite
            .iter()
            .find(|suite| suite.id == "studio-smoke")
            .unwrap();
        for command in ["cargo", "pnpm"] {
            assert!(smoke.requires_commands.contains(&command.to_string()));
        }
        assert!(smoke.command.contains(&"--keep-going".to_string()));
        for name in ["CARGO_HOME", "RUSTUP_HOME", "KCODER_E2E_CHROMIUM_BIN"] {
            assert!(smoke.pass_env.contains(&name.to_string()));
        }
    }

    #[test]
    fn tui_suites_preserve_runner_argv_tiers_consent_and_artifact_contracts() {
        let path = matrix_path();
        let matrix = TestMatrix::load(&path).unwrap();
        let suite = |id: &str| {
            matrix
                .suite
                .iter()
                .find(|suite| suite.id == id)
                .unwrap_or_else(|| panic!("matrix 必须声明 {id}"))
        };
        let expected = [
            (
                "tui-startup",
                vec!["pr", "full"],
                "startup",
                "project-test-runner-startup",
                300,
            ),
            (
                "tui-full-turn",
                vec!["full"],
                "run",
                "project-test-runner-full-turn",
                900,
            ),
            (
                "tui-subagent-trace",
                vec!["full"],
                "subagent-trace",
                "project-test-runner-subagent-trace",
                900,
            ),
            (
                "tui-session-resume",
                vec!["full"],
                "session-resume",
                "project-test-runner-session-resume",
                900,
            ),
        ];
        for (id, tiers, script, description, timeout) in expected {
            let suite = suite(id);
            assert_eq!(suite.tiers, tiers);
            assert_eq!(suite.command.get(3).map(String::as_str), Some(script));
            assert_eq!(suite.timeout_seconds, timeout);
            assert_eq!(suite.requires_commands, ["node", "npm", "cargo"]);
            assert_eq!(suite.required_artifacts, [PathBuf::from("assertions.json")]);
            assert_eq!(suite.requires_env, ["PLAYWRIGHT_BROWSERS_PATH"]);
            assert!(suite.command.contains(&"--software-webgl".to_string()));
            assert!(suite.pass_env.contains(&"CARGO_HOME".to_string()));
            assert!(suite.pass_env.contains(&"RUSTUP_HOME".to_string()));
            assert!(
                suite
                    .command
                    .windows(2)
                    .any(|pair| pair == ["--description", description])
            );
            assert!(
                suite
                    .command
                    .windows(2)
                    .any(|pair| pair == ["--out", "{artifact_dir}"])
            );
        }

        let native_shell = suite("tui-native-shell-prompt");
        assert_eq!(native_shell.tiers, ["platform"]);
        assert_eq!(
            native_shell.consent.as_deref(),
            Some("tui-native-shell-prompt")
        );
        assert_eq!(
            native_shell.consent_env.as_deref(),
            Some("KCODER_TEST_TUI_NATIVE_SHELL_PROMPT")
        );
        assert_eq!(native_shell.platforms, ["linux", "macos", "windows"]);
        assert_eq!(native_shell.timeout_seconds, 900);
        assert_eq!(
            native_shell.required_artifacts,
            [PathBuf::from("assertions.json")]
        );
        assert_eq!(native_shell.requires_env, ["PLAYWRIGHT_BROWSERS_PATH"]);
        assert!(
            native_shell
                .pass_env
                .contains(&"KCODER_TEST_TUI_NATIVE_SHELL_PROMPT".to_string())
        );
        assert!(
            native_shell
                .command
                .windows(2)
                .any(|pair| pair == ["--scenario", "full-turn"])
        );
    }

    #[test]
    fn cli_tests_are_split_by_public_entrypoint_and_stdio_contract() {
        let path = matrix_path();
        let matrix = TestMatrix::load(&path).unwrap();
        let expected = [
            ("cli-kcoder-unit", ["--bin", "kcoder"]),
            ("cli-app-server-stdio", ["--test", "app_server_stdio"]),
            ("cli-json-stdout", ["--test", "json_stdout"]),
        ];

        assert!(matrix.suite.iter().all(|suite| suite.id != "cli"));
        for (id, selector) in expected {
            let suite = matrix
                .suite
                .iter()
                .find(|suite| suite.id == id)
                .unwrap_or_else(|| panic!("matrix 必须声明 {id}"));
            assert_eq!(suite.tiers, ["pr", "full"]);
            assert!(suite.command.windows(2).any(|pair| pair == selector));
            assert!(
                suite
                    .command
                    .windows(2)
                    .any(|pair| pair == ["--", "--test-threads=1"])
            );
        }
    }

    #[test]
    fn project_matrix_keeps_every_test_product_in_the_root_orchestration_layer() {
        let path = matrix_path();
        let matrix = TestMatrix::load(&path).unwrap();
        let ids = matrix
            .suite
            .iter()
            .map(|suite| suite.id.as_str())
            .collect::<std::collections::BTreeSet<_>>();

        for required in [
            "rust-workspace",
            "project-contracts",
            "cli-kcoder-unit",
            "cli-app-server-stdio",
            "studio-unit",
            "studio-renderer-unit",
            "studio-harness",
            "studio-smoke",
            "studio-tauri-unit",
            "studio-browser-e2e",
            "studio-tauri-desktop-e2e",
            "tui-lab-unit",
            "tui-startup",
            "tui-full-turn",
            "tui-subagent-trace",
            "tui-session-resume",
            "tui-native-shell-prompt",
            "studio-real-model",
        ] {
            assert!(ids.contains(required), "根矩阵缺少测试产品入口 {required}");
        }

        let rust_workspace = matrix
            .suite
            .iter()
            .find(|suite| suite.id == "rust-workspace")
            .unwrap();
        assert!(
            rust_workspace
                .command
                .iter()
                .take(3)
                .map(String::as_str)
                .eq(["cargo", "test", "--workspace"]),
            "Rust 默认入口必须覆盖整个 workspace，而不是只跑 kcoder_engine"
        );
    }

    #[test]
    fn protected_endpoints_and_studio_native_prerequisites_are_explicit() {
        let path = matrix_path();
        let matrix = TestMatrix::load(&path).unwrap();
        let suite = |id: &str| {
            matrix
                .suite
                .iter()
                .find(|suite| suite.id == id)
                .unwrap_or_else(|| panic!("matrix 必须声明 {id}"))
        };

        let real_model = suite("studio-real-model");
        assert!(
            real_model
                .secret_env
                .contains(&"KCODER_E2E_MODEL_ENDPOINT".to_string())
        );
        assert!(
            real_model
                .secret_env_selectors
                .contains(&"KCODER_E2E_MODEL_CREDENTIAL_ENV".to_string())
        );

        let studio_smoke = suite("studio-smoke");
        assert!(studio_smoke.requires_any_env.iter().any(|alternatives| {
            alternatives.iter().map(String::as_str).collect::<Vec<_>>()
                == [
                    "KCODER_E2E_REQUIRE_CHROMIUM_SANDBOX",
                    "KCODER_E2E_CHROMIUM_NO_SANDBOX",
                ]
        }));
        assert_eq!(
            suite("studio-desktop-package-contract").depends_on,
            ["studio-desktop-package-build"]
        );
        assert!(
            suite("studio-tauri-unit")
                .tiers
                .contains(&"full".to_string()),
            "full tier 必须保留不依赖 Codex 的 Tauri 原生编译与单元测试"
        );
        assert_eq!(suite("studio-tauri-desktop-e2e").tiers, ["platform"]);
        let desktop = suite("studio-tauri-desktop-e2e");
        assert!(desktop.requires_files.iter().any(|path| {
            path.ends_with("src-tauri/binaries/wegent-executor-x86_64-unknown-linux-gnu")
        }));
        assert_eq!(
            desktop
                .env
                .get("KCODER_STUDIO_E2E_EXECUTOR_BIN")
                .map(String::as_str),
            Some("src-tauri/binaries/wegent-executor-x86_64-unknown-linux-gnu")
        );
        assert!(desktop.requires_env.is_empty());
        assert_eq!(desktop.requires_executables.len(), 1);
        assert_eq!(desktop.requires_executables[0].env, "CODEX_BIN");
        assert!(desktop.requires_executables[0].allow_external);
        assert_eq!(desktop.consent.as_deref(), Some("tauri-codex-desktop"));
        assert_eq!(
            desktop.consent_env.as_deref(),
            Some("KCODER_TEST_TAURI_CODEX_DESKTOP")
        );
        assert!(desktop.depends_on.is_empty());
    }

    #[test]
    fn project_matrix_declares_an_auditable_summary_policy_for_every_suite() {
        let path = matrix_path();
        let matrix = TestMatrix::load(&path).unwrap();
        assert!(matrix.suite.iter().all(|suite| suite.summary.is_some()));

        let policy = |id: &str| {
            matrix
                .suite
                .iter()
                .find(|suite| suite.id == id)
                .unwrap()
                .summary
                .as_ref()
                .unwrap()
        };
        assert_eq!(policy("rust-workspace").parser, SummaryParser::Cargo);
        assert!(policy("rust-workspace").expected_skips.accepts(11));
        assert!(!policy("rust-workspace").expected_skips.accepts(12));
        assert_eq!(policy("studio-unit").parser, SummaryParser::Node);
        assert_eq!(
            policy("studio-unit").expected_skips,
            ExpectedSkips::Exact(3)
        );
        assert_eq!(
            policy("studio-harness").expected_skips,
            ExpectedSkips::Exact(2)
        );
        assert_eq!(
            policy("studio-renderer-unit").parser,
            SummaryParser::VitestJson
        );
        assert_eq!(policy("tui-startup").parser, SummaryParser::AssertionsJson);
        assert!(policy("studio-typecheck").allow_zero);
    }

    #[test]
    fn summary_policy_rejects_implicit_exit_only_and_invalid_skip_wildcard() {
        let exit_only = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='build'\ntiers=['pr']\ncommand=['true']\nsummary={parser='exit-code'}",
        ).unwrap();
        assert!(exit_only.validate().is_err());

        let invalid_wildcard = toml::from_str::<TestMatrix>(
            "schema_version=2\n[[suite]]\nid='test'\ntiers=['pr']\ncommand=['true']\nsummary={parser='cargo',expected_skips='sometimes'}",
        ).unwrap();
        assert!(invalid_wildcard.validate().is_err());

        for expected_skips in ["{solaris=1}", "{linux='sometimes'}"] {
            let source = format!(
                "schema_version=2\n[[suite]]\nid='test'\ntiers=['pr']\ncommand=['true']\nsummary={{parser='cargo',expected_skips={expected_skips}}}"
            );
            assert!(
                toml::from_str::<TestMatrix>(&source)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
}
