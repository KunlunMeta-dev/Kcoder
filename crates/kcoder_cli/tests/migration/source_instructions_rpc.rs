//! Owned source/target processes exercise explicit instruction capture, receipt mapping and original Undo.
use super::*;
use base64::engine::general_purpose::STANDARD;
use kcoder_config::imported_context::ImportedContextStore;

fn trusted(profile: &Profile) {
    std::fs::write(
        profile.profile.join("trusted-folders.json"),
        json!({"trusted":[profile.workspace],"never":[]}).to_string(),
    )
    .unwrap();
}
fn capture(
    server: &mut TestAppServer,
    id: &mut i64,
    profile: &Profile,
    kind: &str,
    descendants: bool,
) -> (String, Value) {
    let capture = uuid::Uuid::new_v4().to_string();
    let request = json!({"captureId":capture,"source":kind,"format":"static_v2","sourceRoot":profile.workspace,"sourceCwd":profile.workspace,"includeDescendants":descendants,"confirmStaticSubset":true});
    rpc(
        server,
        id,
        "migration/instructions/capture",
        request.clone(),
    );
    (capture, request)
}
fn page(server: &mut TestAppServer, id: &mut i64, target: Value, index: u32) -> Value {
    rpc(
        server,
        id,
        "migration/instructions/page",
        json!({"target":target,"pageIndex":index}),
    )
}

#[test]
fn instruction_capture_pages_original_and_compiled_bytes_and_lost_reply_never_refreshes_source() {
    let root = tempfile::tempdir().unwrap();
    let observer = ModelObserver::new();
    let profile = Profile::new(root.path(), "capture", &observer.endpoint);
    trusted(&profile);
    std::fs::create_dir(profile.workspace.join("docs")).unwrap();
    std::fs::write(
        profile.workspace.join("docs/style.md"),
        "Static imported style.\n",
    )
    .unwrap();
    let original = format!(
        "<!-- original hidden comment -->\n@docs/style.md\n{}",
        "正文".repeat(10000)
    );
    std::fs::write(profile.workspace.join("CLAUDE.md"), &original).unwrap();
    for index in 0..12 {
        let child = profile.workspace.join(format!("child-{index:02}"));
        std::fs::create_dir(&child).unwrap();
        std::fs::write(
            child.join("CLAUDE.md"),
            format!("Child {index} static guide."),
        )
        .unwrap();
    }
    let mut server = profile.start(true);
    let mut id = 0;
    initialize(&mut server, &mut id, true);
    let (capture, request) = capture(&mut server, &mut id, &profile, "claude-code", true);
    let target = json!({"kind":"source","captureId":capture});
    let first = page(&mut server, &mut id, target.clone(), 0);
    let second = page(&mut server, &mut id, target.clone(), 1);
    assert_eq!(first["items"].as_array().unwrap().len(), 10);
    assert_eq!(second["items"].as_array().unwrap().len(), 3);
    assert_eq!(first["totalItems"], 13);
    assert_eq!(first["nextPage"], 1);
    assert_eq!(second["nextPage"], Value::Null);
    assert!(
        !first
            .to_string()
            .contains(profile.workspace.to_str().unwrap())
    );
    let item = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["relativePath"] == "CLAUDE.md")
        .unwrap()["itemId"]
        .clone();
    let raw = rpc(
        &mut server,
        &mut id,
        "migration/instructions/body",
        json!({"target":target,"itemId":item,"representation":"original"}),
    );
    assert!(raw["nextOffset"].is_number());
    assert!(
        STANDARD
            .decode(raw["bytesBase64"].as_str().unwrap())
            .unwrap()
            .len()
            <= 16384
    );
    assert!(raw["text"].as_str().unwrap().contains("@docs/style.md"));
    let compiled = rpc(
        &mut server,
        &mut id,
        "migration/instructions/body",
        json!({"target":target,"itemId":item,"representation":"compiled"}),
    );
    assert!(
        compiled["text"]
            .as_str()
            .unwrap()
            .contains("Static imported style.")
    );
    assert!(
        !compiled["text"]
            .as_str()
            .unwrap()
            .contains("original hidden comment")
    );
    assert_ne!(raw["sha256"], compiled["sha256"]);
    std::fs::rename(&profile.workspace, profile.root.join("source-withheld")).unwrap();
    let same = rpc(
        &mut server,
        &mut id,
        "migration/instructions/capture",
        request,
    );
    assert_eq!(same["sourceRevision"], first["items"][0]["sourceRevision"]);
    assert_eq!(page(&mut server, &mut id, target.clone(), 0), first);
    let again = rpc(
        &mut server,
        &mut id,
        "migration/instructions/body",
        json!({"target":target,"itemId":item,"representation":"original"}),
    );
    assert_eq!(again, raw);
    stop(server);
    assert_eq!(observer.inference.load(Ordering::Acquire), 0);
}

#[test]
fn two_source_formats_transfer_as_data_map_each_scope_and_reopen_original_batch_and_undo_without_sources()
 {
    for (kind, filename) in [("claude-code", "CLAUDE.md"), ("codex", "AGENTS.md")] {
        let root = tempfile::tempdir().unwrap();
        let observer = ModelObserver::new();
        let source_profile = Profile::new(root.path(), "source", &observer.endpoint);
        let target_profile = Profile::new(root.path(), "target", &observer.endpoint);
        trusted(&source_profile);
        trusted(&target_profile);
        std::fs::create_dir(source_profile.workspace.join(".git")).unwrap();
        std::fs::create_dir(source_profile.workspace.join("child")).unwrap();
        std::fs::write(
            source_profile.workspace.join(filename),
            "Original root guide.\n",
        )
        .unwrap();
        std::fs::write(
            source_profile.workspace.join("child").join(filename),
            "Original child guide.\n",
        )
        .unwrap();
        std::fs::create_dir(target_profile.workspace.join("mapped")).unwrap();
        let settings = std::fs::read(&target_profile.settings).unwrap();
        let mut source = source_profile.start(true);
        let mut target = target_profile.start(true);
        let mut id = 0;
        initialize(&mut source, &mut id, true);
        initialize(&mut target, &mut id, true);
        let (capture, _) = capture(&mut source, &mut id, &source_profile, kind, true);
        let source_identity = internal(&mut source, &mut id, "identity", json!({}));
        let target_identity = internal(&mut target, &mut id, "identity", json!({}));
        let request = uuid::Uuid::new_v4().to_string();
        let endpoint = |identity: &Value, name: &str| json!({"authority":identity["authority"],"targetFingerprint":name,"principal":{"kind":"localOs"}});
        let proof = json!({"version":1,"requestId":request,"source":endpoint(&source_identity,"owned-source"),"target":endpoint(&target_identity,"owned-target")});
        let source_peer = accept(&mut source, &mut id, &request, "source", &proof);
        let target_peer = accept(&mut target, &mut id, &request, "target", &proof);
        let destination = internal(
            &mut target,
            &mut id,
            "target/grant",
            bound(&request, &target_peer, json!({})),
        );
        internal(
            &mut source,
            &mut id,
            "source/prepare",
            bound(
                &request,
                &source_peer,
                json!({"destination":destination,"selections":[{"kind":"instructions","captureId":capture}]}),
            ),
        );
        internal(
            &mut source,
            &mut id,
            "source/capture",
            bound(&request, &source_peer, json!({})),
        );
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let state = internal(
                &mut source,
                &mut id,
                "source/state",
                bound(&request, &source_peer, json!({})),
            );
            if state["capture"]["status"] == "ready" {
                break;
            }
            assert_eq!(state["capture"]["status"], "running", "{state}");
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        }
        let exported = internal(
            &mut source,
            &mut id,
            "source/manifest",
            bound(&request, &source_peer, json!({})),
        );
        let manifest = &exported["manifest"];
        assert_eq!(
            manifest["entries"][0]["content"]["kind"],
            "instruction_bundle"
        );
        internal(
            &mut target,
            &mut id,
            "target/begin",
            bound(&request, &target_peer, json!({"manifest":manifest})),
        );
        for entry in manifest["entries"].as_array().unwrap() {
            for index in 0..entry["bytes"].as_u64().unwrap().div_ceil(128 * 1024) {
                let chunk = internal(
                    &mut source,
                    &mut id,
                    "source/chunk",
                    bound(
                        &request,
                        &source_peer,
                        json!({"entryId":entry["id"],"index":index}),
                    ),
                );
                internal(
                    &mut target,
                    &mut id,
                    "target/part/write",
                    bound(
                        &request,
                        &target_peer,
                        json!({"manifestSha256":exported["manifestSha256"],"entryId":entry["id"],"index":index,"sha256":chunk["sha256"],"dataBase64":chunk["dataBase64"]}),
                    ),
                );
            }
        }
        internal(
            &mut target,
            &mut id,
            "target/finish",
            bound(&request, &target_peer, json!({})),
        );
        stop(source);
        std::fs::rename(&source_profile.root, root.path().join("source-withheld")).unwrap();
        let digest = &exported["manifestSha256"];
        let legacy = internal_error(
            &mut target,
            &mut id,
            "target/received/read",
            bound(
                &request,
                &target_peer,
                json!({"manifestSha256":digest,"pageIndex":0}),
            ),
        );
        assert_eq!(
            legacy["message"],
            "source_transfer_scoped_instructions_update_required"
        );
        let received = internal(
            &mut target,
            &mut id,
            "target/received/read",
            bound(
                &request,
                &target_peer,
                json!({"manifestSha256":digest,"pageIndex":0,"includeInstructions":true}),
            ),
        );
        assert_eq!(received["items"][0]["class"], "instructions");
        let entry = received["items"][0]["entryId"].clone();
        let received_target =
            json!({"kind":"received","requestId":request,"manifestSha256":digest,"entryId":entry});
        let rows = page(&mut target, &mut id, received_target.clone(), 0);
        assert_eq!(rows["items"].as_array().unwrap().len(), 2);
        let mappings = rows["items"].as_array().unwrap().iter().map(|row| json!({"itemId":row["itemId"],"targetRelativeScope":if row["relativeScope"] == "" { "" } else { "mapped" }})).collect::<Vec<_>>();
        let adoption = uuid::Uuid::new_v4().to_string();
        let params = bound(
            &request,
            &target_peer,
            json!({"adoptionId":adoption,"manifestSha256":digest,"selections":[{"entryId":entry,"projectMapping":"current_workspace"}],"instructionMappings":[{"entryId":entry,"items":mappings}]}),
        );
        internal(
            &mut target,
            &mut id,
            "target/adoption/prepare",
            params.clone(),
        );
        let same = internal(&mut target, &mut id, "target/adoption/prepare", params);
        let mut state = same["state"].clone();
        let deadline = Instant::now() + Duration::from_secs(15);
        while state["phase"] != "preview_ready" {
            assert!(
                matches!(state["phase"].as_str(), Some("prepared" | "scanning")),
                "{state}"
            );
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
            state = internal(
                &mut target,
                &mut id,
                "target/adoption/read",
                bound(&request, &target_peer, json!({"adoptionId":adoption})),
            )["state"]
                .clone();
        }
        let job = state["jobs"][0]["jobId"].clone();
        let saved = page(&mut target, &mut id, json!({"kind":"job","jobId":job}), 0);
        let current = rpc(&mut target, &mut id, "migration/read", json!({"jobId":job}));
        let choices = saved["items"].as_array().unwrap().iter().enumerate().map(|(i,row)| json!({"kind":"asset","itemId":row["itemId"],"targetName":format!("mapped-guide-{i}"),"enableAfterImport":false})).collect::<Vec<_>>();
        let plan = rpc(
            &mut target,
            &mut id,
            "migration/batch/plan",
            json!({"jobId":job,"expectedSequence":current["job"]["sequence"],"choices":choices,"includeDefaultItems":false}),
        );
        let applied = rpc(
            &mut target,
            &mut id,
            "migration/batch/apply",
            json!({"jobId":job,"planId":plan["batch"]["planId"],"requestId":"publish-mapped-guides","expectedSequence":plan["job"]["sequence"]}),
        );
        assert_eq!(applied["job"]["committedItems"], 2, "{applied}");
        let contexts = ImportedContextStore::open(&target_profile.profile)
            .unwrap()
            .list()
            .unwrap();
        assert_eq!(contexts.len(), 2);
        assert!(contexts.iter().all(|entry| !entry.enabled));
        stop(target);
        let mut target = target_profile.start(true);
        initialize(&mut target, &mut id, true);
        let reopened = page(&mut target, &mut id, json!({"kind":"job","jobId":job}), 0);
        assert_eq!(reopened, saved);
        for row in reopened["items"].as_array().unwrap() {
            let body = rpc(
                &mut target,
                &mut id,
                "migration/instructions/body",
                json!({"target":{"kind":"job","jobId":job},"itemId":row["itemId"],"representation":"compiled"}),
            );
            assert_eq!(body["enabledByPreview"], false);
            assert!(body["text"].as_str().unwrap().contains("Original"));
        }
        let undone = rpc(
            &mut target,
            &mut id,
            "migration/batch/rollback",
            json!({"jobId":job,"planId":plan["batch"]["planId"],"requestId":"undo-mapped-guides","expectedSequence":applied["job"]["sequence"]}),
        );
        assert_eq!(undone["job"]["status"], "rolled_back", "{undone}");
        assert!(
            ImportedContextStore::open(&target_profile.profile)
                .unwrap()
                .list()
                .unwrap()
                .is_empty()
        );
        assert_eq!(std::fs::read(&target_profile.settings).unwrap(), settings);
        stop(target);
        assert_eq!(observer.inference.load(Ordering::Acquire), 0);
    }
}
