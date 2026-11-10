//! Finite authenticated Office controls; byte reads retain the existing attachment RPC.
use super::{native_assets::NativeOfficeFileAssets, native_host::*, reply_result};
use crate::app_server::integrations::{
    core::NativeIntegrationContext,
    knowledge::{NativeKnowledgeRpc, validate_management_office_knowledge_sources},
};
use crate::app_server::task_spawn::JoinSetExt as _;
use crate::app_server::{ConnectionState, ThreadManager, error_response, send, success_response};
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::integrations::office::OfficeMethod;
use kcoder_app_rpc_codec as rpc_codec;
use kcoder_engine::{QueryEngine, integrations::office::OfficeService};
use kcoder_types::integrations::{core::*, office::*};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

mod inputs;
pub(in crate::app_server) use inputs::dispatch_upload_finish;
mod preflight;
mod settings;
pub(in crate::app_server) use settings::dispatch_settings;

struct ManagementKnowledgeSources {
    engine: QueryEngine,
    cache: Arc<tokio::sync::Mutex<NativeKnowledgeRpc>>,
    connectivity:
        Arc<crate::app_server::integrations::connectivity::main_rpc::NativeConnectivityMainService>,
}
#[async_trait::async_trait]
#[kcoder_async_box::shared]
impl NativeOfficeAssets for ManagementKnowledgeSources {
    async fn validate_sources(
        &self,
        native: &NativeIntegrationContext,
        request: &IntegrationRequest,
        sources: &[OfficeResourceRef],
        cancel: &CancellationToken,
    ) -> Result<Vec<OfficeCanonicalInputIdentity>> {
        if sources
            .iter()
            .any(|source| source.kind.starts_with("application_"))
        {
            ensure!(
                sources.iter().all(|source| matches!(
                    source.kind.as_str(),
                    "application_connection" | "application_resource" | "application_receipt"
                )),
                "APPLICATION_BUSINESS_SOURCE_CHANGED"
            );
            return self
                .connectivity
                .validate_office_application_sources(native, sources, cancel)
                .await;
        }
        validate_management_office_knowledge_sources(
            native,
            &self.engine,
            &self.cache,
            request,
            sources,
            cancel,
        )
        .await
    }
}

pub(super) fn management_assets(
    native: &NativeIntegrationContext,
    engine: &QueryEngine,
    transfers: Arc<super::native_assets::NativeOfficeTransfers>,
    cache: Arc<tokio::sync::Mutex<NativeKnowledgeRpc>>,
    connectivity: Arc<
        crate::app_server::integrations::connectivity::main_rpc::NativeConnectivityMainService,
    >,
) -> Result<NativeOfficeFileAssets> {
    let sources = Arc::new(ManagementKnowledgeSources {
        engine: engine.clone(),
        cache,
        connectivity,
    });
    NativeOfficeFileAssets::capture_management(native, engine, transfers, Some(sources))
}

pub(in crate::app_server) async fn dispatch_export_read(
    method: &str,
    id: &Value,
    params: &Value,
    workspace: &QueryEngine,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let chunked = match method {
        "attachment/read" => false,
        "attachment/read/chunk" => true,
        _ => return Ok(false),
    };
    if !params
        .get("path")
        .and_then(Value::as_str)
        .is_some_and(NativeOfficeFileAssets::is_export_locator)
    {
        return Ok(false);
    }
    let prepared = (|| -> Result<_> {
        ensure!(
            state.integration_office_v1 && state.knowledge_rpc_tasks.len() < 64,
            "OFFICE_EXPORT_UNAVAILABLE"
        );
        let native = state
            .integration_context
            .as_ref()
            .context("OFFICE_NATIVE_SCOPE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        let assets = management_assets(
            &native,
            workspace,
            state.integration_office_transfers.clone(),
            state.integration_knowledge.clone(),
            state.integration_connectivity.clone(),
        )?;
        Ok((native, assets))
    })();
    let (native, assets) = match prepared {
        Ok(value) => value,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32038, "OFFICE_ATTACHMENT_UNAVAILABLE"),
            )
            .await?;
            return Ok(true);
        }
    };
    let (outbound, id, params) = (outbound.clone(), id.clone(), params.clone());
    let cancel = state.input_ended.child_token();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let read = async {
            if chunked {
                let params = serde_json::from_value(params)?;
                serde_json::to_value(
                    assets
                        .read_attachment_chunk(&native, &params, &cancel)
                        .await?,
                )
                .map_err(anyhow::Error::from)
            } else {
                let params = serde_json::from_value(params)?;
                serde_json::to_value(assets.read_attachment(&native, &params, &cancel).await?)
                    .map_err(anyhow::Error::from)
            }
        }
        .await;
        let response = match read {
            Ok(result) => success_response(id, result),
            Err(error)
                if !chunked
                    && error.to_string()
                        == "attachment preview exceeds the 256 KiB response limit" =>
            {
                error_response(
                    id,
                    -32038,
                    "attachment preview exceeds the 256 KiB response limit",
                )
            }
            Err(_) => error_response(id, -32038, "OFFICE_ATTACHMENT_UNAVAILABLE"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}

pub(in crate::app_server) struct OfficePublicEngines<'a> {
    pub workspace: &'a QueryEngine,
    pub threads: &'a ThreadManager,
    pub factory: &'a crate::app_server::AppServerEngineFactory,
}

pub(in crate::app_server) async fn dispatch_public(
    method: &str,
    id: &Value,
    params: &Value,
    engines: OfficePublicEngines<'_>,
    outbound: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
) -> Result<bool> {
    let OfficePublicEngines {
        workspace,
        threads,
        factory,
    } = engines;
    let Some(kind) = OfficeMethod::parse(method) else {
        return Ok(false);
    };
    let prepared = (|| -> Result<_> {
        ensure!(
            state.integration_office_v1,
            "OFFICE_RPC_CAPABILITY_UNAVAILABLE"
        );
        if kind == OfficeMethod::AcknowledgeExport {
            ensure!(
                state.integration_office_export_ack_v1
                    || state.integration_office_export_receipt_v1,
                "OFFICE_RPC_CAPABILITY_UNAVAILABLE"
            );
        }
        ensure!(state.knowledge_rpc_tasks.len() < 64, "OFFICE_RPC_BUSY");
        let request: IntegrationRequest = rpc_codec::decode(params.clone())?;
        request.validate(kind.is_mutation())?;
        let native = state
            .integration_context
            .as_ref()
            .context("OFFICE_NATIVE_SCOPE_UNAVAILABLE")?
            .recapture_for_owned_service()?;
        native.validate_scope(&request.scope)?;
        let explicit_thread = request
            .payload
            .get("task")
            .and_then(|task| task.get("threadId"))
            .or_else(|| request.payload.get("threadId"))
            .and_then(Value::as_str);
        let (engine, canonical_owner) = if kind == OfficeMethod::ReadCanonicalSource {
            // The reference is a locator. Only this current owner's original
            // private manifest selects the exact resident task; never latest.
            let params: OfficeCanonicalSourceReadParams =
                rpc_codec::decode(Value::Object(request.payload.clone()))?;
            let original = NativeOfficeComposition::observe_metadata(
                &native,
                workspace,
                NativeOfficeProviders::default(),
            )?
            .context("OFFICE_NATIVE_STORE_UNCONFIRMED")?;
            let task = original.artifact_task(&params.reference)?;
            ensure!(
                explicit_thread.is_none_or(|thread| thread == task.thread_id),
                "OFFICE_NATIVE_CALL_OWNER_MISMATCH"
            );
            let selected = threads
                .engine(&task.thread_id)
                .context("OFFICE_NATIVE_TASK_PROVIDER_UNAVAILABLE")?;
            let lease = threads
                .lease(&task.thread_id)
                .context("OFFICE_NATIVE_TASK_PROVIDER_UNAVAILABLE")?;
            crate::app_server::ensure_active_thread(&selected, Some(lease), &task.thread_id)?;
            let owner = lease.native_witness()?;
            owner.verify_target(&selected.session_lease_target())?;
            original.verify(&native)?;
            (selected, Some(owner))
        } else {
            (
                explicit_thread
                    .and_then(|thread| threads.engine(thread))
                    .unwrap_or_else(|| workspace.clone()),
                None,
            )
        };
        let readiness = if kind == OfficeMethod::ValidateAssistant {
            preflight::definition(&request).ok().and_then(|definition| {
                crate::app_server::integrations::connectivity::NativeOfficeReadinessPort::capture(
                    state,
                    &request,
                    &definition,
                )
                .ok()
            })
        } else {
            None
        };
        let runtime = if kind == OfficeMethod::AdoptAssistant
            && request.payload.get("startTask").and_then(Value::as_bool) == Some(true)
        {
            Some(super::runtime_port::NativeOfficeRuntimePort::capture(
                state, &engine, factory, kind, &request,
            )?)
        } else {
            None
        };
        Ok((native, engine, request, readiness, canonical_owner, runtime))
    })();
    let (native, engine, request, readiness, canonical_owner, runtime) = match prepared {
        Ok(value) => value,
        Err(_) => {
            send(
                outbound,
                error_response(id.clone(), -32075, "OFFICE_RPC_UNAVAILABLE"),
            )
            .await?;
            return Ok(true);
        }
    };
    let ordinary_ack = state.integration_office_export_receipt_v1;
    let automation_ack = state.integration_office_export_ack_v1;
    let resources = state.integration_office_resources.clone();
    let transfers = state.integration_office_transfers.clone();
    let knowledge = state.integration_knowledge.clone();
    let connectivity = state.integration_connectivity.clone();
    let cancel = state.input_ended.child_token();
    let outbound = outbound.clone();
    let id = id.clone();
    let method = method.to_owned();
    state.knowledge_rpc_tasks.spawn_shared(async move {
        let operation = async {
            if let Some(owner) = &canonical_owner { owner.verify_target(&engine.session_lease_target())?; }
            if kind == OfficeMethod::AcknowledgeExport {
                let params: kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementParams =
                    rpc_codec::decode(Value::Object(request.payload.clone()))?;
                let assets = management_assets(&native, &engine, transfers, knowledge.clone(), connectivity.clone())?;
                let value = if let Some(run_id)=params.automation_run_id.as_deref() {
                    ensure!(automation_ack,"OFFICE_RPC_CAPABILITY_UNAVAILABLE");
                    let acknowledged=assets.acknowledge_export(&native,&params,&cancel).await?;
                    let host=knowledge.lock().await.host_for_engine(&native,&engine)?;
                    let now=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_millis().try_into()?;
                    let claim=host.record_export_acknowledgement(&request,run_id,&acknowledged,now)?;
                    serde_json::to_value(kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementResult {
                        export_id:params.export_id,reference:params.reference,
                        acknowledgement:kcoder_app_protocol::integrations::office::OfficeExportAcknowledgement::ClientAcknowledged,
                        claim:Some(claim),receipt:None,
                    })?
                } else {
                    ensure!(ordinary_ack,"OFFICE_RPC_CAPABILITY_UNAVAILABLE");
                    let receipt=assets.acknowledge_export_receipt(&native,&request,&params,&cancel).await?;
                    serde_json::to_value(kcoder_app_protocol::integrations::office::OfficeExportAcknowledgementResult {
                        export_id:params.export_id,reference:params.reference,
                        acknowledgement:kcoder_app_protocol::integrations::office::OfficeExportAcknowledgement::ClientAcknowledged,
                        claim:None,receipt:Some(receipt),
                    })?
                };
                return Ok(reply_result(&method, &request, Ok(value)));
            }
            if kind==OfficeMethod::ReadOfficeOperation {
                let operation=request.payload.get("operationId").and_then(Value::as_str).context("OFFICE_INVALID_INPUT")?;
                let assets=management_assets(&native,&engine,transfers.clone(),knowledge.clone(),connectivity.clone())?;
                if let Some(receipt)=assets.read_export_acknowledgement_operation(&native,operation,&cancel).await? {
                    let result=json!({"operationId":operation,"method":"office.acknowledgeExport","phase":"completed","result":receipt,"recovery":"none"});
                    return Ok(reply_result(&method,&request,Ok(result)));
                }
            }
            let assets = Arc::new(management_assets(&native, &engine, transfers, knowledge, connectivity)?) as Arc<dyn NativeOfficeAssets>;
            let providers = NativeOfficeProviders { tasks: Some(Arc::new(NativeOfficeAcceptedTurnAuthority)), assets: Some(assets),
                ports: runtime.as_ref().map(|port|port.clone() as Arc<dyn NativeOfficePorts>).or_else(||readiness.as_ref().map(|port| port.clone() as Arc<dyn NativeOfficePorts>)) };
            let static_generator = if kind == OfficeMethod::ValidateAssistant {
                preflight::definition(&request)?;
                Some(preflight::observe_after_authorization(
                    || preflight::authorize_observation(&native, &request),
                    || preflight::generator(&native, &engine, resources.as_deref(), &cancel),
                ).await?)
            } else { None };
            let needs_generator = matches!(kind, OfficeMethod::GenerateOffice | OfficeMethod::GeneratorReadiness);
            let existing = if needs_generator {
                let installed = resources.as_ref().context("OFFICE_DEPENDENCY_UNAVAILABLE")?.resolve(&native, &engine, &cancel).await?;
                if kind == OfficeMethod::GeneratorReadiness {
                    let result = installed.readiness(&native, &cancel).await;
                    return Ok(reply_result(&method, &request, result));
                }
                match NativeOfficeComposition::observe(&native, &engine, installed.clone(), providers.clone())? {
                    Some(existing) => Some(existing),
                    None if kind.is_mutation() => Some(NativeOfficeComposition::initialize(&native, &engine, installed, providers, request.operation_id.as_deref().context("OFFICE_OPERATION_REQUIRED")?)?),
                    None => None,
                }
            } else {
                match NativeOfficeComposition::observe_metadata(&native, &engine, providers.clone())? {
                    Some(existing) => Some(existing),
                    None if kind.is_mutation() => Some(NativeOfficeComposition::initialize_metadata(&native, &engine, providers, request.operation_id.as_deref().context("OFFICE_OPERATION_REQUIRED")?)?),
                    None => None,
                }
            };
            if let Some(existing) = existing {
                let mut reply = existing.dispatch(&native, &method, &request, &cancel).await?;
                if let Some(owner) = &canonical_owner { owner.verify_target(&engine.session_lease_target())?; }
                if let (Some(generator), IntegrationNullable::Value(result)) = (static_generator, &mut reply.result) {
                    result.insert("generator".into(), generator);
                }
                native.validate_scope(&request.scope)?;
                return Ok(reply);
            }
            let value = match kind {
                OfficeMethod::ReadExpertPackage => {
                    preflight::authorize_observation(&native, &request)?;
                    OfficeService::builtin_expert_assets(&request)
                }
                OfficeMethod::ReadExpertMarket => {
                    preflight::authorize_observation(&native, &request)?;
                    OfficeService::expert_market_detail(&request, &cancel).await
                }
                OfficeMethod::ListExpertMarket => {
                    preflight::authorize_observation(&native, &request)?;
                    OfficeService::expert_market_catalog(&request, &cancel).await
                }
                OfficeMethod::ListSkillMarket => {
                    preflight::authorize_observation(&native, &request)?;
                    OfficeService::skill_market_catalog(&request, &cancel).await
                }
                OfficeMethod::ListAssistants => OfficeService::builtin_assistant_catalog(&request),
                OfficeMethod::ValidateAssistant => preflight::uninitialized(&native, &engine, &request, static_generator.unwrap_or(Value::Null), readiness.as_ref(), &cancel).await,
                OfficeMethod::ListArtifacts => Ok(json!({"items":[],"total":0,"nextCursor":null,"storageState":"not_initialized"})),
                _ => Err(anyhow::anyhow!("OFFICE_DEPENDENCY_UNAVAILABLE")),
            };
            native.validate_scope(&request.scope)?;
            Ok(reply_result(&method, &request, value))
        };
        // A timeout is unconfirmed; callers reconcile the original mutation.
        let result = tokio::time::timeout(std::time::Duration::from_millis(request.timeout_ms), operation).await;
        cancel.cancel();
        let reply = match result {
            Ok(Ok(reply)) => Some(reply),
            Ok(Err(error)) if !kind.is_mutation() => Some(reply_result(&method, &request, Err(error))),
            _ => None,
        };
        let response = match reply.and_then(|reply| serde_json::to_value(reply).ok()) {
            Some(reply) => success_response(id, reply),
            None => error_response(id, -32076, "OFFICE_RPC_RESULT_UNCONFIRMED"),
        };
        let _ = send(&outbound, response).await;
    });
    Ok(true)
}
