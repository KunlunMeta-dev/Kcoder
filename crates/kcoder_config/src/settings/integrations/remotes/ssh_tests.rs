//! Selectors remain configuration data; none of these tests create an SSH owner.
use super::*;
use serde_json::json;
fn configured() -> serde_json::Value {
    json!({"enabled":true,"nativeSshPeers":[{"id":"explicit-ssh","enabled":true,"target":{"targetId":"selected-target","targetRevision":"frozen-config-revision","targetPlatform":"windows","expectedNativeSha256":"a".repeat(64)}}]})
}
#[test]
fn actual_settings_loader_accepts_only_the_declared_native_ssh_selector_schema() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("config");
    let project = root.path().join("project");
    let executable = root.path().join("executable");
    for path in [&config, &project, &executable] {
        std::fs::create_dir(path).unwrap();
    }
    let path = config.join("settings.json");
    let mut document = json!({"integrations":{"remotes": configured()}});
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    let loader = crate::SettingsLoader::new(&project)
        .with_config_dir(&config)
        .with_executable_dir(&executable);
    let loaded = loader.load().unwrap().settings;
    assert_eq!(loaded.integrations.remotes.native_ssh_peers.len(), 1);
    assert!(loaded.integrations.remotes.native_acp_peers.is_empty());
    document["integrations"]["remotes"]["nativeSshPeers"][0]["approved"] = json!(true);
    std::fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    assert!(loader.load().is_err());
}
#[test]
fn ssh_native_peers_are_explicit_and_do_not_change_the_local_profile_branch() {
    let defaults = RemoteIntegrationSettings::default();
    assert!(defaults.native_ssh_peers.is_empty() && defaults.native_acp_peers.is_empty());
    let value: RemoteIntegrationSettings = serde_json::from_value(configured()).unwrap();
    value.validate().unwrap();
    assert!(value.native_acp_peers.is_empty());
    assert_eq!(value.native_ssh_peers[0].maximum_duration_seconds, 120);
    let local: RemoteIntegrationSettings = serde_json::from_value(
        json!({"nativeAcpPeers":[{"id":"old-local","profileDirectory":std::env::temp_dir()}]}),
    )
    .unwrap();
    local.validate().unwrap();
    assert!(local.native_ssh_peers.is_empty());
}
#[test]
fn ids_are_unique_across_local_and_selected_target_peers_and_limits_are_combined() {
    let mut data = configured();
    data["nativeAcpPeers"] = json!([{"id":"explicit-ssh","profileDirectory":std::env::temp_dir()}]);
    let value: RemoteIntegrationSettings = serde_json::from_value(data).unwrap();
    assert!(value.validate().is_err());
    let mut value: RemoteIntegrationSettings = serde_json::from_value(configured()).unwrap();
    let peer = value.native_ssh_peers[0].clone();
    value.native_ssh_peers = (0..17)
        .map(|index| ConfiguredNativeSshPeer {
            id: format!("peer-{index}"),
            ..peer.clone()
        })
        .collect();
    assert!(value.validate().is_err());
}
#[test]
fn ssh_selectors_cannot_supply_commands_credentials_native_grants_or_source_paths() {
    for field in [
        "command",
        "environment",
        "approved",
        "sourceProfileDirectory",
        "receiverPid",
        "credential",
    ] {
        let mut data = configured();
        data["nativeSshPeers"][0][field] = json!(true);
        assert!(
            serde_json::from_value::<RemoteIntegrationSettings>(data).is_err(),
            "{field}"
        );
    }
    for field in ["targetPlatform", "expectedNativeSha256", "targetRevision"] {
        let mut data = configured();
        data["nativeSshPeers"][0]["target"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            serde_json::from_value::<RemoteIntegrationSettings>(data).is_err(),
            "{field}"
        );
    }
    for (field, value) in [
        ("targetId", json!("")),
        ("targetRevision", json!("")),
        ("expectedNativeSha256", json!("not-an-image-pin")),
    ] {
        let mut data = configured();
        data["nativeSshPeers"][0]["target"][field] = value;
        let value: RemoteIntegrationSettings = serde_json::from_value(data).unwrap();
        assert!(value.validate().is_err());
    }
}
