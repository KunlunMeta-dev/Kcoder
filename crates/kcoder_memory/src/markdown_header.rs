//! New headers use explicitly marked JSON strings; unmarked legacy values stay literal.
use anyhow::{Context, Result};

const FORMAT_KEY: &str = "kcoder_memory_format";
const JSON_STRINGS: &str = "json-string-v1";

#[derive(Default)]
pub(super) struct Header {
    pub category: Option<String>,
    pub source: Option<String>,
    pub created_at: u64,
}

pub(super) fn encode(category: &str, created_at: u64, source: &str) -> Result<String> {
    let category = serde_json::to_string(category).context("failed to encode memory category")?;
    let source = serde_json::to_string(source).context("failed to encode memory source")?;
    Ok(format!(
        "---\n{FORMAT_KEY}: {JSON_STRINGS}\ncategory: {category}\ncreated_at: {created_at}\nsource: {source}\n---\n"
    ))
}

fn fields(header: &str) -> impl Iterator<Item = (&str, &str)> {
    header
        .lines()
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim(), value.trim()))
}

pub(super) fn parse(header: &str) -> Result<Header> {
    let format = fields(header)
        .filter(|(key, _)| *key == FORMAT_KEY)
        .map(|(_, value)| value)
        .last();
    let encoded = match format {
        None => false,
        Some(JSON_STRINGS) => true,
        Some(_) => anyhow::bail!("unsupported project memory metadata encoding"),
    };
    let mut output = Header::default();
    for (key, value) in fields(header) {
        match key {
            "category" => {
                output.category = Some(if encoded {
                    serde_json::from_str::<String>(value)
                        .context("invalid encoded memory category")?
                } else {
                    value.to_string()
                })
            }
            "source" => {
                output.source = Some(if encoded {
                    serde_json::from_str::<String>(value)
                        .context("invalid encoded memory source")?
                } else {
                    value.to_string()
                })
            }
            "created_at" => output.created_at = value.parse().unwrap_or(0),
            _ => {}
        }
    }
    Ok(output)
}
