//! Privileged numeric accounting bridge over the original State journal; no Engine or tools.
use anyhow::{Context, Result, ensure};
use kcoder_config::PrivateDirectory;
use kcoder_state::integrations::core::budgets::*;
use kcoder_types::integrations::core::{IntegrationNullable, IntegrationScope};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    ffi::OsStr,
    io::{Read, Write},
    path::PathBuf,
};

pub const ENTRY: &str = "--internal-organization-budget-v1";
const MAX_FRAME: u64 = 128 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    version: u32,
    root: PathBuf,
    owner: IntegrationScope,
    member_id: String,
    workspace_id: String,
    policy_revision: u64,
    policies: Vec<Policy>,
    action: Action,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    id: String,
    scope: BudgetScope,
    window: BudgetWindow,
    limits: BudgetLimits,
    currency: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Create,
    Initialize,
    Inspect,
    Reserve {
        reservation_id: String,
        operation_id: String,
        unit: BudgetUnit,
        task: BudgetTaskLink,
        estimate: BudgetCharge,
        #[serde(default)]
        parent: Option<Parent>,
    },
    Dispatch {
        reservation_id: String,
        expected_revision: u64,
    },
    Read {
        reservation_id: String,
    },
    Check {
        reservation_id: String,
    },
    CallsClosed {
        reservation_id: String,
    },
    Observe {
        reservation_id: String,
        expected_revision: u64,
        update_id: String,
        coverage: BudgetUsageCoverage,
        usage: BudgetCharge,
        terminal: Option<Terminal>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Terminal {
    receipt_id: String,
    receipt_sha256: String,
    kind: BudgetTerminalKind,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Parent {
    receipt_id: String,
    receipt_sha256: String,
}

pub fn run() -> Result<()> {
    #[cfg(not(target_os = "linux"))]
    anyhow::bail!("ORGANIZATION_BUDGET_HOST_UNSUPPORTED");
    #[cfg(target_os = "linux")]
    {
        ensure!(
            unsafe { libc::geteuid() } == 0,
            "ORGANIZATION_BUDGET_ROOT_REQUIRED"
        );
        let mut bytes = Vec::new();
        std::io::stdin()
            .take(MAX_FRAME + 1)
            .read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= MAX_FRAME,
            "ORGANIZATION_BUDGET_FRAME_TOO_LARGE"
        );
        let request: Envelope = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow::anyhow!("ORGANIZATION_BUDGET_INVALID_REQUEST"))?;
        let result = execute(request);
        let response = match result {
            Ok(result) => json!({"ok":true,"result":result}),
            Err(error) => {
                let code = error.to_string();
                let public = match code.as_str() {
                    "BUDGET_BUSY"
                    | "BUDGET_EXHAUSTED"
                    | "BUDGET_POLICY_STALE"
                    | "BUDGET_OPERATION_CONFLICT" => code.as_str(),
                    _ => "ORGANIZATION_BUDGET_UNAVAILABLE",
                };
                json!({"ok":false,"error":public})
            }
        };
        let bytes = serde_json::to_vec(&response)?;
        ensure!(
            bytes.len() as u64 <= MAX_FRAME,
            "ORGANIZATION_BUDGET_RESULT_TOO_LARGE"
        );
        std::io::stdout().write_all(&bytes)?;
        Ok(())
    }
}

fn execute(request: Envelope) -> Result<Value> {
    ensure!(
        request.version == 1 && request.policy_revision > 0 && request.root.is_absolute(),
        "ORGANIZATION_BUDGET_INVALID_REQUEST"
    );
    request.owner.validate()?;
    let organization = request
        .owner
        .organization_id
        .as_ref()
        .and_then(IntegrationNullable::as_ref)
        .context("ORGANIZATION_BUDGET_SCOPE_REQUIRED")?;
    ensure!(
        request.owner.workspace_id.as_ref().is_none() && request.policies.len() <= 16,
        "ORGANIZATION_BUDGET_INVALID_REQUEST"
    );
    let parent = PrivateDirectory::open_existing(&request.root)?;
    parent.verify_private_directory()?;
    let store = match &request.action {
        Action::Create => NativeBudgetStore::create_in(
            &parent,
            OsStr::new("organization-budget"),
            &request.owner,
        )?,
        Action::Initialize => {
            NativeBudgetStore::open_in(&parent, OsStr::new("organization-budget"), &request.owner)?
                .context("ORGANIZATION_BUDGET_INITIALIZATION_REQUIRED")?
        }
        _ => {
            NativeBudgetStore::open_in(&parent, OsStr::new("organization-budget"), &request.owner)?
                .context("ORGANIZATION_BUDGET_NOT_INITIALIZED")?
        }
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        .try_into()?;
    let requires_runtime_bound = request
        .policies
        .iter()
        .any(|policy| policy.limits.run_millis.is_some());
    let requires_task_slot = request
        .policies
        .iter()
        .any(|policy| policy.limits.concurrent_tasks.is_some());
    let expected_policies = request
        .policies
        .iter()
        .map(|p| {
            (
                p.scope.clone(),
                p.window.clone(),
                p.limits.clone(),
                p.currency.clone(),
            )
        })
        .collect::<Vec<_>>();
    let policies = request
        .policies
        .into_iter()
        .map(|p| {
            NativeBudgetPolicy::from_native_config(NativeBudgetPolicyDefinition {
                id: p.id,
                version: request.policy_revision,
                revision: format!("organization-policy-{}", request.policy_revision),
                scope: p.scope,
                window: p.window,
                limits: p.limits,
                currency: p.currency,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if matches!(&request.action, Action::Inspect) {
        let observations = policies
            .iter()
            .map(|policy| store.observe_policy(policy))
            .collect::<Result<Vec<_>>>()?;
        return Ok(json!({"observations": observations}));
    }
    // Identical observations stay read-only; changed root policy is installed before admission.
    let mut changed = false;
    for (policy, (scope, window, limits, currency)) in policies.iter().zip(&expected_policies) {
        let observed = store.observe_policy(policy)?;
        if observed.as_ref().is_none_or(|value| {
            value.policy.version != request.policy_revision
                || value.policy.revision
                    != format!("organization-policy-{}", request.policy_revision)
                || &value.policy.scope != scope
                || &value.policy.window != window
                || &value.limits != limits
                || &value.currency != currency
        }) {
            changed = true;
            break;
        }
    }
    if changed {
        store.install_policies(&policies)?;
    }
    match request.action {
        Action::Inspect => unreachable!("inspection returns before policy installation"),
        Action::Initialize | Action::Create => Ok(json!({"initialized":true})),
        Action::Reserve {
            reservation_id,
            operation_id,
            unit,
            task,
            estimate,
            parent,
        } => {
            ensure!(
                !requires_task_slot
                    || unit == BudgetUnit::TaskSlot
                    || task.parent_reservation_id.is_some(),
                "ORGANIZATION_TASK_BUDGET_REQUIRED"
            );
            ensure!(
                !requires_runtime_bound || unit == BudgetUnit::TaskSlot || estimate.run_millis > 0,
                "ORGANIZATION_RUNTIME_BUDGET_REQUIRED"
            );
            let principal = NativeBudgetPrincipal::from_native_facts(
                request.member_id,
                Some(organization.clone()),
                Some(request.workspace_id),
                None,
            )?;
            let current =
                store.current_applicable_policies(&principal, &task.root_operation_id, now)?;
            ensure!(!current.is_empty(), "ORGANIZATION_BUDGET_POLICY_REQUIRED");
            let request = NativeBudgetRequest {
                reservation_id,
                operation_id,
                principal,
                unit,
                task,
                estimate,
            };
            let reserved = if request.task.actor == BudgetActor::ChildAgent {
                let proof = parent.context("ORGANIZATION_PARENT_RECEIPT_REQUIRED")?;
                let task = request
                    .task
                    .root_task
                    .clone()
                    .context("ORGANIZATION_PARENT_TASK_REQUIRED")?;
                let binding = NativeBudgetTaskBinding::from_authoritative_receipt(
                    request.task.root_operation_id.clone(),
                    task,
                    proof.receipt_id,
                    proof.receipt_sha256,
                )?;
                let original = store
                    .original_active_task_slot(&request.principal, &binding)?
                    .context("ORGANIZATION_PARENT_TASK_SLOT_REQUIRED")?;
                store.reserve_with_original_task_slot(&original, &request, &current, now)?
            } else {
                store.reserve(&request, &current, now)?
            };
            Ok(serde_json::to_value(reserved.receipt())?)
        }
        Action::Dispatch {
            reservation_id,
            expected_revision,
        } => {
            let principal = NativeBudgetPrincipal::from_native_facts(
                request.member_id,
                Some(organization.clone()),
                Some(request.workspace_id),
                None,
            )?;
            let original = store
                .read_reservation_for_principal(&reservation_id, &principal)?
                .context("ORGANIZATION_BUDGET_RESERVATION_MISSING")?;
            let current = store.current_applicable_policies(
                &principal,
                &original.task.root_operation_id,
                now,
            )?;
            let result =
                store.mark_dispatched(&reservation_id, expected_revision, &current, now)?;
            Ok(serde_json::to_value(match result {
                BudgetDispatchResult::Fresh(r)
                | BudgetDispatchResult::AlreadyDispatched(r)
                | BudgetDispatchResult::Terminal(r) => r,
            })?)
        }
        Action::Read { reservation_id } => {
            let principal = NativeBudgetPrincipal::from_native_facts(
                request.member_id,
                Some(organization.clone()),
                Some(request.workspace_id),
                None,
            )?;
            Ok(serde_json::to_value(
                store.read_reservation_for_principal(&reservation_id, &principal)?,
            )?)
        }
        Action::Check { reservation_id } => {
            let principal = NativeBudgetPrincipal::from_native_facts(
                request.member_id,
                Some(organization.clone()),
                Some(request.workspace_id),
                None,
            )?;
            let original = store
                .read_reservation_for_principal(&reservation_id, &principal)?
                .context("ORGANIZATION_BUDGET_RESERVATION_MISSING")?;
            let current = store.current_applicable_policies(
                &principal,
                &original.task.root_operation_id,
                now,
            )?;
            for policy in current {
                let observed = store
                    .observe_policy(&policy)?
                    .context("ORGANIZATION_BUDGET_POLICY_MISSING")?;
                ensure!(
                    observed
                        .limits
                        .tokens
                        .is_none_or(|limit| observed.charged.tokens <= limit)
                        && observed
                            .limits
                            .model_calls
                            .is_none_or(|limit| observed.charged.model_calls <= limit)
                        && observed
                            .limits
                            .run_millis
                            .is_none_or(|limit| observed.charged.run_millis <= limit)
                        && observed.limits.cost_micros.is_none_or(|limit| observed
                            .charged
                            .cost_micros
                            .is_some_and(|value| value <= limit)),
                    "BUDGET_EXHAUSTED"
                );
            }
            Ok(serde_json::to_value(original)?)
        }
        Action::Observe {
            reservation_id,
            expected_revision,
            update_id,
            coverage,
            usage,
            terminal,
        } => {
            let principal = NativeBudgetPrincipal::from_native_facts(
                request.member_id,
                Some(organization.clone()),
                Some(request.workspace_id),
                None,
            )?;
            let original = store
                .read_reservation_for_principal(&reservation_id, &principal)?
                .context("ORGANIZATION_BUDGET_RESERVATION_MISSING")?;
            if original.unit == BudgetUnit::TaskSlot && terminal.is_some() {
                ensure!(
                    store.original_task_calls_closed(&reservation_id, &principal)?,
                    "ORGANIZATION_TASK_CALLS_STILL_ACTIVE"
                );
            }
            let terminal = terminal
                .map(|proof| {
                    NativeBudgetTerminal::from_authoritative_receipt(
                        original.operation_id.clone(),
                        original.task.root_task.clone(),
                        original.task.actor_attempt_id.clone(),
                        proof.receipt_id,
                        proof.receipt_sha256,
                        proof.kind,
                    )
                })
                .transpose()?;
            Ok(serde_json::to_value(store.record_usage(
                &reservation_id,
                expected_revision,
                &update_id,
                &NativeBudgetUsage {
                    coverage,
                    known: usage,
                },
                terminal.as_ref(),
                now,
            )?)?)
        }
        Action::CallsClosed { reservation_id } => {
            let principal = NativeBudgetPrincipal::from_native_facts(
                request.member_id,
                Some(organization.clone()),
                Some(request.workspace_id),
                None,
            )?;
            let original = store
                .read_reservation_for_principal(&reservation_id, &principal)?
                .context("ORGANIZATION_BUDGET_RESERVATION_MISSING")?;
            Ok(
                json!({"task":original.task,"closed":store.original_task_calls_closed(&reservation_id,&principal)?}),
            )
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn input(root: &std::path::Path, member: &str, action: Value) -> Envelope {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let start = now / 3_600_000 * 3_600_000;
        serde_json::from_value(json!({
            "version":1,"root":root,"owner":{"accountId":"owned-org-service","targetId":"owned-target",
                "workspaceId":null,"identityGeneration":"original-instance","targetRevision":"original-v1","organizationId":"owned-org"},
            "memberId":member,"workspaceId":format!("workspace-{member}"),"policyRevision":1,
            "policies":[{"id":"org-cap","scope":{"kind":"organization","id":"owned-org"},
                "window":{"id":"original-window","startsAtMs":start,"endsAtMs":start+3_600_000},
                "limits":{"tokens":100},"currency":null}],"action":action,
        })).unwrap()
    }
    fn reserve(id: &str, member: &str) -> Value {
        json!({"kind":"reserve","reservation_id":id,"operation_id":format!("operation-{id}"),"unit":"model_call",
            "task":{"rootOperationId":format!("root-{member}"),"rootTask":{"kind":"turn","id":format!("turn-{member}"),"revision":null},
                "actor":"main","actorAttemptId":format!("attempt-{id}"),"parentReservationId":null},
            "estimate":{"tokens":70,"modelCalls":1,"runMillis":0,"costMicros":null}})
    }

    #[test]
    fn inspection_preserves_original_holds_and_does_not_install_new_policy() -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("organization-budget-inspection")?;
        assert!(execute(input(root.path(), "service", json!({"kind":"inspect"}))).is_err());
        assert!(!root.path().join("organization-budget").exists());
        execute(input(root.path(), "service", json!({"kind":"create"})))?;
        execute(input(
            root.path(),
            "alice",
            reserve("original-alice", "alice"),
        ))?;
        let ledger = root.path().join("organization-budget/ledger.json");
        let before = std::fs::read(&ledger)?;
        let mut request = input(root.path(), "service", json!({"kind":"inspect"}));
        request.policy_revision = 2;
        request.policies[0].limits.tokens = Some(140);
        let result = execute(request)?;
        assert_eq!(result["observations"][0]["charged"]["tokens"], 70);
        assert_eq!(result["observations"][0]["policy"]["version"], 1);
        assert_eq!(result["observations"][0]["limits"]["tokens"], 100);
        assert_eq!(std::fs::read(&ledger)?, before);
        Ok(())
    }

    #[test]
    fn original_shared_journal_keeps_distinct_member_holds_and_rejects_missing_recreation()
    -> Result<()> {
        let root = kcoder_config::create_private_temp_dir("organization-budget-original")?;
        execute(input(root.path(), "service", json!({"kind":"create"})))?;
        let first = execute(input(
            root.path(),
            "alice",
            reserve("original-alice", "alice"),
        ))?;
        assert_eq!(first["charged"]["tokens"], 70);
        let second =
            execute(input(root.path(), "bob", reserve("original-bob", "bob"))).unwrap_err();
        assert_eq!(second.to_string(), "BUDGET_EXHAUSTED");
        assert!(
            execute(input(
                root.path(),
                "bob",
                json!({"kind":"read","reservation_id":"original-alice"})
            ))
            .is_err()
        );
        let read = execute(input(
            root.path(),
            "alice",
            json!({"kind":"read","reservation_id":"original-alice"}),
        ))?;
        assert_eq!(read["charged"]["tokens"], 70);
        let ledger = root.path().join("organization-budget");
        std::fs::rename(&ledger, root.path().join("original-budget-retained"))?;
        assert!(execute(input(root.path(), "service", json!({"kind":"initialize"}))).is_err());
        assert!(!ledger.exists());
        Ok(())
    }
}
