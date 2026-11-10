use super::*;
use clap::Parser;
use kcoder_api::ClientModelConfiguration;
use kcoder_config::{WebProxyMode, WebSettings};
use kcoder_types::web_search::WebSearchProvider;

#[test]
fn web_refresh_preserves_project_and_frozen_template_scopes_without_credentials_or_writes() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("profile");
    std::fs::create_dir(&config).unwrap();
    let path = config.join("settings.json");
    let mut host = WebSettings::default();
    std::fs::write(&path, serde_json::json!({"web":host}).to_string()).unwrap();
    // Invalid credential content must never be consulted by the public Web reader.
    std::fs::write(
        config.join("credentials.json"),
        "{invalid credential fixture",
    )
    .unwrap();
    let build = |name: &str, provider: WebSearchProvider| {
        let workspace = root.path().join(name);
        std::fs::create_dir(&workspace).unwrap();
        let project = workspace.join(".kcoder");
        std::fs::create_dir(&project).unwrap();
        let permitted: Vec<_> = host
            .search
            .providers
            .iter()
            .filter(|p| p.id == provider)
            .collect();
        std::fs::write(
            project.join("settings.json"),
            serde_json::json!({"web":{"search":{"providers":permitted}}}).to_string(),
        )
        .unwrap();
        let template = root.path().join(format!("{name}-template.json"));
        std::fs::write(
            &template,
            serde_json::json!({"web":{"search":{"preferredProvider":provider}}}).to_string(),
        )
        .unwrap();
        let loader = SettingsLoader::new(&workspace)
            .with_config_dir(&config)
            .with_executable_dir(root.path().join("no-executable-settings"))
            .with_overlay_files([template.clone()])
            .freeze_overlays()
            .unwrap();
        (
            ModelConfiguration::new(loader, crate::Cli::parse_from(["kcoder"])),
            workspace,
            template,
        )
    };
    let (first, first_workspace, first_template) = build("first", WebSearchProvider::Searxng);
    let (second, _, _) = build("second", WebSearchProvider::Bing);
    assert_eq!(
        first
            .web_settings()
            .unwrap()
            .unwrap()
            .search
            .candidates(None)
            .unwrap(),
        [WebSearchProvider::Searxng]
    );
    assert_eq!(
        second
            .web_settings()
            .unwrap()
            .unwrap()
            .search
            .candidates(None)
            .unwrap(),
        [WebSearchProvider::Bing]
    );
    host.fetch.proxy_mode = WebProxyMode::Direct;
    std::fs::write(&path, serde_json::json!({"web":host}).to_string()).unwrap();
    std::fs::write(
        &first_template,
        serde_json::json!({"web":{"search":{"preferredProvider":WebSearchProvider::Bing}}})
            .to_string(),
    )
    .unwrap();
    for (source, expected) in [
        (&first, WebSearchProvider::Searxng),
        (&second, WebSearchProvider::Bing),
    ] {
        let current = source.web_settings().unwrap().unwrap();
        assert_eq!(current.fetch.proxy_mode, WebProxyMode::Direct);
        assert_eq!(current.search.candidates(None).unwrap(), [expected]);
        assert_eq!(current.search.preferred_provider, Some(expected));
    }
    assert_eq!(
        std::fs::read_to_string(config.join("credentials.json")).unwrap(),
        "{invalid credential fixture"
    );
    assert!(!config.join("settings.lock").exists());
    assert!(!first_workspace.join(".kcoder/settings.local.json").exists());
    std::fs::write(
        first_workspace.join(".kcoder/settings.json"),
        r#"{"web":{"search":{"providers":[]}}}"#,
    )
    .unwrap();
    assert!(
        first.web_settings().is_err(),
        "a pinned template cannot reopen an externally revoked project ceiling"
    );
    assert_eq!(
        second
            .web_settings()
            .unwrap()
            .unwrap()
            .search
            .candidates(None)
            .unwrap(),
        [WebSearchProvider::Bing]
    );
}

#[test]
fn web_refresh_does_not_initialize_an_empty_bound_profile() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("absent-profile");
    let source = ModelConfiguration::new(
        SettingsLoader::new(root.path())
            .with_config_dir(&config)
            .with_executable_dir(root.path()),
        crate::Cli::parse_from(["kcoder"]),
    );
    assert_eq!(
        source.web_settings().unwrap().unwrap(),
        WebSettings::default()
    );
    assert!(!config.exists());
}

#[test]
fn web_refresh_refuses_an_unfinished_profile_transaction_without_recovering_it() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("profile");
    std::fs::create_dir(&config).unwrap();
    std::fs::write(config.join("settings.json"), "{}").unwrap();
    let journal = config.join(".provider-transaction.json");
    std::fs::write(&journal, "owned pending fixture").unwrap();
    let source = ModelConfiguration::new(
        SettingsLoader::new(root.path())
            .with_config_dir(&config)
            .with_executable_dir(root.path()),
        crate::Cli::parse_from(["kcoder"]),
    );
    assert!(source.web_settings().is_err());
    assert_eq!(
        std::fs::read_to_string(journal).unwrap(),
        "owned pending fixture"
    );
    assert_eq!(
        std::fs::read_to_string(config.join("settings.json")).unwrap(),
        "{}"
    );
}
