//! Model-independent transport tests for bounded rendering repair and terminal cancellation.
use super::inline_widgets::{
    initialize_widgets, recorded_widget, render_observation_in_request, widget_server,
    write_widget_settings,
};
use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Repair,
    Exhausted,
    Unconfirmed,
    Cancel,
}

fn latest_tool_value(request: &Value, extract: fn(&Value) -> Option<Value>) -> Value {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .filter(|message| message["role"] == "tool")
        .find_map(extract)
        .expect("the latest widget tool result must reach the next provider request")
}

fn repair_transport(outcome: Outcome) {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let limit = match outcome {
        Outcome::Repair => 3,
        Outcome::Exhausted => 4,
        _ => 2,
    };
    let (endpoint, calls, fixture) = serving_fixture_decided_bounded(
        move |index, request| {
            let mut input = json!({"title":"Inspect diagram","summary":"Accessible diagram description",
            "format":"svg","widget_code":format!("<svg><text>revision-{}</text></svg>",index+1)});
            if index > 0 {
                let feedback = latest_tool_value(request, render_observation_in_request);
                match outcome {
                    Outcome::Unconfirmed => assert_eq!(feedback["render_status"], "unconfirmed"),
                    Outcome::Repair if index == 2 => {
                        assert_eq!(feedback["render_status"], "rendered")
                    }
                    _ => {
                        assert_eq!(feedback["render_status"], "failed");
                        assert_eq!(feedback["repair_allowed"], index <= 2);
                    }
                }
                let previous = latest_tool_value(request, recorded_widget);
                input["widget_id"] = previous["widget_id"].clone();
                input["expected_revision"] = previous["revision"].clone();
            }
            if index + 1 == limit {
                return FixtureAnswer::Text(
                    "Completed with the retained accessible description.".into(),
                );
            }
            FixtureAnswer::Tool {
                id: format!("repair-call-{index}"),
                name: "show_widget".into(),
                input,
            }
        },
        Some(limit),
        Duration::from_secs(6),
    );
    let settings = root.path().join("settings.json");
    write_widget_settings(&settings, &endpoint, "openai_chat_completions");
    let mut server = widget_server(
        &workspace,
        &settings,
        &root.path().join("profile"),
        &endpoint,
    );
    initialize_widgets(&mut server, true);
    server.send(json!({"id":2,"method":"thread/start","params":{"studioWorkMode":"kworker","cwd":workspace}}));
    let thread = server.response(2)["result"]["thread"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    server.send(json!({"id":3,"method":"turn/start","params":{"threadId":thread,
        "clientPresentation":{"version":1,"studioWorkMode":"kworker","inlineWidgets":true},
        "input":[{"type":"text","text":"Render and verify the supplied diagram without replaying other work."}]}}));
    let accepted = server.response(3);
    assert!(accepted.get("error").is_none(), "{accepted}");
    let turn = accepted["result"]["turn"]["id"].clone();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(25);
    let mut references: Vec<Value> = Vec::new();
    loop {
        let value = server.next_value(deadline);
        if value["method"] == "item/completed" && value["params"]["item"]["widgetRef"].is_object() {
            let widget = value["params"]["item"]["widgetRef"].clone();
            assert_eq!(widget["turnId"], turn);
            assert_eq!(value["params"]["attemptId"], widget["attemptId"]);
            assert!(value["params"]["attemptId"].is_string(), "{value}");
            assert_eq!(widget["revision"], references.len() + 1);
            if let Some(first) = references.first() {
                assert_eq!(widget["widgetId"], first["widgetId"]);
            }
            references.push(widget.clone());
            if outcome == Outcome::Cancel {
                server.send(json!({"id":40,"method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}}));
                assert!(server.response(40).get("error").is_none());
            } else if outcome != Outcome::Unconfirmed {
                let status = if outcome == Outcome::Repair && references.len() == 2 {
                    "rendered"
                } else {
                    "failed"
                };
                let mut receipt = json!({"widget":{"threadId":thread,"widgetId":widget["widgetId"],"revision":widget["revision"]},
                    "turnId":turn,"attemptId":widget["attemptId"],"toolCallId":widget["toolCallId"],"status":status});
                if status == "failed" {
                    receipt["errorCode"] = json!("render_failed");
                }
                let id = 10 + references.len() as i64;
                server.send(json!({"id":id,"method":"widget/render/receipt","params":receipt}));
                assert_eq!(server.response(id)["result"]["accepted"], true);
            }
        }
        if value["method"] == "turn/completed" {
            let expected = if outcome == Outcome::Cancel {
                "interrupted"
            } else {
                "completed"
            };
            assert_eq!(value["params"]["turn"]["status"], expected, "{value}");
            break;
        }
    }
    let expected_revisions = match outcome {
        Outcome::Repair => 2,
        Outcome::Exhausted => 3,
        _ => 1,
    };
    assert_eq!(references.len(), expected_revisions);
    let first = &references[0];
    server.send(json!({"id":50,"method":"widget/content/read","params":{"threadId":thread,"widgetId":first["widgetId"],"revision":1}}));
    let original = server.response(50);
    let source = base64::engine::general_purpose::STANDARD
        .decode(original["result"]["dataBase64"].as_str().unwrap())
        .unwrap();
    assert!(String::from_utf8(source).unwrap().contains("revision-1"));
    if outcome == Outcome::Unconfirmed {
        assert!(started.elapsed() >= Duration::from_millis(2500));
    }
    server.send(json!({"id":51,"method":"thread/resume","params":{"threadId":thread}}));
    assert!(server.response(51)["result"]["streamContext"]["activeTurn"].is_null());
    if outcome == Outcome::Cancel {
        server.send(json!({"id":52,"method":"widget/render/receipt","params":{
            "widget":{"threadId":thread,"widgetId":first["widgetId"],"revision":1},"turnId":turn,
            "attemptId":first["attemptId"],"toolCallId":first["toolCallId"],"status":"failed","errorCode":"render_failed"}}));
        assert_eq!(server.response(52)["result"]["accepted"], true);
    }
    server.shutdown_successfully();
    fixture.join().unwrap();
    assert_eq!(
        fixture_call_count(&calls),
        if outcome == Outcome::Cancel { 1 } else { limit }
    );
}

#[test]
fn rendering_failure_repairs_only_the_current_widget_and_retains_its_history() {
    repair_transport(Outcome::Repair);
}
#[test]
fn rendering_failures_stop_after_two_automatic_repair_responses() {
    repair_transport(Outcome::Exhausted);
}
#[test]
fn offscreen_or_disconnected_rendering_remains_unconfirmed_without_regeneration() {
    repair_transport(Outcome::Unconfirmed);
}
#[test]
fn cancellation_during_render_wait_and_late_receipts_never_revive_the_turn() {
    repair_transport(Outcome::Cancel);
}
