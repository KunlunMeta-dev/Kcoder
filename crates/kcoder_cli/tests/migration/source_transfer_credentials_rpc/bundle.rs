//! Real private stdio attaches two original entries to one normal publication group.
use super::*;

#[test]
fn multiple_received_offers_attach_atomically_reconcile_lost_ack_reopen_and_undo_the_original_group()
 {
    let root = tempfile::tempdir().unwrap();
    let observer = ModelObserver::new();
    let source_profile = Profile::new(root.path(), "bundle-source", &observer.endpoint);
    let target_profile = Profile::new(root.path(), "bundle-target", &observer.endpoint);
    for profile in [&source_profile, &target_profile] {
        let mut settings: Value =
            serde_json::from_slice(&std::fs::read(&profile.settings).unwrap()).unwrap();
        settings["providers"]["isolated-source-transfer"]["authentication"] =
            json!({"mode":"none"});
        settings["mcp_servers"] = json!([]);
        settings["mcp_disabled_servers"] = json!([]);
        std::fs::write(&profile.settings, settings.to_string()).unwrap();
    }
    let overlay = root.path().join("empty-overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let baseline = kcoder_config::read_settings_file(&target_profile.settings).unwrap();
    let exported = SourceTransfers::open(&source_profile.profile).unwrap();
    let received = IncomingTransfers::open(&target_profile.profile).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let destination = received
        .issue_destination(&request, exported.authority())
        .unwrap();
    let mut originals = Vec::new();
    let mut chosen = Vec::new();
    for index in 0..2 {
        let path = source_profile.source.join(format!("selected-{index}"));
        kcoder_config::PrivateDirectory::open_or_create(&path).unwrap();
        let body=json!({"model":"fixture","env":{"ANTHROPIC_BASE_URL":format!("https://source-{index}.invalid/v1"),"ANTHROPIC_API_KEY":"SYNTHETIC_PRIVATE_BUNDLE_API"},"mcpServers":{"notes":{"command":"NEVER_EXECUTE_PRIVATE_BUNDLE_MCP","env":{"TOKEN":"SYNTHETIC_PRIVATE_BUNDLE_MCP"}}}}).to_string();
        std::fs::write(path.join("settings.json"), &body).unwrap();
        originals.push(body);
        chosen.push(ExportSelection::Configuration(
            ConfigurationBinding::capture_selected(
                &path.join("settings.json"),
                MigrationSourceKind::ClaudeCode,
            )
            .unwrap(),
        ));
    }
    exported.prepare(&request, &destination, chosen).unwrap();
    let manifest = exported.capture(&request, &destination, |_| true).unwrap();
    received.begin(&manifest, exported.authority()).unwrap();
    for entry in &manifest.entries {
        for index in 0..entry.bytes.div_ceil(TRANSFER_CHUNK_BYTES as u64) as u32 {
            let chunk = exported
                .chunk(
                    &request,
                    &destination,
                    &manifest.digest().unwrap(),
                    &entry.id,
                    index,
                )
                .unwrap();
            received.write_part(exported.authority(), &chunk).unwrap();
        }
    }
    let receipt = received
        .finish(&request, exported.authority(), |_| true)
        .unwrap();
    let bindings = manifest
        .entries
        .iter()
        .map(|entry| {
            received
                .configuration_binding(&request, exported.authority(), &entry.id, &receipt)
                .unwrap()
        })
        .collect::<Vec<_>>();
    let store = MigrationStore::open_or_create(&target_profile.profile).unwrap();
    let scan = store
        .create_batch_scan(
            bindings
                .iter()
                .map(|binding| BatchSource::TransferredConfiguration(Box::new(binding.clone())))
                .collect(),
        )
        .unwrap();
    let provider = ProviderTarget::open(&target_profile.profile).unwrap();
    let mcp = McpTarget::open(&target_profile.profile).unwrap();
    let assets = AssetTarget::open(&target_profile.profile).unwrap();
    let targets = BatchTargets {
        provider: &provider,
        mcp: &mcp,
        assets: &assets,
        history: None,
        credentials: None,
    };
    let choices=scan.inventory.items.iter().filter_map(|item| {
        let source=scan.batch.as_ref().unwrap().source_for(&item.preview.id).unwrap();
        let index=bindings.iter().position(|binding|matches!(source,BatchSource::TransferredConfiguration(value) if **value==*binding)).unwrap();
        if item.provider.is_some() {Some(BatchResolution::Provider(ProviderResolution {item_id:item.preview.id.clone(),target_name:format!("BundleProvider{index}"),endpoint:None,model:None,limits:Some(ModelLimits {context_window_tokens:64000,output_headroom_tokens:8192,max_output_tokens:8192})}))}
        else if item.mcp.is_some() {Some(BatchResolution::Mcp(McpResolution {item_id:item.preview.id.clone(),target_name:format!("bundle-notes-{index}"),cwd:None,enable_after_import:false}))} else {None}
    }).collect::<Vec<_>>();
    let planned = store
        .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
        .unwrap();
    let start = |profile: &Profile| profile.start_with_overlay(true, &overlay);
    let mut source = start(&source_profile);
    let mut target = start(&target_profile);
    let mut id = 0;
    initialize(&mut source, &mut id, true);
    let initialized = rpc(
        &mut target,
        &mut id,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-private-bundle-stdio","version":"1"}}),
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationSourceTransferPrivateCredentialBundlesV1"],
        true
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationSourceTransferPrivateCredentialPreparationsV1"],
        true
    );
    let source_identity = internal(&mut source, &mut id, "identity", json!({}));
    let target_identity = internal(&mut target, &mut id, "identity", json!({}));
    let endpoint = |identity: &Value, name: &str| json!({"authority":identity["authority"],"targetFingerprint":name,"principal":{"kind":"localOs"}});
    let proof = json!({"version":1,"requestId":request,"source":endpoint(&source_identity,"bundle-source"),"target":endpoint(&target_identity,"bundle-target")});
    let source_peer = accept(&mut source, &mut id, &request, "source", &proof);
    let target_peer = accept(&mut target, &mut id, &request, "target", &proof);
    let not_started = internal(
        &mut target,
        &mut id,
        "target/private/prepare-status",
        bound(&request, &target_peer, json!({"jobId":planned.job_id})),
    );
    assert_eq!(not_started["phase"], "not_started");
    for field in [
        "offerIds",
        "originalPlanId",
        "planId",
        "expectedSequence",
        "consent",
    ] {
        assert!(not_started.get(field).unwrap().is_null());
    }
    let mut offers = Vec::new();
    for entry in &manifest.entries {
        let page = internal(
            &mut target,
            &mut id,
            "target/private/candidates",
            bound(
                &request,
                &target_peer,
                json!({"manifestSha256":receipt.manifest_sha256,"entryId":entry.id,"pageIndex":0,"jobId":planned.job_id,"expectedPlanId":planned.batch.as_ref().unwrap().plan_id}),
            ),
        );
        let selections=page["items"].as_array().unwrap().iter().map(|item| {
            let destination=&item["targets"][0];
            if item["kind"]=="provider" {json!({"kind":"provider","source_name":item["sourceName"],"target_name":destination["targetName"],"selector":item["selectors"][0],"endpoint":item["endpoint"],"api_format":item["apiFormat"]})}
            else {json!({"kind":"mcp","source_name":item["sourceName"],"target_name":destination["targetName"],"fields":item["fields"],"definition_sha256":item["definitionSha256"]})}
        }).collect::<Vec<_>>();
        let offer = uuid::Uuid::new_v4().to_string();
        let offered = internal(
            &mut target,
            &mut id,
            "target/private/offer",
            bound(
                &request,
                &target_peer,
                json!({"offerId":offer,"manifestSha256":receipt.manifest_sha256,"entryId":entry.id,"selections":selections,"consent":{"apiKeys":true,"mcpPrivateFields":true}}),
            ),
        );
        let sealed = internal(
            &mut source,
            &mut id,
            "source/private/seal",
            bound(
                &request,
                &source_peer,
                json!({"offer":offered["offer"],"consent":{"apiKeys":true,"mcpPrivateFields":true}}),
            ),
        );
        let accepted = internal(
            &mut target,
            &mut id,
            "target/private/accept",
            bound(
                &request,
                &target_peer,
                json!({"offerId":offer,"envelope":sealed["envelope"],"consent":{"apiKeys":true,"mcpPrivateFields":true}}),
            ),
        );
        assert_eq!(accepted["received"], true);
        for value in [page, offered, sealed, accepted] {
            assert!(!value.to_string().contains("SYNTHETIC_PRIVATE_BUNDLE"));
        }
        offers.push(offer);
    }
    let params = bound(
        &request,
        &target_peer,
        json!({"offerId":offers[0],"additionalOffers":[offers[1]],"jobId":planned.job_id,"expectedSequence":planned.sequence,"consent":{"apiKeys":true,"mcpPrivateFields":true}}),
    );
    // Accept the mutation, deliberately discard its reply, then reconcile the same intent.
    internal(
        &mut target,
        &mut id,
        "target/private/prepare",
        params.clone(),
    );
    let attached = internal(&mut target, &mut id, "target/private/prepare", params);
    let mut complete = offers.clone();
    complete.sort();
    assert_eq!(attached["offerIds"], json!(complete));
    let preparation = internal(
        &mut target,
        &mut id,
        "target/private/prepare-status",
        bound(&request, &target_peer, json!({"jobId":planned.job_id})),
    );
    assert_eq!(preparation["phase"], "prepared");
    assert_eq!(preparation["offerIds"], json!(complete));
    assert_eq!(preparation["expectedSequence"], json!(planned.sequence));
    assert_eq!(
        preparation["consent"],
        json!({"apiKeys":true,"mcpPrivateFields":true})
    );
    assert_eq!(
        preparation["originalPlanId"],
        json!(planned.batch.as_ref().unwrap().plan_id)
    );
    assert_eq!(preparation["planId"], attached["job"]["batch"]["planId"]);
    let private_job = &attached["job"];
    assert_eq!(private_job["batch"]["credentialActions"], 4);
    assert_eq!(private_job["credentialPlans"].as_array().unwrap().len(), 2);
    stop(source);
    stop(target);
    std::fs::rename(
        &source_profile.source,
        source_profile.source.with_extension("offline"),
    )
    .unwrap();
    let mut source_reader = start(&source_profile);
    let initialized = rpc(
        &mut source_reader,
        &mut id,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-source-observer","version":"1"}}),
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationSourceTransferPrivateCredentialSourceObservationV1"],
        true
    );
    let private = source_profile
        .profile
        .join("migrations/source-transfer/private-credentials")
        .join(format!("source-{}", offers[0]));
    let private = kcoder_config::PrivateDirectory::open_existing(&private).unwrap();
    let identity = private
        .portable_regular_identity(std::ffi::OsStr::new("writer.lock"))
        .unwrap();
    let writer = private
        .try_existing_portable_lock(
            std::ffi::OsStr::new("writer.lock"),
            &identity,
            kcoder_config::PrivateLeaseMode::Exclusive,
        )
        .unwrap()
        .unwrap();
    let original_source =
        kcoder_migration::source_transfer::private_credentials::read_source_private_credentials(
            &exported,
            received.authority(),
            &request,
            &offers[0],
        )
        .unwrap();
    original_source
        .controller()
        .cancel(&uuid::Uuid::new_v4().to_string())
        .unwrap();
    let observed = internal(
        &mut source_reader,
        &mut id,
        "source/private/observe",
        json!({"requestId":request,"offerId":offers[0]}),
    );
    assert_eq!(observed["writerRunning"], true);
    assert_eq!(observed["control"]["cancelled"], true);
    assert_eq!(
        observed.as_object().unwrap().len(),
        2,
        "source observation has no offer, key or cipher"
    );
    drop(writer);
    let observed = internal(
        &mut source_reader,
        &mut id,
        "source/private/observe",
        json!({"requestId":request,"offerId":offers[0]}),
    );
    assert_eq!(observed["writerRunning"], false);
    assert_eq!(observed["control"]["cancelled"], true);
    stop(source_reader);
    std::fs::rename(
        &source_profile.profile,
        source_profile.profile.with_extension("offline"),
    )
    .unwrap();
    let mut target = start(&target_profile);
    initialize(&mut target, &mut id, true);
    let recovery = internal(
        &mut target,
        &mut id,
        "peer/recover-target",
        json!({"requestId":request}),
    );
    let peer = recovery["peerRef"].as_str().unwrap();
    let before_status = std::fs::read(
        target_profile
            .profile
            .join("migrations/source-transfer/private-credentials/catalog.json"),
    )
    .unwrap();
    let observed = internal(
        &mut target,
        &mut id,
        "target/private/prepare-status",
        bound(&request, peer, json!({"jobId":planned.job_id})),
    );
    assert_eq!(observed, preparation);
    assert_eq!(
        std::fs::read(
            target_profile
                .profile
                .join("migrations/source-transfer/private-credentials/catalog.json")
        )
        .unwrap(),
        before_status
    );
    let reopened = internal(
        &mut target,
        &mut id,
        "target/private/prepare",
        bound(
            &request,
            peer,
            json!({"offerId":offers[1],"additionalOffers":[offers[0]],"jobId":planned.job_id,"expectedSequence":planned.sequence,"consent":{"apiKeys":true,"mcpPrivateFields":true}}),
        ),
    );
    assert_eq!(reopened, attached);
    let published = rpc(
        &mut target,
        &mut id,
        "migration/batch/apply",
        json!({"jobId":planned.job_id,"planId":private_job["batch"]["planId"],"expectedSequence":private_job["job"]["sequence"],"requestId":"bundle-publish"}),
    );
    assert_eq!(published["batch"]["publishedCredentials"], 4);
    let current = kcoder_config::read_settings_file(&target_profile.settings).unwrap();
    assert!(!current.to_string().contains("SYNTHETIC_PRIVATE_BUNDLE"));
    for name in ["bundle-notes-0", "bundle-notes-1"] {
        assert!(
            current["mcp_disabled_servers"]
                .as_array()
                .unwrap()
                .contains(&json!(name))
        );
    }
    let undone = rpc(
        &mut target,
        &mut id,
        "migration/batch/rollback",
        json!({"jobId":planned.job_id,"planId":private_job["batch"]["planId"],"expectedSequence":published["job"]["sequence"],"requestId":"bundle-undo"}),
    );
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert_eq!(
        kcoder_config::read_settings_file(&target_profile.settings).unwrap(),
        baseline
    );
    for offer in &offers {
        let released = internal(
            &mut target,
            &mut id,
            "target/private/release",
            bound(
                &request,
                peer,
                json!({"offerId":offer,"jobId":planned.job_id}),
            ),
        );
        assert_eq!(released["keyReleased"], true);
    }
    stop(target);
    let mut plain = target_profile.start_with_overlay(false, &overlay);
    let initialized = rpc(
        &mut plain,
        &mut id,
        "initialize",
        json!({"protocolVersion":"2026-07-27","clientInfo":{"name":"owned-bundle-plain","version":"1"}}),
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationSourceTransferPrivateCredentialBundlesV1"],
        false
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationSourceTransferPrivateCredentialPreparationsV1"],
        false
    );
    stop(plain);
    assert_eq!(observer.inference.load(Ordering::Acquire), 0);
    for (index, original) in originals.iter().enumerate() {
        assert_eq!(
            std::fs::read_to_string(
                source_profile
                    .source
                    .with_extension("offline")
                    .join(format!("selected-{index}/settings.json"))
            )
            .unwrap(),
            *original
        );
    }
    drop((provider, mcp, assets, store, exported, received));
    let owned_root = root.path().to_path_buf();
    root.close().unwrap();
    assert!(!owned_root.exists());
}
