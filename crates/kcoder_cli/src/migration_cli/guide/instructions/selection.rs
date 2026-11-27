//! Source order and target mappings are reviewed without deriving target paths from source paths.
use super::*;
use kcoder_migration::instruction_sources::{
    InstructionDisposition, InstructionSourceSnapshot, ScopedInstructionDestination,
};
use std::collections::BTreeMap;
pub(super) fn choose(
    guide: &Guide<'_>,
    snapshot: &InstructionSourceSnapshot,
) -> Result<Vec<(String, ScopedInstructionDestination)>> {
    let rows = snapshot.summaries();
    let mut selected = BTreeMap::<String, ScopedInstructionDestination>::new();
    let mut page = 0;
    loop {
        guide.fresh()?;
        let items = rows.iter().skip(page*10).take(10).enumerate().map(|(at,row)|json!({"number":at+1,"sourceId":row.id,"relativePath":row.relative_path,"relativeScope":row.relative_scope,"role":row.role,"trigger":row.trigger,"disposition":row.disposition,"bytes":row.bytes,"targetRelativeScope":selected.get(&row.id).map(ScopedInstructionDestination::relative_scope)})).collect::<Vec<_>>();
        let answer = guide.io.ask("instruction_selection", "Up to 10 items per page. toggle N selects a mapping; body N reads the original; preview N reads compiled text; details N shows format/reasons; next/prev changes pages; done fixes the selection; back exits. Preview does not enable content.", json!({"page":page,"items":items,"selected":selected.len(),"hasNextPage":(page+1)*10<rows.len(),"completeLaunchChain":snapshot.complete_launch_chain()}), None)?;
        let mut words = answer.split_whitespace();
        match words.next().unwrap_or("") {
            "back" => return Ok(Vec::new()),
            "done" => return Ok(selected.into_iter().collect()),
            "next" if (page + 1) * 10 < rows.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            verb @ ("toggle" | "body" | "preview" | "details") => {
                let Some(row) = words
                    .next()
                    .and_then(|n| n.parse::<usize>().ok())
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| rows.get(page * 10 + n - 1))
                else {
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select a number on the current page.",
                    )?;
                    continue;
                };
                if verb == "body" {
                    super::saved::body(guide, &snapshot.original_bytes(&row.id)?)?;
                    continue;
                }
                if verb == "details" {
                    guide.io.state("instruction_report",&json!({"relativePath":row.relative_path,"relativeScope":row.relative_scope,"role":row.role,"trigger":row.trigger,"disposition":row.disposition,"reasonCode":row.reason_code,"sourceFormat":snapshot.format_revision(),"bytes":row.bytes,"completeAuthorizedStaticChain":snapshot.complete_launch_chain()}))?;
                    continue;
                }
                if verb == "preview" {
                    match snapshot.compiled_text(&row.id) {
                        Ok(text) => super::saved::compiled_body(guide, &text)?,
                        Err(error) => guide.io.notice(
                            &safe_error(&error),
                            "Compatible compiled text is not available yet. Review the original and pending reasons separately; this does not mean it is enabled.",
                        )?,
                    }
                    continue;
                }
                if selected.remove(&row.id).is_some() {
                    continue;
                }
                ensure!(
                    !matches!(
                        row.disposition,
                        InstructionDisposition::Empty | InstructionDisposition::Shadowed
                    ),
                    "migration_instruction_candidate_inactive"
                );
                let relative = guide.io.text("instruction_target_scope", "The target must be an existing directory in the current workspace. Enter a relative directory; . means the workspace root. Absolute paths and .. are not allowed. The target is not inferred from the source path.", Some("."))?;
                let context = guide.fresh()?;
                let destination =
                    kcoder_migration::instruction_sources::InstructionDestination::capture(
                        &context.profile,
                        &context.cwd,
                    )?;
                let relative = if relative == "." {
                    String::new()
                } else {
                    relative
                };
                let target = match
                    kcoder_migration::instruction_sources::ScopedInstructionDestination::capture(
                        &destination,
                        &relative,
                    )
                {
                    Ok(target) => target,
                    Err(error) => {
                    guide
                        .io
                        .notice(&safe_error(&error), "The mapping was not accepted and the item was not selected.")?;
                    continue;
                    }
                };
                selected.insert(row.id.clone(), target);
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "Choose a valid operation; instructions were not published or enabled.",
            )?,
        }
    }
}
