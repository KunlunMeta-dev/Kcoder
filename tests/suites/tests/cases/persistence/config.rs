use kcoder_config::{FolderTrust, FolderTrustStore};

#[test]
fn folder_trust_decisions_survive_a_store_reload() {
    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let config_dir = temporary.path().join("config");
    let project = temporary.path().join("workspace");
    let nested = project.join("nested");
    std::fs::create_dir_all(&nested).expect("workspace should be created");

    let mut store = FolderTrustStore::load(&config_dir);
    assert_eq!(store.check(&project), FolderTrust::Unknown);
    store
        .trust(&project)
        .expect("trust decision should persist");

    let reloaded = FolderTrustStore::load(&config_dir);
    assert_eq!(reloaded.check(&project), FolderTrust::Trusted);
    assert_eq!(reloaded.check(&nested), FolderTrust::Trusted);
}

#[test]
fn malformed_trust_storage_fails_closed() {
    let temporary = tempfile::tempdir().expect("temporary directory should be created");
    let project = temporary.path().join("workspace");
    std::fs::create_dir_all(&project).expect("workspace should be created");
    std::fs::write(temporary.path().join("trusted-folders.json"), "not-json")
        .expect("malformed fixture should be written");

    let store = FolderTrustStore::load(temporary.path());
    assert_eq!(store.check(&project), FolderTrust::Unknown);
}
