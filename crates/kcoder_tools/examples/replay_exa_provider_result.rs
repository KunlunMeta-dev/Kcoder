//! Offline replay of a captured Exa MCP CallToolResult, with no network or model calls.
use kcoder_tools::web_search::provider_results::{MAX_EXA_OUTPUT_BYTES, parse_exa_advanced_output};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf, process::ExitCode};

fn main() -> ExitCode {
    let paths = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if paths.is_empty() {
        eprintln!("usage: replay_exa_provider_result <captured-call-tool-result.json>...");
        return ExitCode::FAILURE;
    }
    let mut observations = Vec::new();
    for path in paths {
        let replay = (|| -> Result<Value, Box<dyn std::error::Error>> {
            let limit = MAX_EXA_OUTPUT_BYTES * 2;
            let mut bytes = Vec::new();
            std::fs::File::open(&path)?
                .take((limit + 1) as u64)
                .read_to_end(&mut bytes)?;
            if bytes.len() > limit {
                return Err("captured result exceeds replay input budget".into());
            }
            let artifact: Value = serde_json::from_slice(&bytes)?;
            let output = artifact.pointer("/frame/result").unwrap_or(&artifact);
            Ok(match parse_exa_advanced_output(output) {
                Ok(page) => json!({
                    "path":path, "parsed":true, "results":page.results.len(),
                    "incomplete":page.incomplete,
                    "records":page.results.iter().map(|hit| json!({
                        "url":hit.url,"publishedAt":hit.published_at,"author":hit.author,
                        "titleContainsControl":hit.title.chars().any(char::is_control),
                        "snippetBytes":hit.snippet.len(),
                    })).collect::<Vec<_>>()
                }),
                Err(error) => {
                    json!({"path":path,"parsed":false,"kind":error.kind,"message":error.message,"requestSent":error.request_sent})
                }
            })
        })();
        match replay {
            Ok(value) => observations.push(value),
            Err(error) => {
                eprintln!("offline replay failed for {}: {error}", path.display());
                return ExitCode::FAILURE;
            }
        }
    }
    println!(
        "{}",
        json!({"networkRequests":0,"modelCalls":0,"observations":observations})
    );
    ExitCode::SUCCESS
}
