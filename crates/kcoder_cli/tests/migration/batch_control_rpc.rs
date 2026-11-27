use super::{Fixture, TestAppServer, Value, json, rpc};
use std::time::{Duration, Instant};

fn wait(server: &mut TestAppServer, job: &Value, stopped: bool) -> Value {
    // The final wait covers a full 3000-record normalization after resume,
    // which takes 45-60 s in an unoptimized build on a disk-backed
    // filesystem. Cancellation itself stops the owner within milliseconds.
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        let value = rpc(server, 1210, "migration/batch/read", json!({"jobId":job}));
        if !stopped || value["workerRunning"] == false {
            return value;
        }
        assert!(
            Instant::now() < deadline,
            "original batch owner did not stop"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn batch_control_original_receipt_reopens_across_processes_without_cancelling_a_new_resume() {
    let fixture = Fixture::new();
    let source = fixture.source(3000);
    let original = std::fs::read(&source).unwrap();
    let mut owner = fixture.start();
    let sources = rpc(
        &mut owner,
        1200,
        "migration/history/discover",
        json!({"source":"claude-code"}),
    );
    let scan = rpc(
        &mut owner,
        1201,
        "migration/batch/scan",
        json!({"sourceIds":[],"historySources":[{"catalogId":sources["catalogId"],"sourceHandle":sources["items"][0]["sourceHandle"]}]}),
    );
    let job = scan["job"]["jobId"].clone();
    let planned = rpc(
        &mut owner,
        1202,
        "migration/batch/plan",
        json!({"jobId":job,"expectedSequence":scan["job"]["sequence"],"choices":[],"includeDefaultItems":true}),
    );
    let plan = planned["batch"]["planId"].clone();
    let before = rpc(
        &mut owner,
        1203,
        "migration/batch/control/read",
        json!({"jobId":job}),
    );
    assert_eq!(before["phase"], "unadmitted");
    rpc(
        &mut owner,
        1204,
        "migration/batch/run",
        json!({"jobId":job,"planId":plan,"expectedSequence":planned["job"]["sequence"],"requestId":"control-rpc-original","mode":"apply"}),
    );
    let mut observer = fixture.start();
    let deadline = Instant::now() + Duration::from_secs(30);
    let control = loop {
        let value = rpc(
            &mut observer,
            1205,
            "migration/batch/control/read",
            json!({"jobId":job}),
        );
        if value["phase"] == "tracked" {
            break value;
        }
        assert!(
            Instant::now() < deadline,
            "execution admission was not observed"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    let command = json!({"jobId":job,"planId":plan,"runRequestId":"control-rpc-original","admissionSequence":control["generation"]["admissionSequence"],"commandId":"40000000-0000-4000-8000-000000000009"});
    // Discard this response. A separate process must recover the original durable receipt.
    rpc(
        &mut observer,
        1206,
        "migration/batch/control/cancel",
        command.clone(),
    );
    observer.shutdown();
    let stopped = wait(&mut owner, &job, true);
    assert_eq!(stopped["state"]["job"]["status"], "cancelled");
    owner.shutdown();
    let mut reopened = fixture.start();
    let recovered = rpc(
        &mut reopened,
        1207,
        "migration/batch/control/read",
        json!({"jobId":job,"commandId":command["commandId"]}),
    );
    assert_eq!(
        recovered["requestedReceipt"]["commandId"],
        command["commandId"]
    );
    assert_eq!(
        recovered["requestedReceipt"]["runRequestId"],
        "control-rpc-original"
    );
    assert_eq!(
        rpc(
            &mut reopened,
            1208,
            "migration/batch/control/cancel",
            command.clone()
        ),
        recovered
    );
    let accepted = recovered["requestedReceipt"].clone();
    rpc(
        &mut reopened,
        1209,
        "migration/batch/run",
        json!({"jobId":job,"planId":plan,"expectedSequence":stopped["state"]["job"]["sequence"],"requestId":"control-rpc-new-resume","mode":"resume"}),
    );
    let mut peer = fixture.start();
    let old = rpc(
        &mut peer,
        1211,
        "migration/batch/control/cancel",
        command.clone(),
    );
    assert_eq!(old["requestedReceipt"], accepted);
    assert_eq!(old["cancelRequested"], false);
    assert_eq!(old["generation"]["runRequestId"], "control-rpc-new-resume");
    let mut changed = command;
    changed["runRequestId"] = json!("control-rpc-new-resume");
    changed["admissionSequence"] = old["generation"]["admissionSequence"].clone();
    peer.send(json!({"jsonrpc":"2.0","id":1212,"method":"migration/batch/control/cancel","params":changed}));
    assert_eq!(
        peer.response(1212)["error"]["message"],
        "migration_batch_cancel_command_changed"
    );
    let done = wait(&mut reopened, &job, true);
    assert!(done["workerError"].is_null());
    assert_eq!(done["state"]["job"]["status"], "completed");
    assert_eq!(std::fs::read(&source).unwrap(), original);
    peer.shutdown();
    reopened.shutdown();
}
