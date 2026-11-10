//! Source accounting only after an actual owned, pinned Native frame producer.
use super::native_frames::NativeRemoteSourceFrames;
use crate::app_server::integrations::core::remote_delegations::source_budget::{
    NativeRemoteSourceBudget, NativeRemoteSourceReservation,
};
use anyhow::{Context, Result, ensure};
use kcoder_acp::outbound::OwnedNativeFrameTransport;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_state::integrations::core::budgets::BudgetCharge;
use kcoder_types::integrations::core::*;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub struct NativeRemoteSourceControl {
    frames: Arc<NativeRemoteSourceFrames>,
    budget: Arc<NativeRemoteSourceBudget>,
    state: Mutex<ControlState>,
}
#[derive(Default)]
struct ControlState {
    receiver_settings: Option<String>,
    receiver: Option<NativeRemoteAcceptedFactsV1>,
    calls: BTreeMap<String, SourceCall>,
    receipts: BTreeMap<String, (String, NativeRemoteControlReplyV1)>,
}
struct SourceCall {
    reservation: NativeRemoteSourceReservation,
    dispatched: bool,
    finished: bool,
}
impl NativeRemoteSourceControl {
    pub fn observed_receiver(&self) -> Result<NativeRemoteAcceptedFactsV1> {
        self.frames.verify_owner()?;
        self.state
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_OWNER_BUSY"))?
            .receiver
            .clone()
            .context("REMOTE_CONTROL_ORIGINAL_RECEIVER_REQUIRED")
    }
    pub fn bind_receiver_settings(&self, sha256: &str) -> Result<()> {
        self.frames.verify_owner()?;
        ensure!(
            sha256.len() == 64 && sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "REMOTE_CONTROL_RECEIVER_SETTINGS_REQUIRED"
        );
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_OWNER_BUSY"))?;
        ensure!(
            state
                .receiver_settings
                .as_deref()
                .is_none_or(|old| old == sha256),
            "REMOTE_CONTROL_RECEIVER_SETTINGS_CHANGED"
        );
        state.receiver_settings = Some(sha256.into());
        Ok(())
    }
    pub fn bind_original(frames: Arc<NativeRemoteSourceFrames>) -> Result<Self> {
        let (budget, _, _, _) = frames.source_control_binding()?;
        Ok(Self {
            frames,
            budget,
            state: Mutex::default(),
        })
    }
    /// Retained accounting is limited to this already dispatched original call.
    /// It never reserves a call or changes an execution admission decision.
    pub fn handle_dispatched_settlement_frame(&self, frame: &Value) -> Result<Value> {
        let request: NativeRemoteControlFrameV1 = rpc_codec::decode(frame["params"].clone())?;
        request.validate_shape().map_err(anyhow::Error::msg)?;
        let call = match &request.message {
            NativeRemoteControlDataV1::ObserveModel(call) => call,
            NativeRemoteControlDataV1::FinishModel(finish) => &finish.call,
            _ => anyhow::bail!("REMOTE_ORIGINAL_DISPATCHED_SETTLEMENT_REQUIRED"),
        };
        {
            let state = self
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_OWNER_BUSY"))?;
            require_receiver(&state, &call.receiver_accepted)?;
            ensure!(
                state
                    .calls
                    .get(&call.native_call_id)
                    .is_some_and(|call| call.dispatched),
                "REMOTE_ORIGINAL_DISPATCHED_SETTLEMENT_REQUIRED"
            );
        }
        self.handle_owned_frame(frame)
    }
    /// This is called from the original OutboundHost's private callback only.
    /// It never upgrades agentInfo/JSON to a local TurnAttemptStore capability.
    pub fn handle_owned_frame(&self, frame: &Value) -> Result<Value> {
        self.frames.verify_owner()?;
        ensure!(
            frame["method"] == NATIVE_REMOTE_CONTROL_METHOD
                && frame["jsonrpc"] == "2.0"
                && frame.get("id").is_some(),
            "REMOTE_CONTROL_PRIVATE_REQUEST_REQUIRED"
        );
        let control: NativeRemoteControlFrameV1 =
            rpc_codec::decode(frame["params"].clone()).context("REMOTE_CONTROL_FRAME_INVALID")?;
        control.validate_shape().map_err(anyhow::Error::msg)?;
        self.frames.verify_received_control(&control)?;
        if matches!(
            control.message,
            NativeRemoteControlDataV1::ReserveModel(_)
                | NativeRemoteControlDataV1::DispatchModel(_)
        ) {
            self.budget.require_owned_transport_policy()?;
        } else {
            self.budget.verify_retained_observation_owner()?;
        }
        let digest = super::super::launch::digest(&control)?;
        // No await happens under this lock. In particular the Receiver's reply
        // pump never needs this Source lock to deliver a budget control receipt.
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_OWNER_BUSY"))?;
        if let Some((expected, reply)) = state.receipts.get(&control.request_id) {
            ensure!(expected == &digest, "REMOTE_CONTROL_REQUEST_ID_CONFLICT");
            return Ok(serde_json::to_value(reply)?);
        }
        ensure!(
            state.receipts.len() < 4096 && state.calls.len() < 1024,
            "REMOTE_CONTROL_RECEIPT_CAPACITY"
        );
        let data = match &control.message {
            NativeRemoteControlDataV1::ReceiverAccepted(actual) => {
                ensure!(
                    state.receiver_settings.as_deref()
                        == Some(actual.receiver_settings_sha256.as_str()),
                    "REMOTE_CONTROL_RECEIVER_SETTINGS_CHANGED"
                );
                if let Some(expected) = &state.receiver {
                    ensure!(
                        expected == actual,
                        "REMOTE_CONTROL_RECEIVER_ACCEPTED_CHANGED"
                    );
                } else {
                    state.receiver = Some(actual.clone());
                }
                NativeRemoteReceiptDataV1::Receiver {
                    accepted: actual.clone(),
                    outcome: None,
                    cleanup_confirmed: false,
                }
            }
            NativeRemoteControlDataV1::ReserveModel(actual) => {
                require_receiver(&state, &actual.receiver_accepted)?;
                ensure!(
                    !state.calls.contains_key(&actual.native_call_id),
                    "REMOTE_CONTROL_RECONCILE_ORIGINAL_CALL"
                );
                let reservation = self.budget.reserve_owned_callback_call(
                    &actual.native_call_id,
                    charge(&actual.conservative_bound)?,
                )?;
                state.calls.insert(
                    actual.native_call_id.clone(),
                    SourceCall {
                        reservation,
                        dispatched: false,
                        finished: false,
                    },
                );
                call_receipt(&state, &actual.receiver_accepted, &actual.native_call_id)?
            }
            NativeRemoteControlDataV1::DispatchModel(actual) => {
                require_receiver(&state, &actual.receiver_accepted)?;
                let call = state
                    .calls
                    .get_mut(&actual.native_call_id)
                    .context("REMOTE_CONTROL_ORIGINAL_CALL_REQUIRED")?;
                ensure!(
                    !call.dispatched && !call.finished,
                    "REMOTE_CONTROL_RECONCILE_ORIGINAL_CALL"
                );
                call.reservation.dispatch_owned_callback_call()?;
                call.dispatched = true;
                call_receipt(&state, &actual.receiver_accepted, &actual.native_call_id)?
            }
            NativeRemoteControlDataV1::ObserveModel(actual) => {
                require_receiver(&state, &actual.receiver_accepted)?;
                call_receipt(&state, &actual.receiver_accepted, &actual.native_call_id)?
            }
            NativeRemoteControlDataV1::FinishModel(actual) => {
                require_receiver(&state, &actual.call.receiver_accepted)?;
                let call = state
                    .calls
                    .get_mut(&actual.call.native_call_id)
                    .context("REMOTE_CONTROL_ORIGINAL_CALL_REQUIRED")?;
                ensure!(
                    call.dispatched && !call.finished,
                    "REMOTE_CONTROL_RECONCILE_ORIGINAL_CALL"
                );
                call.reservation.finish_authenticated_receiver_call(
                    &actual.call.native_call_id,
                    &actual.call.receiver_accepted,
                    actual.outcome,
                    actual.actual_usage.as_ref().map(charge).transpose()?,
                )?;
                call.finished = actual.outcome != NativeRemoteCallOutcomeV1::OutcomeUnknown;
                call_receipt(
                    &state,
                    &actual.call.receiver_accepted,
                    &actual.call.native_call_id,
                )?
            }
            _ => anyhow::bail!("REMOTE_CONTROL_METHOD_UNAVAILABLE"),
        };
        let reply = NativeRemoteControlReplyV1 {
            version: NATIVE_REMOTE_CONTROL_VERSION,
            operation_id: control.operation_id,
            request_id: control.request_id.clone(),
            endpoint_revision: control.endpoint_revision,
            endpoint_instance_id: control.endpoint_instance_id,
            state: NativeRemoteReceiptStateV1::Received,
            data,
        };
        self.frames
            .verify_received_control(&NativeRemoteControlFrameV1 {
                version: NATIVE_REMOTE_CONTROL_VERSION,
                operation_id: reply.operation_id.clone(),
                request_id: reply.request_id.clone(),
                endpoint_revision: reply.endpoint_revision.clone(),
                endpoint_instance_id: reply.endpoint_instance_id.clone(),
                source_accepted_sha256: control.source_accepted_sha256,
                message: NativeRemoteControlDataV1::ObserveOriginal,
            })?;
        state
            .receipts
            .insert(control.request_id, (digest, reply.clone()));
        Ok(serde_json::to_value(reply)?)
    }
}
fn require_receiver(state: &ControlState, actual: &NativeRemoteAcceptedFactsV1) -> Result<()> {
    ensure!(
        state.receiver.as_ref() == Some(actual),
        "REMOTE_CONTROL_ORIGINAL_RECEIVER_REQUIRED"
    );
    Ok(())
}
fn charge(data: &NativeRemoteChargeDataV1) -> Result<BudgetCharge> {
    // No price producer exists on this branch. Unknown money remains unknown;
    // neither a zero string nor a remote assertion creates money provenance.
    ensure!(
        data.cost_micros.is_none(),
        "REMOTE_CONTROL_MONEY_PROVENANCE_UNAVAILABLE"
    );
    Ok(BudgetCharge {
        tokens: data.tokens,
        model_calls: data.model_calls,
        run_millis: data.run_millis,
        cost_micros: None,
    })
}
fn call_receipt(
    state: &ControlState,
    accepted: &NativeRemoteAcceptedFactsV1,
    id: &str,
) -> Result<NativeRemoteReceiptDataV1> {
    let call = state
        .calls
        .get(id)
        .context("REMOTE_CONTROL_ORIGINAL_CALL_REQUIRED")?;
    let charged = &call.reservation.receipt().charged;
    Ok(NativeRemoteReceiptDataV1::ModelCall {
        call: NativeRemoteCallRefV1 {
            receiver_accepted: accepted.clone(),
            native_call_id: id.into(),
        },
        dispatched: call.dispatched,
        finished: call.finished,
        charged: NativeRemoteChargeDataV1 {
            tokens: charged.tokens,
            model_calls: charged.model_calls,
            run_millis: charged.run_millis,
            cost_micros: charged.cost_micros.map(|value| value.to_string()),
        },
    })
}

#[cfg(test)]
#[path = "source_control/tests.rs"]
mod tests;
