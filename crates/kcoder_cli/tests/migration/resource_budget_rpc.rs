use super::{Fixture, json, rpc};
use std::time::{Duration, Instant};

#[test]
fn resource_budget_rpc_reconciles_original_increase_before_explicit_resume_and_offline_undo() {
    let fixture = Fixture::new();
    let first = fixture.source(1);
    let second = fixture.source(1);
    let mut server = fixture.start();
    let catalog = rpc(
        &mut server,
        701,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let selections = catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            json!({
        "catalogId":catalog["catalogId"],"sourceHandle":item["sourceHandle"]})
        })
        .collect::<Vec<_>>();
    assert_eq!(selections.len(), 2);
    let limits = json!({"maxTotalBytes":8*1024*1024,"maxPayloadFiles":6,
        "minFreeBytes":1024*1024,"minFreeFileNodes":0});
    let scanned = rpc(
        &mut server,
        702,
        "migration/batch/scan",
        json!({"sourceIds":[],"historySources":selections,"resourceLimits":limits}),
    );
    let job = scanned["job"]["jobId"].clone();
    let pending = rpc(
        &mut server,
        703,
        "migration/batch/resources/read",
        json!({"jobId":job}),
    );
    assert_eq!(pending["phase"], "planned");
    assert!(pending.get("usage").is_none());
    let planned = rpc(
        &mut server,
        704,
        "migration/batch/plan",
        json!({
        "jobId":job,"expectedSequence":scanned["job"]["sequence"],"choices":[],"includeDefaultItems":true}),
    );
    let plan = planned["batch"]["planId"].clone();
    let stopped = rpc(
        &mut server,
        705,
        "migration/batch/apply",
        json!({
        "jobId":job,"planId":plan,"requestId":"apply-original-resource-policy",
        "expectedSequence":planned["job"]["sequence"]}),
    );
    assert_eq!(stopped["job"]["status"], "completed_with_issues");
    assert_eq!(stopped["batch"]["unresolvedActions"], 1);
    let before = rpc(
        &mut server,
        706,
        "migration/batch/resources/read",
        json!({"jobId":job}),
    );
    assert_eq!(before["phase"], "active");
    assert_eq!(before["policyRevision"], 0);
    assert_eq!(before["usage"]["committedFiles"], 5);
    let mut raised = limits.clone();
    raised["maxPayloadFiles"] = 12.into();
    let intent = json!({"jobId":job,"planId":plan,"requestId":"raise-original-resource-policy",
        "expectedPolicyRevision":0,"limits":raised,"confirm":true});
    let mut unconfirmed = intent.clone();
    unconfirmed.as_object_mut().unwrap().remove("confirm");
    server.send(json!({"jsonrpc":"2.0","id":707,"method":"migration/batch/resources/increase","params":unconfirmed}));
    assert!(
        server.response(707)["error"]["message"]
            .as_str()
            .unwrap()
            .contains("migration_resource_consent_required")
    );
    assert_eq!(
        rpc(
            &mut server,
            708,
            "migration/batch/resources/read",
            json!({"jobId":job})
        ),
        before
    );

    // Deliberately do not observe the mutation response. Only the original durable receipt
    // establishes acceptance; a missing receipt while the request is in flight proves nothing.
    server.send(json!({"jsonrpc":"2.0","id":709,"method":"migration/batch/resources/increase","params":intent}));
    let deadline = Instant::now() + Duration::from_secs(15);
    let known = loop {
        let value = rpc(
            &mut server,
            710,
            "migration/batch/resources/read",
            json!({
            "jobId":job,"requestId":"raise-original-resource-policy"}),
        );
        if value.get("requestedReceipt").is_some() {
            break value;
        }
        assert!(
            Instant::now() < deadline,
            "original receipt was not observed"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(known["usage"], before["usage"]);
    assert_eq!(known["policyRevision"], 1);
    let receipt = known["requestedReceipt"].clone();
    assert_eq!(receipt["requestId"], "raise-original-resource-policy");
    drop(server);
    let mut server = fixture.start();
    let reopened = rpc(
        &mut server,
        711,
        "migration/batch/resources/read",
        json!({
        "jobId":job,"requestId":"raise-original-resource-policy"}),
    );
    assert_eq!(reopened, known);
    let same_parent = rpc(
        &mut server,
        712,
        "migration/batch/read",
        json!({"jobId":job}),
    );
    assert_eq!(
        same_parent["state"]["job"]["sequence"],
        stopped["job"]["sequence"]
    );
    assert_eq!(
        same_parent["state"]["job"]["status"],
        "completed_with_issues"
    );
    let repeated = rpc(
        &mut server,
        713,
        "migration/batch/resources/increase",
        intent.clone(),
    );
    assert_eq!(repeated, receipt);
    rpc(
        &mut server,
        714,
        "migration/batch/run",
        json!({
        "jobId":job,"planId":plan,"requestId":"explicit-resume-resource-policy","mode":"resume",
        "expectedSequence":same_parent["state"]["job"]["sequence"]}),
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let done = loop {
        let value = rpc(
            &mut server,
            715,
            "migration/batch/read",
            json!({"jobId":job}),
        );
        if value["workerRunning"] == false && value["state"]["job"]["status"] == "completed" {
            break value;
        }
        assert!(
            Instant::now() < deadline,
            "explicit resume did not settle: {value}"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let finished = rpc(
        &mut server,
        716,
        "migration/batch/resources/read",
        json!({"jobId":job}),
    );
    assert_eq!(finished["usage"]["committedFiles"], 10);
    std::fs::remove_file(first).unwrap();
    std::fs::remove_file(second).unwrap();
    drop(server);
    let mut server = fixture.start();
    assert_eq!(
        rpc(
            &mut server,
            717,
            "migration/batch/resources/increase",
            intent
        ),
        receipt
    );
    let undo = rpc(
        &mut server,
        718,
        "migration/batch/rollback",
        json!({
        "jobId":job,"planId":plan,"requestId":"undo-resource-budget-fixture",
        "expectedSequence":done["state"]["job"]["sequence"]}),
    );
    assert_eq!(undo["job"]["status"], "rolled_back");
    let after = rpc(
        &mut server,
        719,
        "migration/batch/resources/read",
        json!({
        "jobId":job,"requestId":"raise-original-resource-policy"}),
    );
    assert_eq!(after["requestedReceipt"], receipt);
    assert!(!after.to_string().contains("PRIVATE-AUTH-CANARY"));
    assert_eq!(
        std::fs::read_to_string(fixture.profile.join("settings.json")).unwrap(),
        "{}"
    );
}
