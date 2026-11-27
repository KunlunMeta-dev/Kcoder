//! Generic catalog lifecycle with no Office host, settings, generator or model.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
struct Host {
    scope: IntegrationScope,
    allow: AtomicBool,
}
#[async_trait]
impl AgentDefinitionHost for Host {
    fn validate_scope(&self, scope: &IntegrationScope) -> Result<()> {
        ensure!(scope == &self.scope, "AGENT_SCOPE_CHANGED");
        Ok(())
    }
    async fn call_port(
        &self,
        port: IntegrationPort,
        method: &str,
        request: &IntegrationRequest,
        _: &CancellationToken,
    ) -> Result<IntegrationReply> {
        ensure!(
            port == IntegrationPort::Policy && method == "evaluateAction",
            "UNEXPECTED_BUSINESS_CALL"
        );
        Ok(IntegrationReply {
            contract_version: request.contract_version, request_id:request.request_id.clone(),
            status:IntegrationStatus::Completed, operation_id:request.operation_id.clone().map_or(IntegrationNullable::Null,IntegrationNullable::Value),
            entity_revision:IntegrationNullable::Null, observed_at:chrono::Utc::now().to_rfc3339(),
            result:IntegrationNullable::Value(json!({"decision":if self.allow.load(Ordering::SeqCst){"allow"}else{"deny"},"policyRevision":"fixture","reasonCode":"fixture"}).as_object().unwrap().clone()),
            error:IntegrationNullable::Null,
        })
    }
}
fn request(
    scope: &IntegrationScope,
    operation: Option<&str>,
    expected: Option<&str>,
    payload: Value,
) -> IntegrationRequest {
    IntegrationRequest {
        contract_version: IntegrationContractVersion::ParallelV1,
        request_id: "catalog-request".into(),
        scope: scope.clone(),
        operation_id: operation.map(str::to_owned),
        expected_revision: expected.map(str::to_owned),
        timeout_ms: 1000,
        cancellation_ref: None,
        payload: payload.as_object().unwrap().clone(),
    }
}
#[tokio::test]
async fn standalone_catalog_preserves_versions_receipts_and_live_authorization() {
    let root = tempfile::tempdir().unwrap();
    let scope = IntegrationScope {
        account_id: "account".into(),
        target_id: "target".into(),
        workspace_id: IntegrationNullable::Value("workspace".into()),
        organization_id: None,
        identity_generation: "generation".into(),
        target_revision: "revision".into(),
    };
    let owner = IntegrationOwner::from(&scope);
    let store =
        Arc::new(ResourceStore::create(&root.path().join("resources"), owner.clone()).unwrap());
    let host = Arc::new(Host {
        scope: scope.clone(),
        allow: AtomicBool::new(true),
    });
    let service = AgentDefinitionService {
        store: store.clone(),
        host: host.clone(),
        allow_organization_templates: false,
    };
    let mut definition = builtin_agent_definition("builtin.meeting-minutes", "en").unwrap();
    definition.id = "personal.catalog-test".into();
    let cancel = CancellationToken::new();
    let save = request(
        &scope,
        Some("save-draft"),
        None,
        json!({"definition":definition}),
    );
    let first = service
        .dispatch(
            "integrations/assistant/saveDraft",
            &save,
            "agent.definition.write",
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(first["draft"]["revision"], 1);
    let receipt = service
        .dispatch(
            "agentDefinitions/operation/read",
            &request(&scope, None, None, json!({"operationId":"save-draft"})),
            "agent.definition.read",
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(receipt["result"], first["draft"]);
    assert!(!AgentDefinitionService::handles(
        "integrations/office/readOperation"
    ));

    assert_eq!(
        first,
        service
            .dispatch(
                "integrations/assistant/saveDraft",
                &save,
                "agent.definition.write",
                &cancel
            )
            .await
            .unwrap()
    );
    let version = request(
        &scope,
        Some("save-version"),
        Some("1"),
        json!({"id":definition.id,"version":"1"}),
    );
    let saved = service
        .dispatch(
            "integrations/assistant/saveVersion",
            &version,
            "agent.definition.write",
            &cancel,
        )
        .await
        .unwrap();
    let frozen = saved["saved"]["definitionSha256"].clone();
    definition.instructions = "Changed draft only".into();
    let update = request(
        &scope,
        Some("update-draft"),
        Some("1"),
        json!({"definition":definition}),
    );
    service
        .dispatch(
            "integrations/assistant/saveDraft",
            &update,
            "agent.definition.write",
            &cancel,
        )
        .await
        .unwrap();
    let reopened = ResourceStore::open_existing(&root.path().join("resources"), owner)
        .unwrap()
        .unwrap();
    let historical = reopened.read_version(&definition.id, "1").unwrap().unwrap();
    assert_eq!(json!(historical.definition_sha256), frozen);
    assert_ne!(historical.definition.instructions, "Changed draft only");
    assert!(
        service
            .dispatch(
                "integrations/assistant/saveDraft",
                &request(
                    &scope,
                    Some("stale-update"),
                    Some("1"),
                    json!({"definition":definition})
                ),
                "agent.definition.write",
                &cancel
            )
            .await
            .is_err()
    );
    host.allow.store(false, Ordering::SeqCst);
    // Replayed mutations still check the current decision before reading their old receipt.
    assert!(
        service
            .dispatch(
                "integrations/assistant/saveDraft",
                &save,
                "agent.definition.write",
                &cancel
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("POLICY_DENIED")
    );
    let mut foreign = scope.clone();
    foreign.account_id = "another-owner".into();
    assert!(
        service
            .dispatch(
                "integrations/assistant/list",
                &request(&foreign, None, None, json!({})),
                "agent.definition.read",
                &cancel
            )
            .await
            .is_err()
    );
}

/// Installs every listed market expert from the live public catalogs into an isolated
/// store. Run with `KCODER_EXPERT_MARKET_NETWORK_SMOKE=1 cargo test ... -- --ignored`.
#[tokio::test]
#[ignore = "requires explicit public expert market network smoke"]
async fn expert_market_network_smoke_installs_every_listed_expert() {
    assert_eq!(
        std::env::var("KCODER_EXPERT_MARKET_NETWORK_SMOKE").as_deref(),
        Ok("1"),
        "explicit network smoke opt-in required"
    );
    let scope = IntegrationScope {
        account_id: "account".into(),
        target_id: "target".into(),
        workspace_id: IntegrationNullable::Value("workspace".into()),
        organization_id: None,
        identity_generation: "generation".into(),
        target_revision: "revision".into(),
    };
    let cancel = CancellationToken::new();
    let host = Arc::new(Host {
        scope: scope.clone(),
        allow: AtomicBool::new(true),
    });
    let root = tempfile::tempdir().unwrap();
    let service = |index: usize| AgentDefinitionService {
        store: Arc::new(
            ResourceStore::create(
                &root.path().join(format!("resources-{index}")),
                IntegrationOwner::from(&scope),
            )
            .unwrap(),
        ),
        host: host.clone(),
        allow_organization_templates: false,
    };
    let catalog = service(0);
    let mut installs = 0;
    for language in ["zh-CN", "en"] {
        let mut slugs = Vec::new();
        let mut cursor = Value::Null;
        loop {
            let page = catalog
                .dispatch(
                    "integrations/assistant/market/list",
                    &request(
                        &scope,
                        None,
                        None,
                        json!({"language":language,"limit":10,"cursor":cursor}),
                    ),
                    "agent.definition.read",
                    &cancel,
                )
                .await
                .unwrap();
            slugs.extend(
                page["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|item| item["slug"].as_str().unwrap().to_owned()),
            );
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        let lobehub = slugs
            .iter()
            .filter(|slug| slug.starts_with("lobehub-"))
            .count();
        eprintln!(
            "{language}: {} market experts, {lobehub} from LobeHub",
            slugs.len()
        );
        assert_eq!(lobehub, 43);
        assert!(
            slugs.len() >= 79 + 43,
            "Octop portal experts missing from the market"
        );
        for slug in &slugs {
            installs += 1;
            let index = installs;
            let service = service(index);
            let detail = service
                .dispatch(
                    "integrations/assistant/market/read",
                    &request(&scope, None, None, json!({"slug":slug,"language":language})),
                    "agent.definition.read",
                    &cancel,
                )
                .await
                .unwrap_or_else(|error| panic!("{slug}: detail failed: {error:#}"));
            assert_eq!(detail["item"]["slug"], *slug);
            let id = format!("personal.smoke-{index}");
            let installed = service
                .dispatch(
                    "integrations/assistant/market/install",
                    &request(
                        &scope,
                        Some(&format!("install-{index}")),
                        None,
                        json!({"id":id,"slug":slug,"language":language}),
                    ),
                    "agent.definition.write",
                    &cancel,
                )
                .await
                .unwrap_or_else(|error| panic!("{slug}: install failed: {error:#}"));
            assert_eq!(installed["draft"]["definition"]["id"], id);
            let package = service
                .dispatch(
                    "integrations/assistant/package/read",
                    &request(&scope, None, None, json!({"id":id})),
                    "agent.definition.read",
                    &cancel,
                )
                .await
                .unwrap();
            assert_eq!(package["package"]["slug"], *slug);
            eprintln!(
                "ok {language} {slug} source={} files={} skills={}",
                package["package"]["source"],
                package["package"]["files"].as_array().unwrap().len(),
                package["package"]["skillSlugs"].as_array().unwrap().len()
            );
        }
    }
}
