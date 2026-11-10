//! A reauthorization compares the original static source and target identity without new job storage.
use super::*;
use kcoder_migration::instruction_sources::{
    InstructionSourceSnapshot, ScopedInstructionDestination,
};
use sha2::{Digest, Sha256};

pub(super) struct CapturePolicy {
    pub include_descendants: bool,
    pub static_subset: bool,
    pub resource_limits: kcoder_types::migration_resource::MigrationResourceLimits,
}

pub(super) fn original(
    request: &str,
    context: &Context,
    snapshot: &InstructionSourceSnapshot,
    source_paths: (&Path, &Path),
    mapping: &[(String, ScopedInstructionDestination)],
    policy: &CapturePolicy,
) -> Result<BatchCreateIntent> {
    let (root, cwd) = source_paths;
    let summaries = snapshot.summaries();
    let mut selection = Vec::new();
    for (id, target) in mapping {
        target.verify(&context.profile)?;
        let source = summaries
            .iter()
            .find(|row| &row.id == id)
            .ok_or_else(|| anyhow::anyhow!("migration_unknown_item"))?;
        // Only an opaque fingerprint enters the public intent; Native proof fields are not output.
        let proof = format!("{:x}", Sha256::digest(serde_json::to_vec(target)?));
        selection.push((
            source.relative_path.as_str(),
            target.relative_scope(),
            proof,
        ));
    }
    selection.sort_by(|left, right| left.0.cmp(right.0));
    BatchCreateIntent::new(
        request,
        &json!({
            "kind":"terminal-scoped-instructions/2","profile":context.profile,
            "source":snapshot.source(),"root":root,"cwd":cwd,"includeDescendants":policy.include_descendants,
            "parserRevision":snapshot.semantic_revision()?,"selection":selection,
            "targetWorkspace":context.cwd,"staticSubsetConfirmed":policy.static_subset,
            "resourceLimits":policy.resource_limits
        }),
    )
}
