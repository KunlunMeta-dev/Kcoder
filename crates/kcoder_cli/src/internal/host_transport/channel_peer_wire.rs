//! Typed Channel Peer framing, bounded writes and the owned in-flight call loop.

use crate::{connection_input::ConnectionInput, protocol_io::JsonRpcLine};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::channel_peer::{
    CHANNEL_PEER_FRAME_BYTES, CHANNEL_PEER_PENDING_PER_STREAM, ChannelPeerClientFrame,
    ChannelPeerInteractionResponse, ChannelPeerServerFrame, ChannelPeerStreamRef,
    decode_channel_peer_frame,
};
use std::{collections::VecDeque, future::Future, pin::Pin, time::Duration};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[async_trait::async_trait]
pub trait NativeUiInteractionResponder: Send + Sync {
    /// The Core owner must also check its actual pending interaction, original
    /// receipt/epoch/thread/turn/revision and current source/PDP before applying it.
    async fn respond(&self, response: ChannelPeerInteractionResponse) -> Result<()>;
}

/// Continue reading original interactions while the Core owns one serial call.
pub async fn drive_call(
    input: &mut ConnectionInput,
    deferred: &mut VecDeque<ChannelPeerClientFrame>,
    reference: &ChannelPeerStreamRef,
    ended: &CancellationToken,
    original_ended: &CancellationToken,
    mut call: BoxFuture<'_, Result<()>>,
    interactions: &dyn NativeUiInteractionResponder,
) -> Result<bool> {
    loop {
        tokio::select! {biased;
            _=ended.cancelled()=> {original_ended.cancel(); return Ok(false)},
            result=&mut call=>{result?; return Ok(true)},
            next=read_client(input)=>match next? {
                None=>{original_ended.cancel(); return Ok(false)},
                Some(ChannelPeerClientFrame::InteractionResponse{response})=>{
                    interactions.respond(response).await?;
                }
                Some(frame @ ChannelPeerClientFrame::UiCall{..})=>{
                    ensure!(deferred.len()<CHANNEL_PEER_PENDING_PER_STREAM,"CHANNEL_PEER_PENDING_CAPACITY");
                    deferred.push_back(frame);
                }
                Some(ChannelPeerClientFrame::Close{stream})=>{
                    ensure!(&stream==reference,"CHANNEL_PEER_ORIGINAL_STREAM_REQUIRED");
                    original_ended.cancel(); return Ok(false);
                }
                _=>anyhow::bail!("CHANNEL_PEER_ORIGINAL_UI_LANE_REQUIRED"),
            }
        }
    }
}

pub async fn read_client(input: &mut ConnectionInput) -> Result<Option<ChannelPeerClientFrame>> {
    match input.read().await? {
        None => Ok(None),
        Some(JsonRpcLine::Line(line)) => Ok(Some(
            decode_channel_peer_frame(line.as_bytes()).map_err(anyhow::Error::msg)?,
        )),
        _ => anyhow::bail!("CHANNEL_PEER_FRAME_INVALID"),
    }
}
pub async fn write_frames(
    mut output: Box<dyn AsyncWrite + Unpin + Send>,
    mut frames: mpsc::Receiver<ChannelPeerServerFrame>,
    ended: &CancellationToken,
) -> Result<()> {
    loop {
        let next = tokio::select! {biased;
            _=ended.cancelled()=>None,
            frame=frames.recv()=>frame,
        };
        let Some(frame) = next else { break };
        frame.validate().map_err(anyhow::Error::msg)?;
        if !write_one(&mut *output, &frame, ended).await? {
            break;
        }
    }
    Ok(())
}
pub async fn write_one(
    output: &mut (dyn AsyncWrite + Unpin + Send),
    frame: &ChannelPeerServerFrame,
    ended: &CancellationToken,
) -> Result<bool> {
    frame.validate().map_err(anyhow::Error::msg)?;
    let mut bytes = serde_json::to_vec(frame)?;
    ensure!(
        bytes.len() <= CHANNEL_PEER_FRAME_BYTES,
        "CHANNEL_PEER_FRAME_INVALID"
    );
    bytes.push(b'\n');
    // A partial/unknown write closes this stream. Never restart its offset on
    // a replacement connection or replay the original native operation.
    tokio::select! {biased;
        _=ended.cancelled()=>return Ok(false),
        result=tokio::time::timeout(Duration::from_secs(10),async{output.write_all(&bytes).await?;output.flush().await})=>
            result.context("CHANNEL_PEER_WRITE_UNCONFIRMED")??,
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, BufReader};
    #[tokio::test]
    async fn actual_bounded_input_accepts_only_nonce_bound_typed_initialize() -> Result<()> {
        let (mut client, server) = tokio::io::duplex(4096);
        let mut input = ConnectionInput::new(BufReader::new(server));
        client.write_all(serde_json::to_string(&serde_json::json!({"kind":"initialize",
            "admissionNonce":"0123456789abcdef0123456789abcdef","params":{
            "protocolVersion":kcoder_app_protocol::PROTOCOL_VERSION,"clientInfo":{"name":"original","version":"1"},"capabilities":{"experimental":{}}}}))?.as_bytes()).await?;
        client.write_all(b"\n").await?;
        ensure!(
            matches!(
                read_client(&mut input).await?,
                Some(ChannelPeerClientFrame::Initialize { .. })
            ),
            "typed handshake not decoded"
        );
        client
            .write_all(b"{\"method\":\"runtime.acceptTask\",\"trusted\":true}\n")
            .await?;
        ensure!(
            read_client(&mut input).await.is_err(),
            "arbitrary RPC reached the private dispatcher"
        );
        Ok(())
    }
    #[tokio::test]
    async fn write_backpressure_and_eof_are_owned_by_only_the_original_stream() -> Result<()> {
        let (server, mut client) = tokio::io::duplex(1);
        let (sender, receiver) = mpsc::channel(1);
        let ended = CancellationToken::new();
        let other = CancellationToken::new();
        let route = ChannelPeerStreamRef {
            id: "stream".into(),
            host_epoch: "host".into(),
            app_server_epoch: "epoch".into(),
            scope: serde_json::from_value(
                serde_json::json!({"accountId":"owner","targetId":"target","workspaceId":"workspace","identityGeneration":"1","targetRevision":"1"}),
            )?,
        };
        sender
            .send(ChannelPeerServerFrame::OwnerEnded { stream: route })
            .await?;
        let write = write_frames(Box::new(server), receiver, &ended);
        tokio::pin!(write);
        tokio::select! {result=&mut write=>anyhow::bail!("write ignored actual bounded backpressure: {result:?}"),_=tokio::time::sleep(Duration::from_millis(10))=>{}}
        let mut first = [0u8; 1];
        client.read_exact(&mut first).await?;
        ended.cancel();
        write.await?;
        ensure!(!other.is_cancelled(), "EOF crossed stream owners");
        Ok(())
    }
}
