use super::*;
use serde_json::{Value, json};

#[test]
fn app_server_host_control_rejects_retired_commands_and_injected_authority() {
    let original = json!({"kind":"start_app_server_host", "selection":{
        "revision":1, "launchRef":"a".repeat(64), "enabled":true
    }, "budgetMs":1000});
    let parsed: AppServerHostManagerRequest = serde_json::from_value(original.clone()).unwrap();
    assert!(parsed.parts().unwrap().2);
    assert!(
        serde_json::from_value::<AppServerHostManagerRequest>(json!({
            "kind":"start_host", "hostLaunchRef":"a".repeat(64), "budgetMs":1000
        }))
        .is_err()
    );
    for field in [
        "trusted",
        "sourceBinding",
        "member",
        "backgroundAuthorized",
        "program",
        "input",
    ] {
        let mut forged = original.clone();
        forged[field] = true.into();
        assert!(serde_json::from_value::<AppServerHostManagerRequest>(forged).is_err());
    }
    let mut stale = original;
    stale["selection"]["revision"] = 0.into();
    assert!(
        serde_json::from_value::<AppServerHostManagerRequest>(stale)
            .unwrap()
            .parts()
            .is_err()
    );
}
fn scope() -> Value {
    json!({"accountId":"owner","targetId":"target","workspaceId":"workspace","identityGeneration":"epoch-1","targetRevision":"config-1"})
}
fn stream() -> Value {
    json!({"id":"original-stream","hostEpoch":"original-host","appServerEpoch":"original-app-server","scope":scope()})
}
fn request() -> Value {
    json!({"contractVersion":"parallel-v1","requestId":"original-request","scope":scope(),"timeoutMs":30000,"payload":{"connectionId":"bot"}})
}
fn frame() -> Value {
    json!({"kind":"ui_call","stream":stream(),"sequence":1,"requestId":42,"call":{"method":"connectivity","params":{"port":"P-CONNECTION","method":"readConnection","request":request()}}})
}
fn decode(value: &Value) -> Result<ChannelPeerClientFrame, String> {
    decode_channel_peer_frame(&serde_json::to_vec(value).unwrap())
}
#[test]
fn original_task_resume_is_finite_strict_and_never_a_background_call() {
    let mut value = frame();
    value["call"] = json!({"method":"task.resume","params":{
        "scope":scope(),"sourceAuthorityEpoch":1,"bindingRef":{"id":"binding","revision":"2"},
        "resume":{"threadId":"original-task"}}});
    let parsed = decode(&value).unwrap();
    assert!(ChannelPeerLane::Ui.accepts(&parsed));
    assert!(!ChannelPeerLane::Background.accepts(&parsed));
    for field in [
        "settingsTemplate",
        "trusted",
        "input",
        "model",
        "permissionMode",
    ] {
        let mut changed = value.clone();
        changed["call"]["params"]["resume"][field] = json!("untrusted");
        assert!(
            decode(&changed).is_err(),
            "unexpected resume field: {field}"
        );
    }
    let mut changed = value.clone();
    changed["call"]["params"]["sourceAuthorityEpoch"] = json!(0);
    assert!(decode(&changed).is_err());
    changed = value;
    changed["call"]["method"] = json!("turn/start");
    assert!(decode(&changed).is_err());
}
#[test]
fn first_party_task_frames_allow_no_chat_but_reject_malformed_binding() {
    let mut value = frame();
    for (method, body) in [
        (
            "task.resume",
            json!({"resume":{"threadId":"original-task"}}),
        ),
        (
            "task.turnStart",
            json!({"turn":{"threadId":"original-task","clientMessageId":"stable-original-message","input":[{"type":"text","text":"hello"}]}}),
        ),
        (
            "task.interrupt",
            json!({"threadId":"original-task","turnId":"turn-1"}),
        ),
    ] {
        let mut params = body;
        params["scope"] = scope();
        params["sourceAuthorityEpoch"] = json!(1);
        value["call"] = json!({"method":method,"params":params});
        let parsed = decode(&value).unwrap();
        assert!(ChannelPeerLane::Ui.accepts(&parsed));
        assert!(!ChannelPeerLane::Background.accepts(&parsed));
        value["call"]["params"]["bindingRef"] = json!({"id":"binding","revision":""});
        assert!(decode(&value).is_err());
    }
}

#[test]
fn original_task_notifications_cannot_carry_rpc_commands_or_another_task() {
    let value = json!({"kind":"task_notification","stream":stream(),"threadId":"original-task",
        "notification":{"jsonrpc":"2.0","method":"item/delta","params":{
            "threadId":"original-task","delta":"original output"}}});
    let validate = |value: Value| {
        serde_json::from_value::<ChannelPeerServerFrame>(value)
            .map_err(|error| error.to_string())
            .and_then(|frame| frame.validate())
    };
    assert!(validate(value.clone()).is_ok());
    for field in ["id", "result", "error"] {
        let mut changed = value.clone();
        changed["notification"][field] = Value::Null;
        assert!(validate(changed).is_err());
    }
    let mut changed = value.clone();
    changed["notification"]["params"]["threadId"] = json!("other-task");
    assert!(validate(changed).is_err());
    let mut changed = value.clone();
    changed["notification"]["method"] = json!("turn/start");
    assert!(validate(changed).is_err());
    let mut changed = value;
    changed["notification"]["jsonrpc"] = json!("1.0");
    assert!(validate(changed).is_err());
}
#[test]
fn ui_initialize_carries_only_one_short_original_transport_nonce() {
    let value = json!({"kind":"initialize","admissionNonce":"0123456789abcdef0123456789abcdef",
        "params":{"protocolVersion":crate::PROTOCOL_VERSION,"clientInfo":{"name":"original-ui","version":"1"},"capabilities":{"experimental":{}}}});
    assert!(decode(&value).is_ok());
    for nonce in [
        Value::Null,
        json!(""),
        json!("not-an-original-memory-nonce"),
        json!("0".repeat(33)),
    ] {
        let mut changed = value.clone();
        changed["admissionNonce"] = nonce;
        assert!(decode(&changed).is_err());
    }
    let parsed = decode(&value).unwrap();
    assert!(!ChannelPeerLane::Background.accepts(&parsed));
    let mut changed = value;
    changed["trusted"] = json!(true);
    assert!(decode(&changed).is_err());
}
#[test]
fn original_ui_sdk_reference_is_optional_bounded_and_carries_no_authority() {
    let original = json!({"kind":"ui_register","registration":{
        "nonce":"0123456789abcdef0123456789abcdef","scope":scope(),"sourceAuthorityEpoch":1,"expiresAtMs":1,
        "initialize":{"protocolVersion":crate::PROTOCOL_VERSION,"clientInfo":{"name":"owned-sdk-client","version":"1"},"capabilities":{"experimental":{}}},
        "originalCall":frame()["call"]["params"].clone()}});
    assert!(decode(&original).is_ok());
    let mut selected = original.clone();
    selected["registration"]["sdkLaunchRef"] = json!("a".repeat(64));
    let parsed =
        decode(&selected).expect("an authenticated producer may name its verified deployment");
    assert_eq!(serde_json::to_value(parsed).unwrap(), selected);
    for value in ["", "../deployment", &"g".repeat(64), &"a".repeat(65)] {
        selected["registration"]["sdkLaunchRef"] = json!(value);
        assert!(decode(&selected).is_err());
    }
    selected = original;
    selected["registration"]["trusted"] = json!(true);
    assert!(decode(&selected).is_err());
}

#[test]
fn original_ui_capabilities_survive_gateway_growth_and_remain_bounded() {
    let mut initialize = json!({"kind":"initialize","admissionNonce":"0123456789abcdef0123456789abcdef",
        "params":{"protocolVersion":crate::PROTOCOL_VERSION,"clientInfo":{"name":"kcoder-studio-wework","version":"1"},"capabilities":{"experimental":{}}}});
    let mut registration = json!({"kind":"ui_register","registration":{
        "nonce":"0123456789abcdef0123456789abcdef","scope":scope(),"sourceAuthorityEpoch":1,"expiresAtMs":1,
        "initialize":initialize["params"].clone(),"originalCall":frame()["call"]["params"].clone()}});
    for count in [66, CHANNEL_PEER_INITIALIZE_CAPABILITIES] {
        let capabilities: serde_json::Map<String, Value> = (0..count)
            .map(|index| (format!("negotiatedFeature{index}"), json!(index % 2 == 0)))
            .collect();
        initialize["params"]["capabilities"]["experimental"] = json!(capabilities);
        registration["registration"]["initialize"] = initialize["params"].clone();
        for value in [&initialize, &registration] {
            let parsed =
                decode(value).expect("the original negotiated capabilities must be retained");
            assert_eq!(serde_json::to_value(parsed).unwrap(), *value);
        }
    }
    initialize["params"]["capabilities"]["experimental"]["oneTooMany"] = json!(true);
    registration["registration"]["initialize"] = initialize["params"].clone();
    assert!(decode(&initialize).is_err());
    assert!(decode(&registration).is_err());
}
#[test]
fn private_peer_frames_reject_arbitrary_methods_authority_fields_and_wrong_scope() {
    let original = frame();
    assert!(decode(&original).is_ok());
    for changed in [
        json!({"kind":"ui_call","stream":stream(),"sequence":1,"requestId":42,"method":"arbitrary"}),
        {
            let mut v = original.clone();
            v["trusted"] = json!(true);
            v
        },
        {
            let mut v = original.clone();
            v["call"]["method"] = json!("runtime.acceptTask");
            v
        },
        {
            let mut v = original.clone();
            let mut legacy = request();
            legacy["payload"] = json!({});
            v["call"] = json!({"method":"service", "params":{
                "method":"integrations/services/channel/capabilities", "request":legacy
            }});
            v
        },
        {
            let mut v = original.clone();
            v["call"]["params"]["request"]["scope"]["accountId"] = json!("peer");
            v
        },
        {
            let mut v = original.clone();
            v["sequence"] = json!(0);
            v
        },
    ] {
        assert_eq!(
            decode(&changed).err().as_deref(),
            Some("CHANNEL_PEER_FRAME_INVALID")
        );
    }
    assert_eq!(
        decode_channel_peer_frame(&vec![b'x'; CHANNEL_PEER_FRAME_BYTES + 1])
            .err()
            .as_deref(),
        Some("CHANNEL_PEER_FRAME_INVALID")
    );
}
#[test]
fn source_lane_cannot_initialize_ui_or_invoke_public_management() {
    let ui = decode(&frame()).unwrap();
    assert!(ChannelPeerLane::Ui.accepts(&ui));
    assert!(!ChannelPeerLane::Background.accepts(&ui));
    let source=decode(&json!({"kind":"background_open","leaseRef":{"id":"original-lease","revision":"3"},"originalOperationId":"original-consent"})).unwrap();
    assert!(ChannelPeerLane::Background.accepts(&source));
    assert!(!ChannelPeerLane::Ui.accepts(&source));
    let bad = json!({"kind":"background_open","leaseRef":{"id":"original-lease","revision":"3"},"originalOperationId":"original-consent","purpose":"ui"});
    assert!(decode(&bad).is_err());
}
#[test]
fn reused_numeric_request_id_does_not_match_a_new_stream_or_epoch() {
    let original: ChannelPeerStreamRef = serde_json::from_value(stream()).unwrap();
    let reply = ChannelPeerServerFrame::Failure {
        stream: original.clone(),
        sequence: 1,
        request_id: ChannelPeerRequestId::Number(42),
        failure: ChannelPeerFailure::Unknown,
        reason_sha256: None,
    };
    assert!(reply.matches_reply(&original, 1, &ChannelPeerRequestId::Number(42)));
    let mut new = original.clone();
    new.id = "new-stream".into();
    assert!(!reply.matches_reply(&new, 1, &ChannelPeerRequestId::Number(42)));
    new = original.clone();
    new.app_server_epoch = "new-app-server".into();
    assert!(!reply.matches_reply(&new, 1, &ChannelPeerRequestId::Number(42)));
    assert!(!reply.matches_reply(&original, 2, &ChannelPeerRequestId::Number(42)));
}
#[test]
fn background_renew_names_only_an_existing_successor_and_cannot_add_fresh_consent_or_ttl() {
    let original = json!({"kind":"background_call","stream":stream(),"sequence":3,"requestId":42,"call":{
        "action":"renew","predecessorRef":{"id":"old-original","revision":"3"},"successorRef":{"id":"already-issued-successor","revision":"1"},
        "originalOperationId":"original-ui-renew-consent","expectedRevision":3}});
    assert!(decode(&original).is_ok());
    for field in ["expiresInMs", "explicitBackgroundConsent", "trusted"] {
        let mut changed = original.clone();
        changed["call"][field] = json!(true);
        assert!(decode(&changed).is_err());
    }
    let mut changed = original;
    changed["call"]["successorRef"]["id"] = json!("old-original");
    assert!(decode(&changed).is_err());
}
#[test]
fn interaction_response_requires_original_stream_epoch_thread_turn_and_receipt() {
    let owner:ChannelPeerInteractionOwner=serde_json::from_value(json!({"stream":stream(),"requestId":42,"threadId":"thread","turnId":"turn",
        "interactionId":"question","interactionRevision":"7","appServerEpoch":"original-app-server"})).unwrap();
    let value = json!({"kind":"question","owner":owner,"response":{"answers":{},"questionId":"question","threadId":"thread","turnId":"turn"}});
    let response: ChannelPeerInteractionResponse = serde_json::from_value(value.clone()).unwrap();
    assert!(response.matches_owner(&owner));
    for field in ["interaction_revision", "turn_id", "app_server_epoch"] {
        let mut expected = owner.clone();
        match field {
            "interaction_revision" => expected.interaction_revision = "8".into(),
            "turn_id" => expected.turn_id = "peer-turn".into(),
            _ => expected.app_server_epoch = "new-epoch".into(),
        };
        assert!(!response.matches_owner(&expected));
    }
    let mut wrong = value;
    wrong["response"]["threadId"] = json!("peer-thread");
    assert!(
        serde_json::from_value::<ChannelPeerInteractionResponse>(wrong)
            .unwrap()
            .validate()
            .is_err()
    );
}

#[test]
fn private_failure_diagnostic_contains_only_a_fixed_digest_and_original_correlation() {
    let original = json!({"kind":"failure","stream":stream(),"sequence":1,"requestId":42,"failure":"unknown","reasonSha256":"a".repeat(64)});
    let frame: ChannelPeerServerFrame = serde_json::from_value(original.clone()).unwrap();
    assert!(frame.validate().is_ok());
    for digest in [
        "PRIVATE_CREDENTIAL_VALUE".to_owned(),
        "a".repeat(63),
        "A".repeat(64),
        "a".repeat(65),
    ] {
        let mut changed = original.clone();
        changed["reasonSha256"] = json!(digest);
        let frame: ChannelPeerServerFrame = serde_json::from_value(changed).unwrap();
        assert!(frame.validate().is_err());
    }
    let mut legacy = original;
    legacy.as_object_mut().unwrap().remove("reasonSha256");
    let legacy: ChannelPeerServerFrame = serde_json::from_value(legacy).unwrap();
    assert!(legacy.validate().is_ok());
}

#[test]
fn admission_diagnostic_rejects_raw_text_unknown_stage_and_excessive_chains() {
    let valid = serde_json::json!({"kind":"admission_failed","stage":"register","reasonSha256":["a".repeat(64)]});
    let frame: super::ChannelPeerServerFrame = serde_json::from_value(valid.clone()).unwrap();
    assert!(frame.validate().is_ok());
    for values in [
        serde_json::json!([]),
        serde_json::json!(["raw exception text"]),
        serde_json::json!(vec!["a".repeat(64); 7]),
    ] {
        let mut changed = valid.clone();
        changed["reasonSha256"] = values;
        let frame: super::ChannelPeerServerFrame = serde_json::from_value(changed).unwrap();
        assert!(frame.validate().is_err());
    }
    let mut changed = valid.clone();
    changed["stage"] = serde_json::json!("arbitrary");
    assert!(serde_json::from_value::<super::ChannelPeerServerFrame>(changed).is_err());
    let mut changed = valid;
    changed["message"] = serde_json::json!("raw input");
    assert!(serde_json::from_value::<super::ChannelPeerServerFrame>(changed).is_err());
}

#[test]
fn task_resource_fact_is_typed_exact_and_ui_only_without_authority_fields() {
    let original = json!({"kind":"ui_call","stream":stream(),"sequence":1,"requestId":"original-fact-read",
        "call":{"method":"taskResources.readFact","params":{"scope":scope(),"sourceAuthorityEpoch":1,
        "connectionRef":{"id":"original-connection","revision":"1"},
        "resourceRefs":[{"id":"original-resource","revision":"1","kind":"document"}]}}});
    let decoded = decode(&original).unwrap();
    assert!(ChannelPeerLane::Ui.accepts(&decoded));
    assert!(!ChannelPeerLane::Background.accepts(&decoded));
    for changed in [
        {
            let mut v = original.clone();
            v["call"]["params"]["scope"]["accountId"] = json!("peer");
            v
        },
        {
            let mut v = original.clone();
            v["call"]["params"]["trusted"] = json!(true);
            v
        },
        {
            let mut v = original.clone();
            v["call"]["params"]["uri"] = json!("ungranted://body");
            v
        },
        {
            let mut v = original.clone();
            v["call"]["params"]["sourceAuthorityEpoch"] = json!(0);
            v
        },
        {
            let mut v = original.clone();
            v["call"]["params"]["resourceRefs"] = json!([]);
            v
        },
        {
            let mut v = original.clone();
            v["call"]["params"]["resourceRefs"][0]["kind"] = json!("arbitrary");
            v
        },
        {
            let mut v = original.clone();
            let row = v["call"]["params"]["resourceRefs"][0].clone();
            v["call"]["params"]["resourceRefs"] = json!([row, row]);
            v
        },
    ] {
        assert!(decode(&changed).is_err());
    }
}
