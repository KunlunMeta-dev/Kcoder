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
        let answer = guide.io.ask("instruction_selection", "每页最多10项。toggle N 选择映射；body N 原文；preview N 编译正文；details N 格式/原因；next/prev 翻页；done 固定选择；back 退出。预览不会启用。", json!({"page":page,"items":items,"selected":selected.len(),"hasNextPage":(page+1)*10<rows.len(),"completeLaunchChain":snapshot.complete_launch_chain()}), None)?;
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
                    guide
                        .io
                        .notice("migration_guide_invalid_selection", "请选择当前页编号。")?;
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
                            "尚不能生成兼容编译正文；可单独查看原文和待处理原因，不当作已启用。",
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
                let relative = guide.io.text("instruction_target_scope", "目标为当前工作区中的已存在目录。输入相对目录，. 表示工作区根；不得输入绝对路径或 ..。不会从来源路径推断目标。", Some("."))?;
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
                        .notice(&safe_error(&error), "该映射未被接受，未选择该项。")?;
                    continue;
                    }
                };
                selected.insert(row.id.clone(), target);
            }
            _ => guide.io.notice(
                "migration_guide_invalid_selection",
                "请选择有效操作；未发布或启用指令。",
            )?,
        }
    }
}
