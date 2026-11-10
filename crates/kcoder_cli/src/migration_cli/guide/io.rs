//! Answers are bounded and tied to one live prompt; raw input is never diagnostic output.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{BufRead, IsTerminal, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
    },
    time::Duration,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    id: String,
    value: String,
}

pub(in crate::migration_cli) struct GuideIo {
    jsonl: bool,
    lines: Receiver<Result<Vec<u8>>>,
    cancelled: Arc<AtomicBool>,
}
impl GuideIo {
    pub fn open(jsonl: bool, cancelled: Arc<AtomicBool>) -> Result<Self> {
        ensure!(
            jsonl || std::io::stdin().is_terminal(),
            "migration_guide_tty_required_or_jsonl"
        );
        let (tx, lines) = mpsc::sync_channel(1);
        // This process owns stdin. A bounded reader keeps SIGINT responsive even while a
        // terminal read blocks; returning from the CLI ends its exact process and reader.
        std::thread::spawn(move || {
            let mut input = std::io::stdin().lock();
            loop {
                let mut line = Vec::new();
                let result = match (&mut input).take(8193).read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) if line.len() <= 8192 => Ok(line),
                    _ => Err(anyhow::anyhow!("migration_guide_invalid_answer")),
                };
                let failed = result.is_err();
                if tx.send(result).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            jsonl,
            lines,
            cancelled,
        })
    }
    pub fn active(&self) -> Result<()> {
        ensure!(
            !self.cancelled.load(Ordering::Acquire),
            "migration_guide_cancelled_read_original_job"
        );
        Ok(())
    }
    fn emit(&self, value: &impl Serialize) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        ensure!(
            bytes.len() <= 2 * 1024 * 1024,
            "migration_guide_frame_budget_exceeded"
        );
        let mut output = std::io::stdout().lock();
        output.write_all(&bytes)?;
        output.write_all(b"\n")?;
        output.flush()?;
        Ok(())
    }
    pub fn notice(&self, code: &str, text: &str) -> Result<()> {
        if self.jsonl {
            self.emit(&json!({"type":"notice","code":code,"message":text}))
        } else {
            println!("{text}");
            Ok(())
        }
    }
    pub fn state(&self, kind: &str, value: &impl Serialize) -> Result<()> {
        if self.jsonl {
            self.emit(&json!({"type":kind,"result":value}))
        } else {
            println!("{}", serde_json::to_string_pretty(value)?);
            Ok(())
        }
    }
    pub fn ask(
        &self,
        code: &str,
        message: &str,
        choices: Value,
        default: Option<&str>,
    ) -> Result<String> {
        self.active()?;
        let id = uuid::Uuid::new_v4().to_string();
        if self.jsonl {
            self.emit(&json!({"type":"prompt","id":id,"code":code,"message":message,"choices":choices,"default":default}))?;
        } else {
            println!("{message}");
            if !choices.is_null() {
                println!("{}", serde_json::to_string_pretty(&choices)?);
            }
            if let Some(value) = default {
                println!("默认：{}", serde_json::to_string(value)?);
            }
            print!("> ");
            std::io::stdout().flush()?;
        }
        loop {
            self.active()?;
            let line = match self.lines.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => line?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => anyhow::bail!("migration_guide_input_closed_read_original_job"),
            };
            let value = if self.jsonl {
                let answer: Answer = serde_json::from_slice(&line)
                    .map_err(|_| anyhow::anyhow!("migration_guide_invalid_answer"))?;
                if answer.id != id {
                    self.notice(
                        "migration_guide_stale_answer",
                        "回答已过期，未执行操作；请使用当前 promptId。",
                    )?;
                    continue;
                }
                answer.value
            } else {
                String::from_utf8(line)
                    .map_err(|_| anyhow::anyhow!("migration_guide_invalid_answer"))?
            };
            ensure!(
                value.len() <= 8192
                    && !value
                        .chars()
                        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t'),
                "migration_guide_invalid_answer"
            );
            let value = value.trim();
            self.active()?;
            return Ok(if value.is_empty() {
                default.unwrap_or("").to_owned()
            } else {
                value.to_owned()
            });
        }
    }
    pub fn yes(&self, code: &str, message: &str) -> Result<bool> {
        Ok(self.ask(
            code,
            message,
            json!([{"value":"yes","label":"明确同意"},{"value":"no","label":"不同意"}]),
            Some("no"),
        )? == "yes")
    }
    pub fn text(&self, code: &str, message: &str, default: Option<&str>) -> Result<String> {
        self.ask(code, message, Value::Null, default)
    }
    pub fn number(&self, code: &str, message: &str, default: Option<u64>) -> Result<u64> {
        let default = default.map(|n| n.to_string());
        for _ in 0..10 {
            if let Ok(value) = self.text(code, message, default.as_deref())?.parse::<u64>()
                && value > 0
            {
                return Ok(value);
            }
            self.notice(
                "migration_guide_invalid_number",
                "请输入明确的正整数；不会猜测模型额度。",
            )?;
        }
        anyhow::bail!("migration_guide_invalid_answer")
    }
}

pub(in crate::migration_cli) fn safe_error(error: &anyhow::Error) -> String {
    error
        .chain()
        .map(ToString::to_string)
        .find(|text| {
            [
                "migration_",
                "imported_context_",
                "imported_memory_",
                "plugin_",
                "provider_",
                "asset_",
                "settings_",
                "credential_",
            ]
            .iter()
            .any(|p| text.starts_with(p))
                && text.len() <= 160
                && text
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
        .unwrap_or_else(|| "migration_guide_operation_failed_use_status".into())
}
