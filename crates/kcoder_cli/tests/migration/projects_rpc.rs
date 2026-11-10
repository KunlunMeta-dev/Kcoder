use super::{TestAppServer, json, rpc};
use std::{path::Path, time::Duration};

fn run(
    server: &mut TestAppServer,
    job: &str,
    plan: &serde_json::Value,
    sequence: &serde_json::Value,
    rollback: bool,
) -> serde_json::Value {
    rpc(
        server,
        100,
        "migration/batch/run",
        json!({"jobId":job,"planId":plan,"requestId":if rollback{"projects-owned-undo"}else{"projects-owned-apply"},"expectedSequence":sequence,"mode":if rollback{"rollback"}else{"apply"}}),
    );
    for id in 101..301 {
        let state = rpc(server, id, "migration/batch/read", json!({"jobId":job}));
        if state["workerRunning"] == false {
            return state;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("project batch worker did not settle");
}
fn codex_registry(path: &Path) {
    let db = rusqlite::Connection::open(path.join("state_5.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,metadata TEXT,position INTEGER NOT NULL,created_at_ms INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL);CREATE TABLE project_roots(project_id TEXT NOT NULL,position INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,position));").unwrap();
    for i in 0..13 {
        db.execute(
            "INSERT INTO projects VALUES(?1,?2,'PRIVATE_PROJECT_METADATA',?3,123,456)",
            rusqlite::params![format!("original-{i:02}"), format!("Source {i:02}"), i],
        )
        .unwrap();
        db.execute(
            "INSERT INTO project_roots VALUES(?1,0,?2)",
            rusqlite::params![
                format!("original-{i:02}"),
                format!("/source-path-never-opened/{i:02}")
            ],
        )
        .unwrap();
    }
}
#[test]
fn both_project_registries_page_select_explicit_native_workspace_publish_reopen_and_undo() {
    for codex in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let cwd = root.path().join("workspace");
        let source = root.path().join("source-registry");
        let empty = root.path().join("empty-home");
        for path in [&profile, &cwd, &source, &empty] {
            kcoder_config::PrivateDirectory::open_or_create(path).unwrap();
        }
        std::fs::write(cwd.join("USER_FILE"), b"USER_FILE_MUST_REMAIN").unwrap();
        let settings = r#"{"credential_store":"file","active_provider":"User","providers":{"User":{"api_format":"openai_chat_completions","endpoint":"https://example.invalid/v1","authentication":{"mode":"none"},"default_model":"inert","discover_models":false,"context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192}}}"#;
        std::fs::write(profile.join("settings.json"), settings).unwrap();
        let mut trust = kcoder_config::FolderTrustStore::load(&profile);
        trust.trust(&cwd).unwrap();
        let overlay = root.path().join("overlay.json");
        std::fs::write(&overlay, "{}").unwrap();
        if codex {
            codex_registry(&source);
        } else {
            let projects=(0..13).map(|i|(format!("/source-path-never-opened/{i:02}"),json!({"PRIVATE_PROJECT_METADATA":"NEVER_EXPORT","mcpServers":{"must-not-execute":{}}}))).collect::<serde_json::Map<_,_>>();
            std::fs::write(
                source.join(".claude.json"),
                json!({"oauthAccount":{"token":"PRIVATE_PROJECT_TOKEN"},"projects":projects})
                    .to_string(),
            )
            .unwrap();
        }
        let start = || {
            let mut builder = TestAppServer::builder(&cwd, &overlay)
                .config_dir(&profile)
                .without_scenario()
                .discard_stderr();
            for key in ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] {
                builder
                    .extra_env
                    .push((key.into(), empty.as_os_str().into()));
            }
            let mut server = builder.spawn();
            rpc(
                &mut server,
                1,
                "initialize",
                json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"projects-owned-fixture","version":"test"}}),
            );
            server
        };
        let mut server = start();
        // The normal Native writer explicitly registers this real target. The source path never authorizes it.
        rpc(
            &mut server,
            2,
            "runtime.projects.upsert_local",
            json!({"deviceId":"local","runtime":"kcoder","projectKey":"user-owned-project","name":"User custom label","roots":[cwd]}),
        );
        let kind = if codex { "codex" } else { "claude-code" };
        rpc(
            &mut server,
            3,
            "migration/source/directory/select",
            json!({"selectionId":uuid::Uuid::new_v4().to_string(),"source":kind,"directory":source}),
        );
        let first = rpc(
            &mut server,
            4,
            "migration/projects/discover",
            json!({"source":kind}),
        );
        assert_eq!(first["items"].as_array().unwrap().len(), 10, "{first}");
        assert_eq!(first["knownRowsComplete"], true);
        let second = rpc(
            &mut server,
            5,
            "migration/projects/sources",
            json!({"catalogId":first["catalogId"],"pageIndex":1}),
        );
        assert_eq!(second["items"].as_array().unwrap().len(), 3);
        assert!(!first.to_string().contains("PRIVATE_PROJECT"));
        let selected = first["items"][0]["sourceHandle"].clone();
        let roots = rpc(
            &mut server,
            6,
            "migration/projects/source-roots",
            json!({"catalogId":first["catalogId"],"sourceHandle":selected}),
        );
        let targets = rpc(&mut server, 7, "migration/projects/targets", json!({}));
        assert_eq!(targets["registeredWorkspacesObserved"], true);
        let target = &targets["items"][0];
        assert_eq!(target["displayName"], "User custom label");
        let target_roots = rpc(
            &mut server,
            8,
            "migration/projects/target-roots",
            json!({"targetCatalogId":targets["targetCatalogId"],"targetHandle":target["targetHandle"]}),
        );
        assert_eq!(target_roots["roots"][0]["trusted"], true);
        let scanned = rpc(
            &mut server,
            9,
            "migration/batch/scan",
            json!({"sourceIds":[],"projectSources":[{"catalogId":first["catalogId"],"sourceHandle":selected}]}),
        );
        let job = scanned["job"]["jobId"].as_str().unwrap();
        let items = rpc(&mut server, 10, "migration/items", json!({"jobId":job}));
        assert!(items["drafts"][0]["choice"].is_null());
        let item = items["drafts"][0]["itemId"].clone();
        let planned = rpc(
            &mut server,
            11,
            "migration/batch/plan",
            json!({"jobId":job,"expectedSequence":scanned["job"]["sequence"],"choices":[{"kind":"project","itemId":item,"mapping":{"targetCatalogId":targets["targetCatalogId"],"targetHandle":target["targetHandle"],"mappings":[{"sourceRootId":roots["roots"][0]["sourceRootId"],"targetRootHandle":target_roots["roots"][0]["targetRootHandle"]}]}}],"includeDefaultItems":false}),
        );
        let report = rpc(
            &mut server,
            12,
            "migration/projects/report",
            json!({"jobId":job,"itemId":item}),
        );
        assert!(report["fields"].as_array().unwrap().len() <= 10);
        assert!(!report.to_string().contains("PRIVATE_PROJECT"));
        let applied = run(
            &mut server,
            job,
            &planned["batch"]["planId"],
            &planned["job"]["sequence"],
            false,
        );
        assert_eq!(applied["state"]["job"]["status"], "completed", "{applied}");
        assert_eq!(
            kcoder_config::imported_projects::ImportedProjectAssociationsStore::open(&profile)
                .unwrap()
                .list()
                .unwrap()
                .len(),
            1
        );
        let registry_root = profile.join("projects");
        assert!(registry_root.is_dir());
        std::fs::rename(&source, root.path().join("source-withheld")).unwrap();
        drop(server);
        let mut server = start();
        let reopened = rpc(
            &mut server,
            13,
            "migration/batch/read",
            json!({"jobId":job}),
        );
        assert_eq!(reopened["state"]["job"]["status"], "completed");
        let report = rpc(
            &mut server,
            14,
            "migration/projects/report",
            json!({"jobId":job,"itemId":item}),
        );
        assert!(!report.to_string().contains("PRIVATE_PROJECT"));
        let undone = run(
            &mut server,
            job,
            &planned["batch"]["planId"],
            &reopened["state"]["job"]["sequence"],
            true,
        );
        assert_eq!(undone["state"]["job"]["status"], "rolled_back", "{undone}");
        assert!(
            kcoder_config::imported_projects::ImportedProjectAssociationsStore::open(&profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            std::fs::read(cwd.join("USER_FILE")).unwrap(),
            b"USER_FILE_MUST_REMAIN"
        );
        assert_eq!(
            std::fs::read_to_string(profile.join("settings.json")).unwrap(),
            settings
        );
        let list = rpc(
            &mut server,
            15,
            "runtime.workspaces.list",
            json!({"deviceId":"local"}),
        );
        assert_eq!(list["items"][0]["label"], "User custom label");
    }
}

#[test]
fn project_registration_preserves_peer_records_under_the_original_cross_process_writer_lock() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let cwd = root.path().join("workspace");
    for path in [&profile, &cwd] {
        kcoder_config::PrivateDirectory::open_or_create(path).unwrap();
    }
    let overlay = root.path().join("empty-overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    std::fs::write(profile.join("settings.json"), r#"{"credential_store":"file","active_provider":"inert","providers":{"inert":{"api_format":"openai_chat_completions","endpoint":"https://example.invalid","authentication":{"mode":"none"},"default_model":"inert","discover_models":false,"context_window_tokens":128000,"output_headroom_tokens":8192,"max_output_tokens":8192}}}"#).unwrap();
    let start = || {
        let mut builder = TestAppServer::builder(&cwd, &overlay)
            .config_dir(&profile)
            .without_scenario()
            .discard_stderr();
        for key in ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] {
            builder
                .extra_env
                .push((key.into(), root.path().as_os_str().into()));
        }
        let mut server = builder.spawn();
        rpc(
            &mut server,
            1,
            "initialize",
            json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-project-registration","version":"test"}}),
        );
        server
    };
    let mut a = start();
    let mut b = start();
    rpc(&mut a, 69, "runtime.workspaces.list", json!({}));
    let initial = rpc(
        &mut a,
        70,
        "migration/projects/targets",
        json!({"pageIndex":0}),
    );
    assert!(!initial["items"].as_array().unwrap().is_empty());
    assert_eq!(initial["registeredWorkspacesObserved"], false);
    assert!(
        super::super::find_named_file(root.path(), "client-workspaces.json").is_none(),
        "project reads must not publish an empty registry"
    );
    for (server, key) in [(&mut a, "peer-A"), (&mut b, "peer-B")] {
        server.send(json!({"jsonrpc":"2.0","id":2,"method":"runtime.projects.upsert_local","params":{"runtime":"kcoder","deviceId":"local","projectKey":key,"name":key,"roots":[cwd.join(".")],"preserveExisting":true}}));
    }
    let first = a.response(2);
    let second = b.response(2);
    assert_ne!(
        first.get("error").is_some(),
        second.get("error").is_some(),
        "{first} {second}"
    );
    let conflict = if first.get("error").is_some() {
        &first
    } else {
        &second
    };
    assert_eq!(
        conflict["error"]["message"],
        "workspace_project_already_registered"
    );
    let registry = super::super::find_named_file(root.path(), "client-workspaces.json")
        .expect("the original Native writer created its registry under this owned fixture");
    let bytes = std::fs::read(&registry).unwrap();
    let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let key = dunce::canonicalize(&cwd)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    std::fs::write(&registry, b"unknown registry format").unwrap();
    a.send(json!({"jsonrpc":"2.0","id":71,"method":"migration/projects/targets","params":{"pageIndex":0}}));
    assert!(
        a.response(71).get("error").is_some(),
        "unknown registry metadata must not be treated as an empty registry"
    );
    a.send(json!({"jsonrpc":"2.0","id":72,"method":"runtime.projects.upsert_local","params":{"projectKey":"no-corrupt-overwrite","name":"must-not-repair","roots":[cwd],"preserveExisting":true}}));
    assert!(
        a.response(72).get("error").is_some(),
        "preserveExisting must not silently reset a corrupt registry"
    );
    assert_eq!(
        std::fs::read(&registry).unwrap(),
        b"unknown registry format"
    );
    let mut future = data.clone();
    future["futureUserMetadata"] = json!({"keep":"unknown metadata"});
    let future_bytes = serde_json::to_vec(&future).unwrap();
    std::fs::write(&registry, &future_bytes).unwrap();
    a.send(json!({"jsonrpc":"2.0","id":73,"method":"runtime.projects.upsert_local","params":{"projectKey":"no-future-drop","name":"must-not-normalize","roots":[cwd],"preserveExisting":true}}));
    assert!(
        a.response(73).get("error").is_some(),
        "unknown fields must not disappear during registration"
    );
    assert_eq!(std::fs::read(&registry).unwrap(), future_bytes);
    std::fs::write(&registry, &bytes).unwrap();
    let winner = data["records"][&key]["projectKey"].as_str().unwrap();
    assert!(matches!(winner, "peer-A" | "peer-B"));
    a.send(json!({"jsonrpc":"2.0","id":3,"method":"runtime.projects.upsert_local","params":{"projectKey":"must-not-reassign","name":"must-not-rename","roots":[cwd],"preserveExisting":true}}));
    assert_eq!(
        a.response(3)["error"]["message"],
        "workspace_project_already_registered"
    );
    assert_eq!(std::fs::read(&registry).unwrap(), bytes);
    rpc(
        &mut a,
        4,
        "runtime.projects.upsert_local",
        json!({"projectKey":"explicit-legacy-edit","name":"Explicit user edit","roots":[cwd]}),
    );
    let changed: serde_json::Value =
        serde_json::from_slice(&std::fs::read(registry).unwrap()).unwrap();
    assert_eq!(changed["records"][key]["label"], "Explicit user edit");
}
