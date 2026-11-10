//! Browser catalog metadata through the current authenticated native identity.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::browser_profiles::*;
use kcoder_native_scope::{NativeDomain, NativeDomainGuard, NativeIntegrationContext};
use kcoder_state::browser_profiles::BrowserProfileStore;
use kcoder_types::integrations::core::*;
use serde_json::{Value, json};
use std::ffi::OsStr;

pub fn handle_request(
    native: &NativeIntegrationContext,
    method: BrowserProfilesMethod,
    request: &IntegrationRequest,
) -> IntegrationReply {
    envelope(request, execute(native, method, request))
}

pub(crate) fn load(
    native: &NativeIntegrationContext,
) -> Result<Option<(NativeDomainGuard, BrowserProfileStore)>> {
    let Some(guard) = NativeDomainGuard::observe(
        native.profile()?,
        native.scope(),
        NativeDomain::BrowserProfiles,
    )?
    else {
        return Ok(None);
    };
    let directory = guard.directory(native.profile()?)?;
    let store = BrowserProfileStore::open_in(&directory, OsStr::new("catalog"), native.scope())?
        .context("BROWSER_PROFILE_STORAGE_DAMAGED")?;
    Ok(Some((guard, store)))
}

fn execute(
    native: &NativeIntegrationContext,
    method: BrowserProfilesMethod,
    request: &IntegrationRequest,
) -> Result<Value> {
    let write = method != BrowserProfilesMethod::List;
    request.validate(write)?;
    ensure!(
        request.cancellation_ref.is_none(),
        "BROWSER_PROFILE_INVALID_REQUEST"
    );
    native.validate_scope(&request.scope)?;
    let operation = request.operation_id.as_deref();
    if let Some(operation) = operation {
        ensure!(
            !operation.is_empty()
                && operation.len() <= 128
                && operation
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "BROWSER_PROFILE_OPERATION_INVALID"
        );
    }
    let payload = Value::Object(request.payload.clone());
    let mut current = load(native)?;
    let result = match method {
        BrowserProfilesMethod::List => {
            ensure!(
                request.expected_revision.is_none(),
                "BROWSER_PROFILE_INVALID_REQUEST"
            );
            let input: BrowserProfilesListParams = serde_json::from_value(payload)?;
            if let Some((_, store)) = &current {
                json!({"page":store.list(input.after.as_deref(), input.include_archived)?})
            } else {
                ensure!(input.after.is_none(), "BROWSER_PROFILE_CURSOR_INVALID");
                json!({"page":{"items":[],"nextCursor":null}})
            }
        }
        BrowserProfilesMethod::Save => {
            let input: BrowserProfilesSaveParams = serde_json::from_value(payload)?;
            ensure!(
                request
                    .expected_revision
                    .as_ref()
                    .is_none_or(|revision| revision == &input.expected_revision.to_string()),
                "BROWSER_PROFILE_REVISION_CONFLICT"
            );
            input.draft.validate().map_err(anyhow::Error::msg)?;
            let operation = operation.context("BROWSER_PROFILE_OPERATION_REQUIRED")?;
            if current.is_none() {
                ensure!(
                    input.expected_revision == 0,
                    "BROWSER_PROFILE_REVISION_CONFLICT"
                );
                current = Some(NativeDomainGuard::initialize(
                    native.profile()?,
                    native.scope(),
                    NativeDomain::BrowserProfiles,
                    operation,
                    |directory| {
                        BrowserProfileStore::create_in(
                            directory,
                            OsStr::new("catalog"),
                            native.scope(),
                        )
                    },
                )?);
            }
            json!({"profile":current.as_ref().unwrap().1.save(operation, input.draft, input.expected_revision)?})
        }
        BrowserProfilesMethod::SetArchived => {
            let input: BrowserProfilesArchiveParams = serde_json::from_value(payload)?;
            ensure!(
                request
                    .expected_revision
                    .as_ref()
                    .is_none_or(|revision| revision == &input.expected_revision.to_string()),
                "BROWSER_PROFILE_REVISION_CONFLICT"
            );
            let (_, store) = current.as_ref().context("BROWSER_PROFILE_NOT_FOUND")?;
            json!({"profile":store.set_archived(operation.context("BROWSER_PROFILE_OPERATION_REQUIRED")?, &input.profile_id, input.expected_revision, input.archived)?})
        }
    };
    let verified = (|| -> Result<()> {
        if let Some((guard, _)) = &current {
            guard.directory(native.profile()?)?;
        }
        native.validate_scope(&request.scope)
    })();
    if write {
        verified.map_err(|_| anyhow::anyhow!("BROWSER_PROFILE_WRITE_UNCONFIRMED"))?;
    } else {
        verified?;
    }
    Ok(result)
}

fn envelope(request: &IntegrationRequest, result: Result<Value>) -> IntegrationReply {
    let (status, value, error) = match result {
        Ok(value) => (
            IntegrationStatus::Completed,
            IntegrationNullable::Value(value.as_object().cloned().unwrap_or_default()),
            IntegrationNullable::Null,
        ),
        Err(error) => {
            let text = error.to_string();
            let code = if error
                .chain()
                .any(|cause| cause.to_string().contains("UNCONFIRMED"))
            {
                "BROWSER_PROFILE_WRITE_UNCONFIRMED".into()
            } else if text.starts_with("BROWSER_PROFILE_")
                && text.bytes().all(|b| b.is_ascii_uppercase() || b == b'_')
            {
                text
            } else {
                "BROWSER_PROFILE_UNAVAILABLE".into()
            };
            let unknown = code.contains("UNCONFIRMED");
            (
                if unknown {
                    IntegrationStatus::Unknown
                } else {
                    IntegrationStatus::Rejected
                },
                IntegrationNullable::Null,
                IntegrationNullable::Value(IntegrationError {
                    code,
                    recovery: if unknown {
                        IntegrationRecovery::ReconcileOriginal
                    } else {
                        IntegrationRecovery::ExplicitUserDecision
                    },
                    message_key: "browserProfiles.operationFailed".into(),
                }),
            )
        }
    };
    IntegrationReply {
        contract_version: request.contract_version,
        request_id: request.request_id.clone(),
        status,
        operation_id: request
            .operation_id
            .clone()
            .map_or(IntegrationNullable::Null, IntegrationNullable::Value),
        entity_revision: IntegrationNullable::Null,
        observed_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .to_string(),
        result: value,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(
        native: &NativeIntegrationContext,
        operation: Option<&str>,
        payload: Value,
    ) -> IntegrationRequest {
        IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: "catalog-request".into(),
            scope: native.scope().clone(),
            operation_id: operation.map(Into::into),
            expected_revision: None,
            timeout_ms: 1000,
            cancellation_ref: None,
            payload: payload.as_object().unwrap().clone(),
        }
    }
    #[test]
    fn native_catalog_reuses_receipts_rejects_foreign_scope_and_never_starts_a_browser()
    -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("browser-profile-host")?;
        let parent = kcoder_config::PrivateDirectory::open_existing(root.path())?;
        parent.create_private_child(OsStr::new("profile"))?;
        parent.create_private_child(OsStr::new("workspace"))?;
        let native = NativeIntegrationContext::capture(
            &root.path().join("profile"),
            &root.path().join("workspace"),
            "test",
            "revision",
        )?;
        let list = request(&native, None, json!({}));
        assert_eq!(
            execute(&native, BrowserProfilesMethod::List, &list)?["page"]["items"],
            json!([])
        );
        assert!(load(&native)?.is_none());
        let save = request(
            &native,
            Some("create"),
            json!({"draft":{"id":"office","label":"Office account","accountLabel":"User label","purpose":"business"},"expectedRevision":0}),
        );
        let first = execute(&native, BrowserProfilesMethod::Save, &save)?;
        assert_eq!(execute(&native, BrowserProfilesMethod::Save, &save)?, first);
        let mut foreign = list.clone();
        foreign.scope.account_id = "foreign".into();
        assert!(execute(&native, BrowserProfilesMethod::List, &foreign).is_err());
        let stale = request(&native, Some("stale"), save.payload.clone().into());
        assert!(execute(&native, BrowserProfilesMethod::Save, &stale).is_err());
        assert_eq!(
            execute(&native, BrowserProfilesMethod::List, &list)?["page"]["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        Ok(())
    }

    #[test]
    fn public_failure_preserves_unknown_writes_and_does_not_expose_private_paths() {
        let scope = serde_json::from_value(json!({"accountId":"a","targetId":"t","workspaceId":null,"identityGeneration":"g","targetRevision":"r"})).unwrap();
        let request = IntegrationRequest {
            contract_version: IntegrationContractVersion::ParallelV1,
            request_id: "request".into(),
            scope,
            operation_id: Some("save".into()),
            expected_revision: None,
            timeout_ms: 1000,
            cancellation_ref: None,
            payload: Default::default(),
        };
        let unknown = envelope(
            &request,
            Err(anyhow::anyhow!(
                "INTEGRATION_STORAGE_INITIALIZATION_UNCONFIRMED"
            )),
        );
        assert_eq!(unknown.status, IntegrationStatus::Unknown);
        unknown.validate().unwrap();
        let hidden = envelope(
            &request,
            Err(anyhow::anyhow!("cannot open /private/user/profile")),
        );
        assert_eq!(hidden.status, IntegrationStatus::Rejected);
        assert!(
            !serde_json::to_string(&hidden)
                .unwrap()
                .contains("/private/user/profile")
        );
    }
}
