use super::*;
use tokio::io::{AsyncWriteExt, BufReader};

#[tokio::test]
async fn one_private_pipe_cannot_start_a_second_reader() -> Result<()> {
    let (rpc, _output) = HostRpc::new();
    let (_remote, input) = tokio::io::duplex(64);
    let first = tokio::spawn(
        rpc.clone()
            .run_reader(BufReader::new(input), Arc::new(Echo)),
    );
    tokio::time::timeout(Duration::from_secs(2), async {
        while !rpc
            .reader_started
            .load(std::sync::atomic::Ordering::Acquire)
        {
            tokio::task::yield_now().await;
        }
    })
    .await?;
    let error = rpc
        .clone()
        .run_reader(&b""[..], Arc::new(Echo))
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "CONNECTIVITY_READER_ALREADY_STARTED");
    assert!(!rpc.cancel.is_cancelled());
    rpc.cancel.cancel();
    first.await??;
    rpc.wait_reader_drained().await?;
    assert!(rpc.run_reader(&b""[..], Arc::new(Echo)).await.is_err());
    Ok(())
}
struct Echo;
#[async_trait]
impl ReverseRequest for Echo {
    async fn handle(&self, _: &str, params: Value) -> Result<Value> {
        Ok(params)
    }
}

#[tokio::test]
async fn malformed_matching_response_is_unknown_not_success() -> Result<()> {
    let (rpc, mut output) = HostRpc::new();
    let call = tokio::spawn({
        let rpc = rpc.clone();
        async move {
            rpc.call("owned", json!({}), Duration::from_secs(1), None)
                .await
        }
    });
    let request: Value = serde_json::from_slice(&output.recv().await.unwrap().bytes)?;
    rpc.response(&json!({"jsonrpc":"2.0","id":request["id"],"result":true,"error":{"code":1,"message":"BAD"}})).await?;
    assert!(call.await?.is_err());
    assert!(rpc.pending.lock().await.is_empty());
    Ok(())
}
#[tokio::test]
async fn oversized_and_invalid_utf8_frames_resync_before_next_real_request() -> Result<()> {
    let (rpc, mut output) = HostRpc::new();
    let (mut remote, input) = tokio::io::duplex(65536);
    let reader = tokio::spawn(
        rpc.clone()
            .run_reader(BufReader::new(input), Arc::new(Echo)),
    );
    remote
        .write_all(&vec![b'x'; MAX_JSONRPC_LINE_BYTES + 100])
        .await?;
    remote.write_all(&[b'\n', 255, b'\n']).await?;
    remote.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"good\",\"method\":\"read\",\"params\":{\"original\":true}}\n").await?;
    let reply: Value = serde_json::from_slice(
        &tokio::time::timeout(Duration::from_secs(1), output.recv())
            .await?
            .unwrap()
            .bytes,
    )?;
    assert_eq!(reply["result"]["original"], true);
    rpc.cancel.cancel();
    reader.await??;
    Ok(())
}
struct Reentrant {
    rpc: Arc<HostRpc>,
}
#[async_trait]
impl ReverseRequest for Reentrant {
    async fn handle(&self, _: &str, _: Value) -> Result<Value> {
        self.rpc
            .call(
                "connectivity.resolveIngress",
                json!({}),
                Duration::from_secs(1),
                None,
            )
            .await
    }
}
#[tokio::test]
async fn responses_bypass_four_handlers_waiting_on_actual_reverse_rpc() -> Result<()> {
    let (rpc, mut output) = HostRpc::new();
    let (mut remote, input) = tokio::io::duplex(65536);
    let reader = tokio::spawn(rpc.clone().run_reader(
        BufReader::new(input),
        Arc::new(Reentrant { rpc: rpc.clone() }),
    ));
    for index in 0..4 {
        remote.write_all(format!("{{\"jsonrpc\":\"2.0\",\"id\":\"call-{index}\",\"method\":\"private.integration.call\",\"params\":{{}}}}\n").as_bytes()).await?;
    }
    let mut results = 0;
    while results < 4 {
        let frame: Value = serde_json::from_slice(
            &tokio::time::timeout(Duration::from_secs(2), output.recv())
                .await?
                .unwrap()
                .bytes,
        )?;
        if frame.get("method").is_some() {
            remote
                .write_all(
                    format!(
                        "{}\n",
                        json!({"jsonrpc":"2.0","id":frame["id"],"result":{"original":true}})
                    )
                    .as_bytes(),
                )
                .await?;
        } else {
            assert_eq!(frame["result"]["original"], true);
            results += 1;
        }
    }
    rpc.cancel.cancel();
    reader.await??;
    Ok(())
}
#[tokio::test]
async fn write_queue_is_bounded_and_pre_cancelled_call_does_not_enter_it() -> Result<()> {
    let (rpc, _output) = HostRpc::new();
    let caller = CancellationToken::new();
    caller.cancel();
    assert!(
        rpc.call("owned", json!({}), Duration::from_secs(1), Some(&caller))
            .await
            .is_err()
    );
    assert_eq!(rpc.budget.available_permits(), 8 * 1024 * 1024);
    let mut accepted = 0;
    while rpc
        .try_send(json!({"jsonrpc":"2.0","id":accepted,"result":"bounded"}))
        .is_ok()
    {
        accepted += 1;
    }
    assert_eq!(accepted, 64);
    assert!(rpc.budget.available_permits() <= 8 * 1024 * 1024);
    rpc.cancel.cancel();
    Ok(())
}

#[tokio::test]
async fn cancellation_interrupts_a_slow_private_pipe_writer() -> Result<()> {
    let (rpc, output) = HostRpc::new();
    let (writer, _not_reading) = tokio::io::duplex(8);
    rpc.try_send(json!({"jsonrpc":"2.0","id":"slow","result":"x".repeat(65536)}))?;
    let task = tokio::spawn(rpc.clone().run_writer(writer, output));
    tokio::time::sleep(Duration::from_millis(10)).await;
    rpc.cancel.cancel();
    tokio::time::timeout(Duration::from_secs(1), task).await???;
    assert_eq!(rpc.budget.available_permits(), 8 * 1024 * 1024);
    Ok(())
}

#[tokio::test]
async fn eof_settles_only_original_pending_calls_as_unconfirmed() -> Result<()> {
    let (rpc, mut output) = HostRpc::new();
    let call = tokio::spawn({
        let rpc = rpc.clone();
        async move {
            rpc.call("owned", json!({}), Duration::from_secs(10), None)
                .await
        }
    });
    let _original = output.recv().await.context("original request missing")?;
    rpc.clone()
        .run_reader(BufReader::new(tokio::io::empty()), Arc::new(Echo))
        .await?;
    assert!(call.await?.is_err());
    assert!(rpc.pending.lock().await.is_empty());
    assert!(rpc.cancel.is_cancelled());
    Ok(())
}
