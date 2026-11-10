//! Literal ACP client plus an independent protocol-only app-server fixture.
use super::*;
use crate::{
    connection::{AgentInfo, serve},
    framing::{Frame, FrameReader},
};
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};

struct Client {
    input: DuplexStream,
    output: FrameReader<BufReader<DuplexStream>>,
    task: tokio::task::JoinHandle<Result<()>>,
    root: tempfile::TempDir,
}
impl Client {
    async fn start(callback: bool) -> Result<Self> {
        Self::start_mode(if callback { "callback" } else { "plain" }).await
    }
    async fn start_mode(mode: &str) -> Result<Self> {
        let root = tempfile::tempdir()?;
        let script = root.path().join("owned.py");
        std::fs::write(
            &script,
            r#"
import json,sys,os,hashlib,time
log=sys.argv[1]; delayed=sys.argv[2]=='delayed-close'; callback=sys.argv[2]=='callback' or delayed; deny=sys.argv[2]=='bind-denied'; bound=None; scoped=False; facts=None
def out(v): print(json.dumps(v),flush=True)
def record(kind,extra=None):
 with open(log,'a') as f:f.write(json.dumps({'kind':kind,'pid':os.getpid(),**(extra or {})})+'\n')
def receipt(frame,data):
 return {**{k:frame[k] for k in ['version','operationId','requestId','endpointRevision','endpointInstanceId']},'state':'received','data':data}
for line in sys.stdin:
 r=json.loads(line); method=r.get('method'); record(method or 'private_reply')
 if method=='initialize':
  assert r['params']['capabilities']['experimental']['integrationScopeV1'] is True
  value={'protocolVersion':'2026-07-27','serverInfo':{'name':'protocol-fixture','version':'1'},'capabilities':{'approvals':True,'questions':False,'threadResume':False,'experimental':{k:True for k in ['residentThreads','threadMcpServersV1','interactionBindingV1','approvalToolCallIdentityV1','disableUserElicitationV1','studioWorkModesV1','integrationScopeV1']}}}
 elif method=='integrations/scope/read':
  scoped=True; value={'accountId':'actual-fixture-account','targetId':'actual-fixture-target','workspaceId':'actual-fixture-workspace','identityGeneration':'1','targetRevision':'1'}
 elif method=='kcoder/nativeRemote/controlV1':
  assert scoped
  if r['params']['message']['method']=='observe_original':
   if delayed and facts is not None:
    out({'jsonrpc':'2.0','id':r['id'],'result':receipt(r['params'],{'kind':'receiver','accepted':facts,'outcome':'interrupted','cleanupConfirmed':False})});continue
   out({'jsonrpc':'2.0','id':r['id'],'result':{**receipt(r['params'],{'kind':'diagnostic','code':'REMOTE_RECEIVER_OBSERVATION_UNAVAILABLE'}),'state':'unavailable'}});continue
  if deny:
   out({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32086,'message':'REMOTE_RECEIVER_PRIVATE_BINDING_UNAVAILABLE'}});continue
  bound=r['params']; p=bound['message']['params']; assert bound['message']['method']=='bind_original'
  assert hashlib.sha256(p['prompt'].encode()).hexdigest()==p['frozenInputSha256']
  value=receipt(bound,{'kind':'original_bound','frozenInputSha256':p['frozenInputSha256'],'receiverSettingsSha256':'b'*64})
 elif method=='thread/start':
  assert bound is not None and not r['params'].get('mcpServers') and 'cwd' not in r['params']
  value={'thread':{'id':'held-thread','status':'idle','createdAt':'2026-10-26T00:00:00Z','updatedAt':'2026-10-26T00:00:00Z'}}
 elif method=='turn/start':
  assert bound is not None
  if callback:
   facts={'identity':{'threadId':'held-thread','turnId':'actual-turn','attemptId':'actual-attempt'},'acceptedInputSha256':'c'*64,'acceptedReceiptSha256':'d'*64,'receiverSettingsSha256':'b'*64}
   control={**bound,'requestId':'native-callback','message':{'method':'receiver_accepted','params':facts}}
   out({'jsonrpc':'2.0','id':'native-receiver-control-fixture-native-callback','method':'kcoder/nativeRemote/controlV1','params':control})
   response=json.loads(sys.stdin.readline()); assert response['id']=='native-receiver-control-fixture-native-callback'
   record('native_control_settled',{'state':response.get('result',{}).get('state')})
  if delayed:
   while not os.path.exists(log+'.release'):time.sleep(.01)
  out({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32086,'message':'REMOTE_RECEIVER_EXECUTION_UNAVAILABLE'}});continue
 else: value={}
 out({'jsonrpc':'2.0','id':r['id'],'result':value})
"#,
        )?;
        let config = AppServerConfig {
            executable: "/usr/bin/python3".into(),
            args: vec![
                script.into_os_string(),
                root.path().join("methods.jsonl").into_os_string(),
                mode.into(),
                "--internal-acp-backend".into(),
            ],
            environment: Some(BTreeMap::new()),
        };
        let (input, server_input) = tokio::io::duplex(128 * 1024);
        let (server_output, output) = tokio::io::duplex(128 * 1024);
        let task = tokio::spawn(serve(
            BufReader::new(server_input),
            server_output,
            AgentInfo {
                version: "fixture".into(),
                app_server: Some(config),
            },
        ));
        let mut client = Self {
            input,
            output: FrameReader::new(BufReader::new(output)),
            task,
            root,
        };
        client.send(json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}})).await?;
        assert_eq!(client.next().await?["result"]["protocolVersion"], 1);
        Ok(client)
    }
    async fn send(&mut self, frame: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&frame)?;
        bytes.push(b'\n');
        self.input.write_all(&bytes).await?;
        Ok(())
    }
    async fn next(&mut self) -> Result<Value> {
        let frame =
            tokio::time::timeout(std::time::Duration::from_secs(5), self.output.next()).await??;
        match frame {
            Some(Frame::Json(frame)) => Ok(frame),
            _ => anyhow::bail!("literal ACP response missing"),
        }
    }
    async fn call(&mut self, id: Value, method: &str, params: Value) -> Result<Value> {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        self.next().await
    }
    async fn close(self) -> Result<Vec<Value>> {
        let Self {
            input,
            output,
            task,
            root,
        } = self;
        drop(input);
        drop(output);
        tokio::time::timeout(std::time::Duration::from_secs(10), task).await???;
        let log = std::fs::read_to_string(root.path().join("methods.jsonl"))?;
        assert!(!log.contains("PRIVATE_FROZEN_PROMPT"));
        let rows = log
            .lines()
            .map(serde_json::from_str)
            .collect::<std::result::Result<Vec<Value>, _>>()?;
        for row in &rows {
            let pid = row["pid"].as_u64().unwrap();
            assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
        }
        Ok(rows)
    }
}

fn original() -> Value {
    let prompt = "PRIVATE_FROZEN_PROMPT";
    json!({"version":1,"operationId":"original-operation","requestId":"original-bind","endpointRevision":"1","endpointInstanceId":"held-endpoint","sourceAcceptedSha256":"a".repeat(64),
        "message":{"method":"bind_original","params":{"sourceScope":{"accountId":"source","targetId":"target","workspaceId":null,"identityGeneration":"1","targetRevision":"1"},"sourceAttempt":{"threadId":"source-thread","turnId":"source-turn","attemptId":"source-attempt"},"frozenInputSha256":format!("{:x}",Sha256::digest(prompt.as_bytes())),"deadlineUtcMs":9_000_000_000_000u64,"prompt":prompt,"allowedOutputFormats":[]}}})
}

#[tokio::test]
async fn bind_reuses_exact_unthreaded_upstream_and_never_falls_back_to_an_ordinary_prompt()
-> Result<()> {
    let mut client = Client::start(false).await?;
    let binding = original();
    for id in [1, 2] {
        let reply = client
            .call(json!(id), NATIVE_REMOTE_CONTROL_METHOD, binding.clone())
            .await?;
        assert_eq!(reply["result"]["data"]["kind"], "original_bound");
    }
    let mut different = binding.clone();
    different["requestId"] = json!("new-identity");
    assert!(
        client
            .call(json!(3), NATIVE_REMOTE_CONTROL_METHOD, different)
            .await?["error"]
            .is_object()
    );
    assert!(
        client
            .call(json!(4), "session/new", json!({"cwd":"/","mcpServers":[]}))
            .await?["error"]
            .is_object()
    );
    assert!(client.call(json!(5),"session/new",json!({"cwd":std::env::current_dir()?,"mcpServers":[{"name":"must-not-start","command":"/bin/false","args":[],"env":[]}]})).await?["error"].is_object());
    let reply = client
        .call(
            json!(6),
            "session/new",
            json!({"cwd":std::env::current_dir()?.canonicalize()?,"mcpServers":[]}),
        )
        .await?;
    let session = reply["result"]["sessionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("native session receipt missing"))?
        .to_owned();
    let mut observe = binding.clone();
    observe["requestId"] = json!("source-observe");
    observe["message"] = json!({"method":"observe_original"});
    assert_eq!(
        client
            .call(
                json!("observe"),
                NATIVE_REMOTE_CONTROL_METHOD,
                observe.clone()
            )
            .await?["result"]["state"],
        "unavailable"
    );
    observe["endpointInstanceId"] = json!("wrong-endpoint");
    assert!(
        client
            .call(
                json!("wrong-observe"),
                NATIVE_REMOTE_CONTROL_METHOD,
                observe
            )
            .await?["error"]
            .is_object()
    );
    assert!(
        client
            .call(
                json!(7),
                "session/new",
                json!({"cwd":std::env::current_dir()?,"mcpServers":[]})
            )
            .await?["error"]
            .is_object()
    );
    let wrong = client
        .call(
            json!(8),
            "session/prompt",
            json!({"sessionId":session,"prompt":[{"type":"text","text":"different prompt"}]}),
        )
        .await?;
    assert!(wrong["error"].is_object());
    let blocked = client
        .call(
            json!(9),
            "session/prompt",
            json!({"sessionId":session,"prompt":[{"type":"text","text":"PRIVATE_FROZEN_PROMPT"}]}),
        )
        .await?;
    assert_eq!(
        blocked["error"]["message"],
        "REMOTE_RECEIVER_EXECUTION_UNAVAILABLE"
    );
    let rows = client.close().await?;
    let count = |kind: &str| rows.iter().filter(|row| row["kind"] == kind).count();
    assert_eq!(count("initialize"), 1);
    assert_eq!(count("thread/start"), 1);
    assert_eq!(count("turn/start"), 1);
    assert!(rows.iter().all(|row| row["pid"] == rows[0]["pid"]));
    Ok(())
}

#[tokio::test]
async fn failed_native_binding_never_creates_an_ordinary_session_or_restarts_its_upstream()
-> Result<()> {
    let mut client = Client::start_mode("bind-denied").await?;
    for id in [1, 2] {
        assert!(
            client
                .call(json!(id), NATIVE_REMOTE_CONTROL_METHOD, original())
                .await?["error"]
                .is_object()
        );
    }
    assert!(
        client
            .call(
                json!(3),
                "session/new",
                json!({"cwd":std::env::current_dir()?,"mcpServers":[]})
            )
            .await?["error"]
            .is_object()
    );
    let rows = client.close().await?;
    assert_eq!(
        rows.iter()
            .filter(|row| row["kind"] == "initialize")
            .count(),
        1
    );
    assert!(
        rows.iter()
            .all(|row| row["kind"] != "thread/start" && row["kind"] != "turn/start")
    );
    assert!(rows.iter().all(|row| row["pid"] == rows[0]["pid"]));
    Ok(())
}

#[tokio::test]
async fn eof_closes_a_successful_provisional_native_backend_before_any_thread_exists() -> Result<()>
{
    let mut client = Client::start(false).await?;
    assert_eq!(
        client
            .call(json!(1), NATIVE_REMOTE_CONTROL_METHOD, original())
            .await?["result"]["data"]["kind"],
        "original_bound"
    );
    let rows = client.close().await?;
    assert_eq!(
        rows.iter()
            .filter(|row| row["kind"] == "initialize")
            .count(),
        1
    );
    assert!(
        rows.iter()
            .all(|row| row["kind"] != "thread/start" && row["kind"] != "turn/start")
    );
    Ok(())
}

#[tokio::test]
async fn reverse_native_control_is_driven_before_turn_start_receipt_and_permissions_cannot_grant_it()
-> Result<()> {
    for permission_outcome in [false, true] {
        let mut client = Client::start(true).await?;
        assert_eq!(
            client
                .call(json!(1), NATIVE_REMOTE_CONTROL_METHOD, original())
                .await?["result"]["state"],
            "received"
        );
        let created = client
            .call(
                json!(2),
                "session/new",
                json!({"cwd":std::env::current_dir()?.canonicalize()?,"mcpServers":[]}),
            )
            .await?;
        let session = created["result"]["sessionId"].clone();
        client.send(json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":"PRIVATE_FROZEN_PROMPT"}]}})).await?;
        let callback = client.next().await?;
        assert_eq!(callback["method"], NATIVE_REMOTE_CONTROL_METHOD);
        assert!(
            callback["id"]
                .as_str()
                .unwrap()
                .starts_with("native-control-")
        );
        let params = &callback["params"];
        let reply = if permission_outcome {
            json!({"outcome":{"outcome":"selected","optionId":"allow_once"}})
        } else {
            json!({"version":params["version"],"operationId":params["operationId"],"requestId":params["requestId"],"endpointRevision":params["endpointRevision"],"endpointInstanceId":params["endpointInstanceId"],"state":"received","data":{"kind":"receiver","accepted":params["message"]["params"],"outcome":null,"cleanupConfirmed":false}})
        };
        client
            .send(json!({"jsonrpc":"2.0","id":callback["id"],"result":reply}))
            .await?;
        let failed = client.next().await?;
        assert_eq!(failed["id"], 3);
        assert_eq!(
            failed["error"]["message"],
            "REMOTE_RECEIVER_EXECUTION_UNAVAILABLE"
        );
        let rows = client.close().await?;
        let state = &rows
            .iter()
            .find(|row| row["kind"] == "native_control_settled")
            .unwrap()["state"];
        assert_eq!(
            state,
            if permission_outcome {
                "outcome_unknown"
            } else {
                "received"
            }
        );
    }
    Ok(())
}

#[tokio::test]
async fn original_close_waits_for_the_same_busy_backend_and_does_not_promote_fixture_exit_to_tree_credit()
-> Result<()> {
    let mut client = Client::start_mode("delayed-close").await?;
    let binding = original();
    client
        .call(json!(1), NATIVE_REMOTE_CONTROL_METHOD, binding.clone())
        .await?;
    let created = client
        .call(
            json!(2),
            "session/new",
            json!({"cwd":std::env::current_dir()?.canonicalize()?,"mcpServers":[]}),
        )
        .await?;
    client.send(json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":created["result"]["sessionId"],
        "prompt":[{"type":"text","text":"PRIVATE_FROZEN_PROMPT"}]}})).await?;
    let callback = client.next().await?;
    let params = &callback["params"];
    let facts = params["message"]["params"].clone();
    client.send(json!({"jsonrpc":"2.0","id":callback["id"],"result":{"version":params["version"],"operationId":params["operationId"],
        "requestId":params["requestId"],"endpointRevision":params["endpointRevision"],"endpointInstanceId":params["endpointInstanceId"],
        "state":"received","data":{"kind":"receiver","accepted":facts,"outcome":null,"cleanupConfirmed":false}}})).await?;
    let mut close = binding;
    close["requestId"] = json!("original-close");
    close["message"] = json!({"method":"close_original","params":facts});
    client
        .send(json!({"jsonrpc":"2.0","id":4,"method":NATIVE_REMOTE_CONTROL_METHOD,"params":close}))
        .await?;
    assert!(
        tokio::time::timeout(Duration::from_millis(50), client.next())
            .await
            .is_err(),
        "A busy original backend must retain the close request instead of returning BUSY"
    );
    let mut another = original();
    another["requestId"] = json!("another-close");
    another["message"] = json!({"method":"close_original","params":facts});
    let rejected = client
        .call(json!(5), NATIVE_REMOTE_CONTROL_METHOD, another)
        .await?;
    assert_eq!(
        rejected["error"]["message"],
        "REMOTE_OWNER_CLOSE_RECONCILE_ORIGINAL"
    );
    std::fs::write(
        client.root.path().join("methods.jsonl.release"),
        b"release original prompt",
    )?;
    let first = client.next().await?;
    let second = client.next().await?;
    let closed = if first["id"] == 4 { first } else { second };
    assert_eq!(closed["id"], 4);
    assert_eq!(closed["result"]["data"]["kind"], "owner_closed");
    assert_eq!(closed["result"]["data"]["accepted"], facts);
    assert_eq!(closed["result"]["data"]["outcome"], "interrupted");
    assert_eq!(
        closed["result"]["data"]["ownerTreeCleanupConfirmed"], false,
        "An ordinary protocol fixture cannot prove Native supervisor tree cleanup"
    );
    let rows = client.close().await?;
    for method in ["initialize", "thread/start", "turn/start"] {
        assert_eq!(rows.iter().filter(|row| row["kind"] == method).count(), 1);
    }
    assert!(rows.iter().all(|row| row["pid"] == rows[0]["pid"]));
    Ok(())
}
