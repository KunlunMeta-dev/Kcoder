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
        let answer = guide.io.ask("instruction_saved", "Enter a number on this page to read the original; compiled N reads fixed compiled text; next/prev changes pages; back returns. Originals and compiled results stay separate; reads do not enable content or rescan sources.",json!({"page":page,"items":rows.iter().skip(page*10).take(10).enumerate().map(|(at,item)|json!({"number":at+1,"item":item.preview})).collect::<Vec<_>>(),"hasNextPage":(page+1)*10<rows.len()}),None)?;
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
                    guide.io.notice(
                        "migration_guide_invalid_selection",
                        "Select a number on the current page.",
                    )?;
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
                            "This legacy ordinary asset has no scoped recipe. Conversion is not guessed; you can view the original.",
                        )?,
                        Err(error) => guide.io.notice(
                            &safe_error(&error),
                            "This original record has no compatible compiled text. New sources will not be read to fill it in; you can view the original.",
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
                        "This is a legacy single-file instruction record. This entry does not replace its interpretation or refresh its source.",
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
            || !guide.io.yes(
                "instruction_next_body",
                "Explicitly read the next section of this text?",
            )?
        {
            return Ok(());
        }
        start = end;
    }
}
