use super::api::*;
use anyhow::ensure;
use kcoder_app_protocol::integrations::knowledge::*;
use kcoder_memory::integrations::knowledge::MemoryReviewStore;
use kcoder_types::integrations::{core::*, knowledge::*};
use serde_json::json;

pub fn handle_memory(
    method: &str,
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &MemoryReviewStore,
) -> IntegrationReply {
    let mutation = matches!(
        method,
        "proposeMemory" | "reviewMemory" | "setMemoryEnabled"
    );
    let action = if mutation {
        "memory.write"
    } else {
        "memory.read"
    };
    let resource = KnowledgeResource {
        kind: "memory",
        id: "current-owner".into(),
        owner: store.owner().clone(),
    };
    dispatch(request, ctx, mutation, action, resource, || {
        ensure!(
            store.owner() == &KnowledgeOwner::from(ctx.scope),
            "MEMORY_SCOPE_MISMATCH"
        );
        match method {
            "listMemories" => {
                let p: MemoryListParams = parse(request)?;
                Ok((
                    json!({"page":store.list(p.after.as_deref(),p.include_candidates)?}),
                    None,
                ))
            }
            "readMemory" => {
                let p: MemoryReadParams = parse(request)?;
                let m = store.read(&p.memory_id)?;
                let rev = m.revision.to_string();
                Ok((json!({"memory":m}), Some(rev)))
            }
            "proposeMemory" => {
                ensure!(ctx.explicit_user_action, "MEMORY_EXPLICIT_REQUEST_REQUIRED");
                let mut p: MemoryProposeParams = parse(request)?;
                // A native control request is the source. Client claims cannot forge transcript provenance.
                p.proposal.origin = MemoryOrigin::Manual;
                p.proposal.provenance = vec![MemoryProvenance {
                    kind: "native_user_request".into(),
                    source_id: operation(request)?.into(),
                    source_revision: "1".into(),
                    description: "Explicit authenticated memory proposal".into(),
                }];
                let m = store.propose(operation(request)?, p.proposal, ctx.now_ms)?;
                let rev = m.revision.to_string();
                Ok((json!({"memory":m}), Some(rev)))
            }
            "reviewMemory" => {
                ensure!(ctx.explicit_user_action, "MEMORY_EXPLICIT_REQUEST_REQUIRED");
                let p: MemoryReviewParams = parse(request)?;
                let m = store.review(
                    operation(request)?,
                    &p.memory_id,
                    revision(request, false)?,
                    p.review,
                    ctx.now_ms,
                )?;
                let rev = m.revision.to_string();
                Ok((json!({"memory":m}), Some(rev)))
            }
            "setMemoryEnabled" => {
                ensure!(ctx.explicit_user_action, "MEMORY_EXPLICIT_REQUEST_REQUIRED");
                let p: MemoryEnableParams = parse(request)?;
                let m = store.set_enabled(
                    operation(request)?,
                    &p.memory_id,
                    revision(request, false)?,
                    p.enabled,
                    ctx.now_ms,
                )?;
                let rev = m.revision.to_string();
                Ok((json!({"memory":m}), Some(rev)))
            }
            _ => anyhow::bail!("KNOWLEDGE_METHOD_UNSUPPORTED"),
        }
    })
}
/// Private native management operations; they are not additional frozen P-MEMORY methods.
pub fn handle_memory_management(
    method: &str,
    request: &IntegrationRequest,
    ctx: &KnowledgeHostContext<'_>,
    store: &MemoryReviewStore,
) -> IntegrationReply {
    let resource = KnowledgeResource {
        kind: "memory",
        id: "current-owner".into(),
        owner: store.owner().clone(),
    };
    if method == "readMemoryTaskSnapshot" {
        return dispatch(request, ctx, false, "memory.read", resource, || {
            ensure!(
                store.owner() == &KnowledgeOwner::from(ctx.scope),
                "MEMORY_SCOPE_MISMATCH"
            );
            let task = request
                .payload
                .get("taskId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("KNOWLEDGE_INVALID_PAYLOAD"))?;
            let snapshot = store.read_task_snapshot(task)?;
            if let Some(snapshot) = &snapshot {
                for memory in &snapshot.memories {
                    let item = KnowledgeResource {
                        kind: "memory",
                        id: memory.id.clone(),
                        owner: memory.owner.clone(),
                    };
                    ctx.check(request, false, "memory.read", &item)?;
                }
            }
            Ok((json!({"snapshot":snapshot}), None))
        });
    }
    dispatch(request, ctx, true, "memory.manage", resource, || {
        ensure!(ctx.explicit_user_action, "MEMORY_EXPLICIT_REQUEST_REQUIRED");
        ensure!(
            store.owner() == &KnowledgeOwner::from(ctx.scope),
            "MEMORY_SCOPE_MISMATCH"
        );
        let m = match method {
            "editMemory" => {
                let p: MemoryEditParams = parse(request)?;
                store.edit(
                    operation(request)?,
                    &p.memory_id,
                    revision(request, false)?,
                    p.content,
                    ctx.now_ms,
                )?
            }
            "removeMemory" => {
                let p: MemoryReadParams = parse(request)?;
                store.remove(
                    operation(request)?,
                    &p.memory_id,
                    revision(request, false)?,
                    ctx.now_ms,
                )?
            }
            _ => anyhow::bail!("KNOWLEDGE_METHOD_UNSUPPORTED"),
        };
        let rev = m.revision.to_string();
        Ok((json!({"memory":m}), Some(rev)))
    })
}
