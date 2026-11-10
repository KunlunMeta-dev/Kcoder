//! Saved previews read the original job-owned snapshot, including unsupported source bytes.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
pub(in crate::migration_cli::guide) fn saved(guide: &Guide<'_>, job: &MigrationJob) -> Result<()> {
    let rows = job
        .inventory
        .items
        .iter()
        .filter(|item| {
            item.preview.category == kcoder_types::migration::MigrationCategory::Instructions
        })
        .collect::<Vec<_>>();
    let mut page = 0;
    loop {
        guide.fresh()?;
        let answer = guide.io.ask("instruction_saved", "本页编号读原件；compiled N 读固定编译正文；next/prev 翻页；back 返回。原文与编译结果分开，读取不启用或重新扫描来源。",json!({"page":page,"items":rows.iter().skip(page*10).take(10).enumerate().map(|(at,item)|json!({"number":at+1,"item":item.preview})).collect::<Vec<_>>(),"hasNextPage":(page+1)*10<rows.len()}),None)?;
        match answer.as_str() {
            "back" => return Ok(()),
            "next" if (page + 1) * 10 < rows.len() => page += 1,
            "prev" if page > 0 => page -= 1,
            _ => {
                let compiled = answer.starts_with("compiled ");
                let number = answer.strip_prefix("compiled ").unwrap_or(&answer);
                let Some(item) = number
                    .parse::<usize>()
                    .ok()
                    .filter(|n| (1..=10).contains(n))
                    .and_then(|n| rows.get(page * 10 + n - 1))
                else {
                    guide
                        .io
                        .notice("migration_guide_invalid_selection", "请选择当前页编号。")?;
                    continue;
                };
                if compiled {
                    match guide
                        .store()?
                        .instruction_compiled_snapshot(&job.job_id, &item.preview.id)
                    {
                        Ok(Some(text)) => compiled_body(guide, &text)?,
                        Ok(None) => guide.io.notice(
                            "migration_instruction_legacy_snapshot",
                            "该旧普通资产没有作用域配方，不猜测转换；可查看原件。",
                        )?,
                        Err(error) => guide.io.notice(
                            &safe_error(&error),
                            "该原记录尚无兼容编译正文，不读取新来源补齐；可查看原件。",
                        )?,
                    }
                    continue;
                }
                match guide
                    .store()?
                    .instruction_source_snapshot(&job.job_id, &item.preview.id)?
                {
                    Some(bytes) => body(guide, &bytes)?,
                    None => guide.io.notice(
                        "migration_instruction_legacy_snapshot",
                        "这是旧单文件指令记录；本入口不会替换其解释或刷新来源。",
                    )?,
                }
            }
        }
    }
}
pub(super) fn body(guide: &Guide<'_>, bytes: &[u8]) -> Result<()> {
    body_view(guide, bytes, "original")
}
pub(super) fn compiled_body(guide: &Guide<'_>, text: &str) -> Result<()> {
    body_view(guide, text.as_bytes(), "compiled")
}
fn body_view(guide: &Guide<'_>, bytes: &[u8], representation: &str) -> Result<()> {
    let text = std::str::from_utf8(bytes).ok();
    let mut start = 0;
    loop {
        guide.fresh()?;
        let mut end = (start + 16 * 1024).min(bytes.len());
        if let Some(text) = text {
            while !text.is_char_boundary(end) {
                end -= 1;
            }
        }
        guide.io.state("instruction_body",&json!({"representation":representation,"offset":start,"totalBytes":bytes.len(),"text":text.map(|text|&text[start..end]),"bytesBase64":text.is_none().then(||STANDARD.encode(&bytes[start..end])),"enabledByPreview":false}))?;
        if end == bytes.len()
            || !guide
                .io
                .yes("instruction_next_body", "是否明确读取该正文的下一段？")?
        {
            return Ok(());
        }
        start = end;
    }
}
