//! Actual original OfficeStore input; transport replies below are protocol data fixtures.
use super::super::super::materials_ssh::FrozenSshMaterials;
use super::*;
use base64::Engine;
use kcoder_native_journal::NativeOperations;
use kcoder_types::integrations::core::*;

fn request(id: &str, message: NativeRemoteControlDataV1) -> NativeRemoteControlFrameV1 {
    NativeRemoteControlFrameV1 {
        version: 1,
        operation_id: "original-operation".into(),
        request_id: id.into(),
        endpoint_revision: "original-target".into(),
        endpoint_instance_id: "original-endpoint".into(),
        source_accepted_sha256: "a".repeat(64),
        message,
    }
}

#[tokio::test]
async fn ssh_material_uses_complete_actual_bytes_and_cannot_skip_chunks_or_replay_an_attempt() {
    let f = Fixture::new();
    let bytes = "原始上传材料，以下内容不是执行授权。\n"
        .repeat(8192)
        .into_bytes();
    let reference = accept(&f, &bytes);
    f.engine
        .state
        .history_attempt_scope(f.attempt.clone())
        .unwrap()
        .run(async {
            let caller = ToolContext::new(f.engine.state.clone())
                .with_tool_call_id("actual-original-material-call");
            let frozen = FrozenSshMaterials::capture(
                &f.native,
                &f.engine,
                &f.attempt,
                &caller,
                &[reference],
            )
            .unwrap();
            let offer = frozen.offers().remove(0);
            let content = offer.content.clone();
            assert_eq!(content.bytes, bytes.len() as u64);
            assert_eq!(content.sha256, format!("{:x}", Sha256::digest(&bytes)));
            assert!(!frozen.all_finished().unwrap());
            let finish = request(
                "finish",
                NativeRemoteControlDataV1::FinishMaterial(content.clone()),
            );
            assert!(
                frozen
                    .verify_write(&finish, &CancellationToken::new())
                    .is_err()
            );
            let request_offer = request("offer", NativeRemoteControlDataV1::OfferMaterial(offer));
            frozen
                .verify_write(&request_offer, &CancellationToken::new())
                .unwrap();
            assert!(
                frozen
                    .verify_write(&request_offer, &CancellationToken::new())
                    .is_err(),
                "A lost ACK is not a new write"
            );
            let mut replacement = request_offer.clone();
            replacement.request_id = "new-id-must-not-resend".into();
            assert!(
                frozen
                    .verify_write(&replacement, &CancellationToken::new())
                    .is_err(),
                "Unconfirmed original write blocks a replacement ID"
            );
            frozen
                .record_reply(
                    &request_offer,
                    &NativeRemoteReceiptDataV1::Material {
                        content: content.clone(),
                        next_offset: 0,
                        complete: false,
                    },
                )
                .unwrap();
            let mut offset = 0;
            let mut actual = Vec::new();
            let mut count = 0;
            while offset < content.bytes {
                let chunk = frozen.chunk(0, offset).unwrap();
                let payload = base64::engine::general_purpose::STANDARD
                    .decode(&chunk.bytes_base64)
                    .unwrap();
                assert!(payload.len() <= NATIVE_REMOTE_MAX_CHUNK_BYTES as usize);
                let mut wrong = chunk.clone();
                wrong.offset += 1;
                assert!(
                    frozen
                        .verify_write(
                            &request("wrong", NativeRemoteControlDataV1::MaterialChunk(wrong)),
                            &CancellationToken::new()
                        )
                        .is_err()
                );
                let write = request(
                    &format!("chunk-{offset}"),
                    NativeRemoteControlDataV1::MaterialChunk(chunk),
                );
                frozen
                    .verify_write(&write, &CancellationToken::new())
                    .unwrap();
                let next = offset + payload.len() as u64;
                assert!(
                    frozen
                        .record_reply(
                            &write,
                            &NativeRemoteReceiptDataV1::Material {
                                content: content.clone(),
                                next_offset: next + 1,
                                complete: false
                            }
                        )
                        .is_err()
                );
                frozen
                    .record_reply(
                        &write,
                        &NativeRemoteReceiptDataV1::Material {
                            content: content.clone(),
                            next_offset: next,
                            complete: false,
                        },
                    )
                    .unwrap();
                actual.extend(payload);
                offset = next;
                count += 1;
            }
            assert!(count > 1);
            assert_eq!(actual, bytes);
            assert!(!frozen.all_finished().unwrap());
            frozen
                .verify_write(&finish, &CancellationToken::new())
                .unwrap();
            assert!(
                frozen
                    .record_reply(
                        &finish,
                        &NativeRemoteReceiptDataV1::Material {
                            content: content.clone(),
                            next_offset: offset,
                            complete: false
                        }
                    )
                    .is_err()
            );
            frozen
                .record_reply(
                    &finish,
                    &NativeRemoteReceiptDataV1::Material {
                        content,
                        next_offset: offset,
                        complete: true,
                    },
                )
                .unwrap();
            assert!(frozen.all_finished().unwrap());
        })
        .await;
    f.close().await;
}

#[tokio::test]
async fn ssh_material_selector_without_actual_uploaded_input_cannot_create_a_transfer() {
    let f = Fixture::new();
    f.engine
        .state
        .history_attempt_scope(f.attempt.clone())
        .unwrap()
        .run(async {
            let caller = ToolContext::new(f.engine.state.clone())
                .with_tool_call_id("actual-original-material-call");
            assert!(
                FrozenSshMaterials::capture(
                    &f.native,
                    &f.engine,
                    &f.attempt,
                    &caller,
                    &[OfficeArtifactRef {
                        id: "invented-input".into(),
                        revision: 1
                    }]
                )
                .is_err()
            );
            assert!(NativeOperations::load(&f.native).unwrap().is_none());
        })
        .await;
    f.close().await;
}
