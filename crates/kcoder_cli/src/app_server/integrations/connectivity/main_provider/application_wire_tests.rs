use super::*;

fn call(port: &str, method: &str, payload: Value) -> IntegrationCall {
    serde_json::from_value(json!({
        "port": port, "method": method,
        "request": {"contractVersion":"parallel-v1", "requestId":"application-wire",
            "scope":{"accountId":"owner", "targetId":"target", "workspaceId":null,
                "identityGeneration":"1", "targetRevision":"1"},
            "timeoutMs":1000, "payload":payload}
    }))
    .unwrap()
}

#[test]
fn application_callbacks_keep_resource_selection_and_original_task_admission() {
    for action in [
        "application.selectResources",
        "application.runOfficeTask",
        "connectivity.prepareConnectionAction",
        "connectivity.inspectReadiness",
    ] {
        call("P-POLICY", "evaluateAction", json!({"action":action}))
            .validate_application_route()
            .unwrap();
    }
    call(
        "P-RUNTIME",
        "acceptTask",
        json!({"source":{"kind":"application"}}),
    )
    .validate_application_route()
    .unwrap();
}

#[test]
fn retired_channel_callbacks_do_not_reach_native_policy_or_runtime() {
    for action in [
        "channel.connect",
        "channel.maintain",
        "channel.grantDestination",
        "channel.readBoundTask",
        "channel.readMedia",
        "channel.testMessage",
        "channel.acceptTask",
        "channel.observeTask",
        "channel.respondInteraction",
        "channel.cancelTask",
        "channel.resumeTask",
        "delivery.send",
        "delivery.read",
    ] {
        assert!(
            call("P-POLICY", "evaluateAction", json!({"action":action}))
                .validate_application_route()
                .is_err()
        );
    }
    for method in [
        "readOperation",
        "readTask",
        "cancelTask",
        "respondInteraction",
    ] {
        assert!(
            call(
                "P-RUNTIME",
                method,
                json!({"source":{"kind":"application"}})
            )
            .validate_application_route()
            .is_err()
        );
    }
    for payload in [
        json!({"source":{"kind":"channel"}}),
        json!({"source":{"kind":"application"},"command":"new_task"}),
    ] {
        assert!(
            call("P-RUNTIME", "acceptTask", payload)
                .validate_application_route()
                .is_err()
        );
    }
}

#[test]
fn retired_channel_origin_is_not_an_application_wire_field() {
    for name in ["channelOrigin", "channel_origin"] {
        let original = call(
            "P-RUNTIME",
            "acceptTask",
            json!({"source":{"kind":"application"}}),
        );
        let mut value =
            json!({"port":"P-RUNTIME", "method":"acceptTask", "request":original.request});
        value[name] = json!({"ingressId":"old-channel-ingress"});
        assert!(serde_json::from_value::<IntegrationCall>(value).is_err());
    }
}
