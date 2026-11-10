//! Bounded JSONL private RPC. Responses bypass request concurrency to avoid reentrant deadlocks.
use crate::protocol_io::{JsonRpcLine, JsonRpcLineState, MAX_JSONRPC_LINE_BYTES};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncWrite, AsyncWriteExt},
    sync::{Mutex, Notify, Semaphore, mpsc, oneshot},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait ReverseRequest: Send + Sync {
    async fn handle(&self, method: &str, params: Value) -> Result<Value>;
}
pub struct WriteFrame {
    bytes: Vec<u8>,
    _budget: tokio::sync::OwnedSemaphorePermit,
}
#[derive(Clone, Copy)]
enum Lane {
    General,
    Control,
}
pub struct HostRpc {
    output: mpsc::Sender<WriteFrame>,
    budget: Arc<Semaphore>,
    pending: Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>,
    reader_started: std::sync::atomic::AtomicBool,
    reader_finished: std::sync::atomic::AtomicBool,
    reader_drained: Notify,
    pub cancel: CancellationToken,
    pub ready: Notify,
    pub operational: std::sync::atomic::AtomicBool,
}
impl HostRpc {
    pub fn new() -> (Arc<Self>, mpsc::Receiver<WriteFrame>) {
        let (tx, rx) = mpsc::channel(64);
        (
            Arc::new(Self {
                output: tx,
                budget: Arc::new(Semaphore::new(8 * 1024 * 1024)),
                pending: Mutex::new(HashMap::new()),
                reader_started: std::sync::atomic::AtomicBool::new(false),
                reader_finished: std::sync::atomic::AtomicBool::new(false),
                reader_drained: Notify::new(),
                cancel: CancellationToken::new(),
                ready: Notify::new(),
                operational: std::sync::atomic::AtomicBool::new(false),
            }),
            rx,
        )
    }
    pub async fn wait_reader_drained(&self) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let notified = self.reader_drained.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self
                    .reader_finished
                    .load(std::sync::atomic::Ordering::Acquire)
                {
                    break;
                }
                notified.await;
            }
        })
        .await
        .context("CONNECTIVITY_OWNED_JOBS_CLEANUP_UNCONFIRMED")?;
        Ok(())
    }
    fn frame(&self, value: Value) -> Result<WriteFrame> {
        let mut bytes = serde_json::to_vec(&value)?;
        bytes.push(b'\n');
        ensure!(
            bytes.len() <= MAX_JSONRPC_LINE_BYTES,
            "CONNECTIVITY_RPC_FRAME_TOO_LARGE"
        );
        let permit = self
            .budget
            .clone()
            .try_acquire_many_owned(bytes.len() as u32)
            .context("CONNECTIVITY_RPC_WRITE_CAPACITY")?;
        Ok(WriteFrame {
            bytes,
            _budget: permit,
        })
    }
    async fn send(&self, value: Value) -> Result<()> {
        let frame = self.frame(value)?;
        tokio::select! {_ = self.cancel.cancelled()=>anyhow::bail!("CONNECTIVITY_RPC_CLOSED"), result=self.output.send(frame)=>result.context("CONNECTIVITY_RPC_CLOSED")}
    }
    fn try_send(&self, value: Value) -> Result<()> {
        self.output
            .try_send(self.frame(value)?)
            .map_err(|_| anyhow::anyhow!("CONNECTIVITY_RPC_WRITE_CAPACITY"))
    }
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        caller_cancel: Option<&CancellationToken>,
    ) -> Result<Value> {
        ensure!(!self.cancel.is_cancelled(), "CONNECTIVITY_RPC_CLOSED");
        ensure!(
            !caller_cancel.is_some_and(CancellationToken::is_cancelled),
            "CONNECTIVITY_RPC_OUTCOME_UNCONFIRMED"
        );
        let id = format!("native-connectivity:{}", uuid::Uuid::new_v4());
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            ensure!(pending.len() < 128, "CONNECTIVITY_RPC_PENDING_CAPACITY");
            pending.insert(id.clone(), tx);
        }
        let caller = caller_cancel.cloned().unwrap_or_default();
        let deadline = tokio::time::Instant::now() + timeout;
        let queued = tokio::select! {
            result=self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))=>result,
            _=caller.cancelled()=>Err(anyhow::anyhow!("CONNECTIVITY_RPC_OUTCOME_UNCONFIRMED")),
            _=tokio::time::sleep_until(deadline)=>Err(anyhow::anyhow!("CONNECTIVITY_RPC_OUTCOME_UNCONFIRMED")),
        };
        if let Err(error) = queued {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        let result = tokio::select! {
            _=self.cancel.cancelled()=>Err(anyhow::anyhow!("CONNECTIVITY_RPC_OUTCOME_UNCONFIRMED")),
            _=caller.cancelled()=>Err(anyhow::anyhow!("CONNECTIVITY_RPC_OUTCOME_UNCONFIRMED")),
            value=tokio::time::timeout_at(deadline,rx)=>match value{Ok(Ok(Ok(value)))=>Ok(value),Ok(Ok(Err(code)))=>Err(anyhow::anyhow!(code)),_=>Err(anyhow::anyhow!("CONNECTIVITY_RPC_OUTCOME_UNCONFIRMED"))},
        };
        self.pending.lock().await.remove(&id);
        result
    }
    async fn response(&self, frame: &Value) -> Result<bool> {
        let Some(id) = frame.get("id").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(sender) = self.pending.lock().await.remove(id) else {
            return Ok(false);
        };
        let valid = frame.as_object().is_some_and(|map| {
            map.keys()
                .all(|key| ["jsonrpc", "id", "result", "error"].contains(&key.as_str()))
        }) && frame["jsonrpc"] == "2.0"
            && frame.get("result").is_some() != frame.get("error").is_some();
        let outcome = if !valid {
            Err("CONNECTIVITY_RPC_RESPONSE_INVALID".into())
        } else if let Some(error) = frame.get("error") {
            if !error.get("code").is_some_and(Value::is_i64)
                || !error.get("message").is_some_and(Value::is_string)
            {
                Err("CONNECTIVITY_RPC_RESPONSE_INVALID".into())
            } else {
                let text = error["message"].as_str().unwrap();
                Err(if safe_code(text) {
                    text.into()
                } else {
                    "CONNECTIVITY_NATIVE_OPERATION_FAILED".into()
                })
            }
        } else {
            Ok(frame["result"].clone())
        };
        let _ = sender.send(outcome);
        Ok(true)
    }
    pub async fn run_reader<T: AsyncBufRead + Unpin + Send>(
        self: Arc<Self>,
        mut reader: T,
        handler: Arc<dyn ReverseRequest>,
    ) -> Result<()> {
        self.drive_reader(&mut reader, handler).await
    }

    async fn drive_reader(
        self: Arc<Self>,
        reader: &mut (dyn AsyncBufRead + Unpin + Send),
        handler: Arc<dyn ReverseRequest>,
    ) -> Result<()> {
        let mut lines = JsonRpcLineState::default();
        let mut general = VecDeque::new();
        let mut control = VecDeque::new();
        let mut jobs = JoinSet::new();
        ensure!(
            !self
                .reader_started
                .swap(true, std::sync::atomic::Ordering::AcqRel),
            "CONNECTIVITY_READER_ALREADY_STARTED"
        );
        let (mut active, mut active_control) = (0usize, 0usize);
        let result:Result<()>=async{
            loop{
                while active_control<2&&!control.is_empty(){let frame=control.pop_front().unwrap();spawn_request(&mut jobs,self.clone(),handler.clone(),frame,true);active_control+=1;}
                while active<4&&!general.is_empty(){let frame=general.pop_front().unwrap();spawn_request(&mut jobs,self.clone(),handler.clone(),frame,false);active+=1;}
                tokio::select!{
                    _=self.cancel.cancelled()=>break,
                    Some(done)=jobs.join_next(),if !jobs.is_empty()=>{match done.context("CONNECTIVITY_REVERSE_HANDLER_FAILED")? {Lane::Control=>active_control-=1,Lane::General=>active-=1}},
                    line=lines.read(reader)=>{
                        let Some(line)=line?else{break};let JsonRpcLine::Line(line)=line else{continue};let Ok(frame)=serde_json::from_str::<Value>(&line)else{continue};
                        if self.response(&frame).await?{continue;}
                        let Some(method)=frame.get("method").and_then(Value::as_str)else{continue};
                        let valid_id=frame.get("id").is_some_and(|id|id.as_str().is_some_and(|id|!id.is_empty()&&id.len()<=256)||id.is_i64());
                        if frame["jsonrpc"]!="2.0"||!valid_id||!frame.as_object().is_some_and(|map|map.keys().all(|key|["jsonrpc","id","method","params"].contains(&key.as_str()))){continue;}
                        let controlled=is_control(method);let queue=if controlled{&mut control}else{&mut general};let maximum=if controlled{8}else{32};
                        if queue.len()>=maximum{self.try_send(json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32003,"message":"CONNECTIVITY_REVERSE_CAPACITY"}}))?;}else{queue.push_back(frame);}
                    },
                }
            }Ok(())
        }.await;
        self.cancel.cancel();
        let pending = std::mem::take(&mut *self.pending.lock().await);
        for (_, sender) in pending {
            let _ = sender.send(Err("CONNECTIVITY_RPC_OUTCOME_UNCONFIRMED".into()));
        }
        jobs.abort_all();
        while jobs.join_next().await.is_some() {}
        self.reader_finished
            .store(true, std::sync::atomic::Ordering::Release);
        self.reader_drained.notify_waiters();
        result
    }
    pub async fn run_writer<T: AsyncWrite + Unpin + Send>(
        self: Arc<Self>,
        mut writer: T,
        output: mpsc::Receiver<WriteFrame>,
    ) -> Result<()> {
        self.drive_writer(&mut writer, output).await
    }

    async fn drive_writer(
        self: Arc<Self>,
        writer: &mut (dyn AsyncWrite + Unpin + Send),
        mut output: mpsc::Receiver<WriteFrame>,
    ) -> Result<()> {
        let result:Result<()>=async{loop{let frame=tokio::select!{_ = self.cancel.cancelled()=>break, frame=output.recv()=>match frame{Some(frame)=>frame,None=>break}};
            tokio::select! {
                _ = self.cancel.cancelled() => break,
                result = tokio::time::timeout(Duration::from_secs(10),async{writer.write_all(&frame.bytes).await?;writer.flush().await}) => { result.context("CONNECTIVITY_RPC_WRITE_TIMEOUT")??; }
            }
        }Ok(())}.await;
        self.cancel.cancel();
        let _ = tokio::time::timeout(Duration::from_millis(250), writer.shutdown()).await;
        result
    }
}
fn is_control(method: &str) -> bool {
    [
        "private.store.acquireLease",
        "private.store.renewLease",
        "private.store.commitReady",
        "private.store.verify",
        "private.store.prepareSidecars",
        "private.store.releaseLease",
        "private.host.ready",
    ]
    .contains(&method)
}
fn safe_code(code: &str) -> bool {
    (2..=80).contains(&code.len())
        && code
            .bytes()
            .all(|value| value.is_ascii_uppercase() || value.is_ascii_digit() || value == b'_')
}
fn spawn_request(
    jobs: &mut JoinSet<Lane>,
    rpc: Arc<HostRpc>,
    handler: Arc<dyn ReverseRequest>,
    frame: Value,
    control: bool,
) {
    jobs.spawn(async move {
        let method = frame["method"].as_str().unwrap();
        let result = handler
            .handle(method, frame.get("params").cloned().unwrap_or(Value::Null))
            .await;
        let response = match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":frame["id"],"result":value}),
            Err(error) => {
                let text = error.to_string();
                let code = if safe_code(&text) {
                    text.as_str()
                } else {
                    "CONNECTIVITY_NATIVE_OPERATION_FAILED"
                };
                json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32000,"message":code}})
            }
        };
        if rpc.send(response).await.is_err() {
            rpc.cancel.cancel();
        }
        if control {
            Lane::Control
        } else {
            Lane::General
        }
    });
}

#[cfg(test)]
#[path = "host_rpc/tests.rs"]
mod tests;
