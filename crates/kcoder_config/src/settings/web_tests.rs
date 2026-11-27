use super::*;
use serde_json::json;

fn resolved(value: serde_json::Value) -> Result<crate::Settings> {
    crate::validate_and_resolve_settings_document(&value)
}

#[test]
fn zero_configuration_has_the_complete_builtin_chain_and_no_second_tool_switch() {
    let settings = resolved(json!({})).unwrap();
    assert_eq!(settings.web, WebSettings::default());
    assert_eq!(
        settings.web.search.candidates(None).unwrap(),
        [
            WebSearchProvider::Exa,
            WebSearchProvider::Searxng,
            WebSearchProvider::Bing
        ]
    );
    let serialized = serde_json::to_value(&settings.web).unwrap();
    assert!(serialized["search"].get("enabled").is_none());
    assert_eq!(serialized["fetch"]["proxyMode"], "inherit");
    assert_eq!(crate::Settings::default().web, settings.web);
}

#[test]
fn explicit_empty_disabled_and_single_source_lists_never_restore_defaults() {
    for providers in [
        json!([]),
        json!([{"id":"exa-public","kind":"exa_mcp","enabled":false}]),
    ] {
        let settings = resolved(json!({"web":{"search":{"providers":providers}}})).unwrap();
        assert!(settings.web.search.candidates(None).unwrap().is_empty());
        assert!(settings.web.search.candidates(Some("exa")).is_err());
    }
    let settings = resolved(
        json!({"web":{"search":{"providers":[{"id":"searxng-bundled","kind":"searxng"}]}}}),
    )
    .unwrap();
    assert_eq!(
        settings.web.search.candidates(None).unwrap(),
        [WebSearchProvider::Searxng]
    );
    assert!(settings.web.search.candidates(Some("bing")).is_err());
}

#[test]
fn pinned_preferred_and_legacy_environment_respect_the_target_ceiling() {
    let settings = resolved(json!({"web":{"search":{"preferredProvider":"bing-html"}}})).unwrap();
    assert_eq!(
        settings.web.search.candidates(None).unwrap()[0],
        WebSearchProvider::Bing
    );
    assert_eq!(
        settings.web.search.candidates(Some("exa")).unwrap(),
        [WebSearchProvider::Exa]
    );
    let settings =
        resolved(json!({"web":{"search":{"mode":"pinned","preferredProvider":"bing-html"}}}))
            .unwrap();
    assert_eq!(
        settings.web.search.candidates(None).unwrap(),
        [WebSearchProvider::Bing]
    );
    assert_eq!(
        settings.web.search.candidates(Some("auto")).unwrap(),
        [WebSearchProvider::Bing]
    );
    assert!(
        settings
            .web
            .search
            .candidates(Some("unrecognized"))
            .is_err()
    );
    let settings = resolved(json!({"web":{"search":{"fallbackScope":"none"}}})).unwrap();
    assert_eq!(
        settings.web.search.candidates(None).unwrap(),
        [WebSearchProvider::Exa]
    );
}

#[test]
fn contradictory_or_secret_bearing_web_settings_are_rejected() {
    for value in [
        json!({"search":{"enabled":true}}),
        json!({"search":{"mode":"pinned"}}),
        json!({"search":{"providers":[],"preferredProvider":"exa-public"}}),
        json!({"search":{"providers":[{"id":"bing-html","kind":"exa_mcp"}]}}),
        json!({"search":{"providers":[{"id":"exa-public","kind":"exa_mcp"},{"id":"exa-public","kind":"exa_mcp","enabled":false}]}}),
        json!({"search":{"apiKey":"placeholder-not-a-key"}}),
        json!({"fetch":{"proxyMode":"configured"}}),
        json!({"fetch":{"proxyMode":"inherit","proxyEnv":"WEB_PROXY"}}),
        json!({"fetch":{"proxyMode":"configured","proxyEnv":"https://proxy.invalid"}}),
        json!({"fetch":{"proxyUrl":"https://private:placeholder@proxy.invalid"}}),
        json!({"fetch":{"networkPolicy":"allow-all"}}),
    ] {
        assert!(
            resolved(json!({"web":value})).is_err(),
            "invalid web configuration was accepted"
        );
    }
    let settings =
        resolved(json!({"web":{"fetch":{"proxyMode":"configured","proxyEnv":"OWNED_WEB_PROXY"}}}))
            .unwrap();
    assert_eq!(
        settings.web.fetch.proxy_env.as_deref(),
        Some("OWNED_WEB_PROXY")
    );
}

struct Layers {
    root: tempfile::TempDir,
    workspace: std::path::PathBuf,
    profile: std::path::PathBuf,
}

impl Layers {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let profile = root.path().join("profile");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        Self {
            root,
            workspace,
            profile,
        }
    }
    fn write(&self, path: &std::path::Path, value: serde_json::Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn loader(&self) -> crate::SettingsLoader {
        crate::SettingsLoader::new(&self.workspace)
            .with_config_dir(&self.profile)
            .with_executable_dir(self.root.path().join("empty-executable"))
    }
}

#[test]
fn actual_loader_needs_no_search_file_or_mcp_and_keeps_profiles_separate() {
    let a = Layers::new();
    let b = Layers::new();
    a.write(
        &a.profile.join("settings.json"),
        json!({"web":{"search":{"providers":[]}}}),
    );
    let first = a.loader().load_read_only_configuration().unwrap();
    let second = b.loader().load_read_only_configuration().unwrap();
    assert!(
        first
            .settings
            .web
            .search
            .candidates(None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(second.settings.web, WebSettings::default());
    assert!(!b.profile.join("settings.json").exists());
    assert!(!b.workspace.join(".kcoder").exists());
}

#[test]
fn actual_project_and_local_layers_can_narrow_but_cannot_widen_host_policy() {
    let f = Layers::new();
    f.write(
        &f.profile.join("settings.json"),
        json!({"web":{"search":{"providers":[{"id":"searxng-bundled","kind":"searxng"}]}}}),
    );
    let paths = f.loader().paths().unwrap();
    f.write(
        &paths.project_settings,
        json!({"web":{"search":{"providers":[]}}}),
    );
    assert!(
        f.loader()
            .load_read_only_configuration()
            .unwrap()
            .settings
            .web
            .search
            .candidates(None)
            .unwrap()
            .is_empty()
    );
    f.write(
        &paths.local_settings,
        json!({"web":{"search":{"providers":[{"id":"searxng-bundled","kind":"searxng"}]}}}),
    );
    assert!(
        f.loader().load_read_only_configuration().is_err(),
        "local scope restored a project-excluded source"
    );
    std::fs::remove_file(&paths.local_settings).unwrap();
    f.write(
        &paths.project_settings,
        json!({"web":{"search":{"providers":[{"id":"exa-public","kind":"exa_mcp"}]}}}),
    );
    assert!(
        f.loader().load_read_only_configuration().is_err(),
        "project scope added a host-excluded source"
    );
    f.write(
        &paths.project_settings,
        json!({"web":{"fetch":{"proxyMode":"direct"}}}),
    );
    assert!(
        f.loader().load_read_only_configuration().is_err(),
        "project replaced host proxy routing"
    );
}

#[test]
fn host_pinning_and_fallback_restrictions_cannot_be_widened_by_project() {
    let f = Layers::new();
    f.write(&f.profile.join("settings.json"),json!({"web":{"search":{"mode":"pinned","preferredProvider":"exa-public","fallbackScope":"none"}}}));
    let paths = f.loader().paths().unwrap();
    for search in [
        json!({"mode":"auto","fallbackScope":"builtin"}),
        json!({"preferredProvider":"bing-html"}),
    ] {
        f.write(&paths.project_settings, json!({"web":{"search":search}}));
        assert!(f.loader().load_read_only_configuration().is_err());
    }
}

#[test]
fn explicit_host_overlay_owns_its_source_set_and_can_supply_partial_fields() {
    let f = Layers::new();
    f.write(
        &f.profile.join("settings.json"),
        json!({"web":{"search":{"preferredProvider":"bing-html"}}}),
    );
    let overlay = f.root.path().join("explicit.json");
    f.write(&overlay, json!({"web":{"search":{"mode":"pinned"}}}));
    let loaded = f
        .loader()
        .with_overlay_files([overlay.clone()])
        .load_read_only_configuration()
        .unwrap();
    assert_eq!(
        loaded.settings.web.search.candidates(None).unwrap(),
        [WebSearchProvider::Bing]
    );
    f.write(
        &overlay,
        json!({"web":{"search":{"mode":"auto","preferredProvider":null,"providers":[]}}}),
    );
    let loaded = f
        .loader()
        .with_overlay_files([overlay])
        .load_read_only_configuration()
        .unwrap();
    assert!(
        loaded
            .settings
            .web
            .search
            .candidates(None)
            .unwrap()
            .is_empty()
    );
}
