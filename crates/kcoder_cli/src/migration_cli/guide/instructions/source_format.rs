//! A partial original request must retain its chosen parser, never infer or upgrade it.
use super::*;
pub(super) fn choose(guide: &Guide<'_>, recovering: bool) -> Result<bool> {
    if !recovering {
        return Ok(true);
    }
    loop {
        match guide.io.ask("instruction_format","Choose the interpretation used by the original capture request. legacy-v1 only restores the old interpretation; static-v2 is the confirmed new static subset. A mismatch with the original intent is rejected; resume cannot upgrade an old source.",json!([
            {"value":"legacy-v1","label":"Legacy v1 static file snapshot (preserve the original interpretation)"},
            {"value":"static-v2","label":"New v2 confirmed static subset (in-root references/comment rules)"}
        ]),None)?.as_str() {
            "legacy-v1"=>return Ok(false),"static-v2"=>return Ok(true),
            _=>guide.io.notice("migration_guide_invalid_selection","Select the original request format; it is not inferred or rebound automatically.")?,
        }
    }
}
pub(super) fn confirm(guide: &Guide<'_>) -> Result<()> {
    ensure!(guide.io.yes("instruction_static_subset","Explicitly use the authorized static file subset? Codex is plain Markdown; Claude expands only safe in-root static references and handles code/comments. Managed/env/CLI/plugin choices are not observed; unknown semantics remain pending. Paths outside authorization are not read and system privileges are not expanded.")?,"migration_instruction_static_subset_confirmation_required");
    Ok(())
}
