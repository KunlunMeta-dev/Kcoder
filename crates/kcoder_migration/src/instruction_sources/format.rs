//! Versioned static text adaptation does not grant paths or vendor runtime authority.
#[path = "format/graph.rs"]
mod graph;
#[path = "format/syntax.rs"]
pub(super) mod syntax;
use super::{grant::InstructionSourceGrant, model::*};
use anyhow::Result;
pub(super) struct Compiled {
    pub(super) text: String,
    pub(super) exact_file_bytes: bool,
}
pub(super) fn compile(snapshot: &InstructionSourceSnapshot, path: &str) -> Result<Compiled> {
    graph::compile(snapshot, path)
}

pub(super) fn capture(
    snapshot: &mut InstructionSourceSnapshot,
    grant: &InstructionSourceGrant,
    check: &mut impl FnMut(u64) -> bool,
) -> Result<()> {
    if snapshot.root.source() != kcoder_types::migration::MigrationSourceKind::ClaudeCode {
        return Ok(());
    }
    graph::capture(snapshot, grant, check)?;
    for index in 0..snapshot.candidates.len() {
        if snapshot.candidates[index].disposition == InstructionDisposition::Selected {
            let path = snapshot.candidates[index].relative_path.clone();
            match compile(snapshot, &path) {
                Ok(compiled) if compiled.text.trim().is_empty() => {
                    snapshot.candidates[index].disposition = InstructionDisposition::Empty
                }
                Ok(_) => {}
                Err(error) => {
                    snapshot.candidates[index].disposition = InstructionDisposition::RequiresReview;
                    let code = error.to_string();
                    snapshot.candidates[index].reason_code = Some(if safe_code(&code) {
                        code
                    } else {
                        "migration_instruction_semantics_require_review".into()
                    });
                }
            }
        }
    }
    Ok(())
}
fn safe_code(value: &str) -> bool {
    value.starts_with("migration_instruction_")
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}
