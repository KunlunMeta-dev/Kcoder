//! Actual private stdio and ordinary group publication. Ordinary IR is seeded by Native APIs.
use super::*;
use kcoder_migration::{
    assets::AssetTarget,
    batch::{BatchResolution, BatchSource},
    discovery::ConfigurationBinding,
    mcp::{McpResolution, McpTarget},
    providers::{ModelLimits, ProviderResolution, ProviderTarget},
    source_transfer::{ExportSelection, IncomingTransfers, SourceTransfers, TRANSFER_CHUNK_BYTES},
    store::{BatchTargets, MigrationStore},
};
use kcoder_types::migration::MigrationSourceKind;

#[test]
fn private_credentials_stdio_preserves_original_key_cipher_receipt_and_group_undo_without_a_source()
{
    let root = tempfile::tempdir().unwrap();
    let observer = ModelObserver::new();
    let source_profile = Profile::new(root.path(), "private-source", &observer.endpoint);
    let target_profile = Profile::new(root.path(), "private-target", &observer.endpoint);
    for profile in [&source_profile, &target_profile] {
        let mut settings: Value =
            serde_json::from_slice(&std::fs::read(&profile.settings).unwrap()).unwrap();
        settings["providers"]["isolated-source-transfer"]["authentication"] =
            json!({"mode":"none"});
        settings["mcp_servers"] = json!([]);
        settings["mcp_disabled_servers"] = json!([]);
        std::fs::write(&profile.settings, settings.to_string()).unwrap();
    }
    // A real profile writer must not be shadowed by a CLI settings overlay.
    let overlay = root.path().join("empty-overlay.json");
    std::fs::write(&overlay, "{}").unwrap();
    let start = |profile: &Profile| profile.start_with_overlay(true, &overlay);
    let api = "SYNTHETIC_PRIVATE_STDIO_PROVIDER";
    let token = "SYNTHETIC_PRIVATE_STDIO_MCP";
    let program = source_profile.source.join("never-run.sh");
    std::fs::write(&program, "printf invoked > \"$0.marker\"\n").unwrap();
    let original = json!({"model":"fixture", "env":{"ANTHROPIC_BASE_URL":"https://example.invalid/v1","ANTHROPIC_API_KEY":api},
        "mcpServers":{"notes":{"command":"sh","args":[program],"env":{"TOKEN":token}}}}).to_string();
    std::fs::write(source_profile.source.join("settings.json"), &original).unwrap();
    std::fs::write(
        source_profile.source.join("auth.json"),
        "MUST_NOT_READ_OAUTH_CACHE",
    )
    .unwrap();
    let baseline = kcoder_config::read_settings_file(&target_profile.settings).unwrap();
    let exported = SourceTransfers::open(&source_profile.profile).unwrap();
    let received = IncomingTransfers::open(&target_profile.profile).unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let destination = received
        .issue_destination(&request, exported.authority())
        .unwrap();
    let binding = ConfigurationBinding::capture_selected(
        &source_profile.source.join("settings.json"),
        MigrationSourceKind::ClaudeCode,
    )
    .unwrap();
    exported
        .prepare(
            &request,
            &destination,
            vec![ExportSelection::Configuration(binding)],
        )
        .unwrap();
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
    let entry = &manifest.entries[0].id;
    let public = received
        .configuration_binding(&request, exported.authority(), entry, &receipt)
        .unwrap();
    let store = MigrationStore::open_or_create(&target_profile.profile).unwrap();
    let scan = store
        .create_batch_scan(vec![BatchSource::TransferredConfiguration(Box::new(
            public,
        ))])
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
    let choices = scan
        .inventory
        .items
        .iter()
        .filter_map(|item| {
            if item.provider.is_some() {
                Some(BatchResolution::Provider(ProviderResolution {
                    item_id: item.preview.id.clone(),
                    target_name: "PrivateProvider".into(),
                    endpoint: None,
                    model: None,
                    limits: Some(ModelLimits {
                        context_window_tokens: 64000,
                        output_headroom_tokens: 8192,
                        max_output_tokens: 8192,
                    }),
                }))
            } else if item.mcp.is_some() {
                Some(BatchResolution::Mcp(McpResolution {
                    item_id: item.preview.id.clone(),
                    target_name: "private-notes".into(),
                    cwd: None,
                    enable_after_import: false,
                }))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    let planned = store
        .prepare_batch(&scan.job_id, scan.sequence, &choices, &targets)
        .unwrap();
    let mut source = start(&source_profile);
    let mut target = start(&target_profile);
    let mut id = 0;
    initialize(&mut source, &mut id, true);
    initialize(&mut target, &mut id, true);
    let source_identity = internal(&mut source, &mut id, "identity", json!({}));
    let target_identity = internal(&mut target, &mut id, "identity", json!({}));
    let endpoint = |identity: &Value, name: &str| json!({"authority":identity["authority"],"targetFingerprint":name,"principal":{"kind":"localOs"}});
    let proof = json!({"version":1,"requestId":request,"source":endpoint(&source_identity,"private-source"),"target":endpoint(&target_identity,"private-target")});
    let source_peer = accept(&mut source, &mut id, &request, "source", &proof);
    let target_peer = accept(&mut target, &mut id, &request, "target", &proof);
    let page = internal(
        &mut target,
        &mut id,
        "target/private/candidates",
        bound(
            &request,
            &target_peer,
            json!({"manifestSha256":receipt.manifest_sha256,"entryId":entry,"pageIndex":0,"jobId":planned.job_id,"expectedPlanId":planned.batch.as_ref().unwrap().plan_id}),
        ),
    );
    assert_eq!(page["totalItems"], 2);
    assert_eq!(page["plan"]["jobId"], planned.job_id);
    assert_eq!(page["plan"]["sequence"], planned.sequence);
    let changed = internal_error(
        &mut target,
        &mut id,
        "target/private/candidates",
        bound(
            &request,
            &target_peer,
            json!({"manifestSha256":receipt.manifest_sha256,"entryId":entry,"pageIndex":0,"jobId":planned.job_id,"expectedPlanId":"plan-ffffffffffffffffffffffffffffffff"}),
        ),
    );
    assert_eq!(changed["message"], "private_credentials_plan_changed");
    let selections = page["items"].as_array().unwrap().iter().map(|item| {
        assert_eq!(item["sourceVerificationRequired"], true);
        assert_eq!(item["targets"].as_array().unwrap().len(), 1);
        let target = &item["targets"][0];
        assert_eq!(target["kind"], item["kind"]);
        if item["kind"]=="provider" { json!({"kind":"provider","source_name":item["sourceName"],"target_name":target["targetName"],
            "selector":item["selectors"][0],"endpoint":item["endpoint"],"api_format":item["apiFormat"]}) }
        else { json!({"kind":"mcp","source_name":item["sourceName"],"target_name":target["targetName"],"fields":item["fields"],"definition_sha256":item["definitionSha256"]}) }
    }).collect::<Vec<_>>();
    let offer = uuid::Uuid::new_v4().to_string();
    let intent = json!({"offerId":offer,"manifestSha256":receipt.manifest_sha256,"entryId":entry,"selections":selections,
        "consent":{"apiKeys":true,"mcpPrivateFields":true}});
    let mut denied = intent.clone();
    denied["consent"]["apiKeys"] = json!(false);
    assert_eq!(
        internal_error(
            &mut target,
            &mut id,
            "target/private/offer",
            bound(&request, &target_peer, denied)
        )["message"],
        "private_credentials_explicit_consent_required"
    );
    assert!(
        !target_profile
            .profile
            .join("migrations/source-transfer/private-credentials")
            .exists()
    );
    let offered = internal(
        &mut target,
        &mut id,
        "target/private/offer",
        bound(&request, &target_peer, intent),
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
    assert_eq!(sealed["offer"], offered["offer"]);
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
    for value in [&page, &offered, &sealed, &accepted] {
        assert!(!value.to_string().contains(api));
        assert!(!value.to_string().contains(token));
    }
    // Treat the accept reply as lost. Stop both original processes and withhold
    // the source, then reconcile the target's original immutable receipt.
    drop(accepted);
    stop(source);
    stop(target);
    std::fs::rename(
        &source_profile.source,
        source_profile.source.with_extension("withheld"),
    )
    .unwrap();
    let mut target = start(&target_profile);
    initialize(&mut target, &mut id, true);
    let recovered = internal(
        &mut target,
        &mut id,
        "peer/recover-target",
        json!({"requestId":request}),
    );
    let peer = recovered["peerRef"].as_str().unwrap();
    let reopened = internal(
        &mut target,
        &mut id,
        "target/private/read",
        bound(&request, peer, json!({"offerId":offer})),
    );
    assert_eq!(reopened["received"], true);
    assert_eq!(reopened["offer"], offered["offer"]);
    let attached = internal(
        &mut target,
        &mut id,
        "target/private/prepare",
        bound(
            &request,
            peer,
            json!({"offerId":offer,"jobId":planned.job_id,"expectedSequence":planned.sequence,"consent":{"apiKeys":true,"mcpPrivateFields":true}}),
        ),
    );
    let private = &attached["job"];
    assert_eq!(private["credentialPlans"].as_array().unwrap().len(), 1);
    assert_eq!(private["batch"]["credentialActions"], 2);
    assert_ne!(
        private["batch"]["planId"],
        json!(planned.batch.as_ref().unwrap().plan_id)
    );
    let publish = json!({"jobId":planned.job_id,"planId":private["batch"]["planId"],"expectedSequence":private["job"]["sequence"],"requestId":"private-publish"});
    let published = rpc(
        &mut target,
        &mut id,
        "migration/batch/apply",
        publish.clone(),
    );
    assert_eq!(published["batch"]["publishedCredentials"], 2);
    let current = kcoder_config::read_settings_file(&target_profile.settings).unwrap();
    assert!(!current.to_string().contains(api));
    assert!(!current.to_string().contains(token));
    assert!(
        current["mcp_disabled_servers"]
            .as_array()
            .unwrap()
            .contains(&json!("private-notes"))
    );
    let repeated = rpc(&mut target, &mut id, "migration/batch/apply", publish);
    assert_eq!(repeated["job"]["sequence"], published["job"]["sequence"]);
    let undone = rpc(
        &mut target,
        &mut id,
        "migration/batch/rollback",
        json!({"jobId":planned.job_id,"planId":private["batch"]["planId"],"expectedSequence":published["job"]["sequence"],"requestId":"private-undo"}),
    );
    assert_eq!(undone["job"]["status"], "rolled_back");
    assert_eq!(
        kcoder_config::read_settings_file(&target_profile.settings).unwrap(),
        baseline
    );
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
    stop(target);
    // Ordinary clients recover original locators without acquiring private-parent authority.
    let mut plain = target_profile.start_with_overlay(false, &overlay);
    let initialized = rpc(
        &mut plain,
        &mut id,
        "initialize",
        json!({
            "protocolVersion":"2026-07-27", "clientInfo":{"name":"owned-job-credential-sources","version":"1"}
        }),
    );
    assert_eq!(
        initialized["capabilities"]["experimental"]["migrationSourceCredentialSourcesV1"],
        true
    );
    assert_ne!(
        initialized["capabilities"]["experimental"]["migrationSourceTransferPrivateCredentialsV1"],
        true
    );
    let locators = rpc(
        &mut plain,
        &mut id,
        "migration/batch/credential-sources",
        json!({"jobId":planned.job_id,"pageIndex":0}),
    );
    assert_eq!(locators["jobId"], planned.job_id);
    assert_eq!(locators["items"].as_array().unwrap().len(), 1);
    assert_eq!(locators["items"][0]["requestId"], request);
    assert_eq!(
        locators["items"][0]["manifestSha256"],
        receipt.manifest_sha256
    );
    assert_eq!(locators["items"][0]["entryId"], *entry);
    for forbidden in [api, token, "authority", "profile", "ciphertext"] {
        assert!(!locators.to_string().contains(forbidden));
    }
    stop(plain);
    assert_eq!(observer.inference.load(Ordering::Acquire), 0);
    assert!(
        !source_profile
            .source
            .with_extension("withheld")
            .join("never-run.sh.marker")
            .exists()
    );
    assert_eq!(
        std::fs::read_to_string(
            source_profile
                .source
                .with_extension("withheld")
                .join("settings.json")
        )
        .unwrap(),
        original
    );
}

#[path = "source_transfer_credentials_rpc/bundle.rs"]
mod bundle;
