use kcoder_app_protocol::{
    JSONRPC_VERSION, Notification, Request, RequestId, Response, ResponsePayload, RpcError,
};

#[test]
fn json_rpc_envelopes_keep_ids_and_payloads_unambiguous() {
    let request = Request::new(
        "request-1",
        "thread/read",
        serde_json::json!({"threadId": "thread-1"}),
    );
    let request_wire = serde_json::to_value(&request).expect("request should serialize");
    assert_eq!(request_wire["jsonrpc"], JSONRPC_VERSION);
    assert_eq!(request_wire["id"], "request-1");
    assert_eq!(request_wire["method"], "thread/read");
    assert_eq!(request_wire["params"]["threadId"], "thread-1");

    let notification = Notification::new("turn/completed", serde_json::json!({"turnId": "turn-1"}));
    let notification_wire =
        serde_json::to_value(notification).expect("notification should serialize");
    assert!(notification_wire.get("id").is_none());

    let response = Response::<serde_json::Value>::error(
        RequestId::Number(7),
        RpcError {
            code: -32602,
            message: "invalid params".to_string(),
            data: Some(serde_json::json!({"field": "threadId"})),
        },
    );
    let response_wire = serde_json::to_value(&response).expect("response should serialize");
    assert_eq!(response_wire["id"], 7);
    assert!(response_wire.get("result").is_none());
    assert_eq!(response_wire["error"]["code"], -32602);

    let decoded: Response<serde_json::Value> =
        serde_json::from_value(response_wire).expect("response should deserialize");
    assert!(matches!(decoded.payload, ResponsePayload::Error { .. }));
}

#[test]
fn request_id_accepts_numeric_and_string_wire_forms_but_not_null() {
    let numeric: RequestId = serde_json::from_str("42").expect("numeric id should decode");
    let textual: RequestId =
        serde_json::from_str("\"request-42\"").expect("string id should decode");

    assert_eq!(numeric, RequestId::Number(42));
    assert_eq!(textual, RequestId::String("request-42".to_string()));
    assert!(serde_json::from_str::<RequestId>("null").is_err());
}
