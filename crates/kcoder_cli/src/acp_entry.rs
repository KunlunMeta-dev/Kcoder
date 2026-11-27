//! Early protocol entry; normal configuration belongs to the owned session backend.
use crate::{Cli, Commands};
use anyhow::Result;
use clap::{CommandFactory, Parser, parser::ValueSource};
use std::ffi::OsString;

pub(crate) fn try_run(args: &[OsString]) -> Result<bool> {
    if args
        .get(1)
        .is_some_and(|arg| arg == "--internal-native-remote-read-v1")
    {
        crate::app_server::run_native_remote_read(args)?;
        return Ok(true);
    }
    if !args.iter().skip(1).any(|arg| arg == "acp") {
        return Ok(false);
    }
    match Cli::try_parse_from(args) {
        Ok(cli) if matches!(cli.command, Some(Commands::Acp)) => {
            let app_server = launch_config(args, &cli)?;
            let runtime = tokio::runtime::Runtime::new()?;
            let result = runtime.block_on(kcoder_acp::serve(
                tokio::io::BufReader::new(tokio::io::stdin()),
                tokio::io::stdout(),
                kcoder_acp::AgentInfo {
                    version: kcoder_cli_commands::build_identity::version().into(),
                    app_server: Some(app_server),
                },
            ));
            // Tokio stdin can retain a blocking read after the protocol future
            // stops. Owned sessions are settled by serve before this point; do
            // not let that unrelated stdin thread make process exit unbounded.
            runtime.shutdown_timeout(std::time::Duration::from_secs(1));
            result?;
            Ok(true)
        }
        Err(error) if args.get(1).is_some_and(|arg| arg == "acp") => error.exit(),
        _ => Ok(false),
    }
}

/// Forward only explicit configuration overrides; inherited environment keeps its priority.
fn launch_config(args: &[OsString], cli: &Cli) -> Result<kcoder_acp::AppServerConfig> {
    anyhow::ensure!(
        cli.resume.is_none() && !cli.orchestrate && cli.required_skills.is_empty(),
        "ACP does not support --resume, --orchestrate or --require-skill yet"
    );
    let command = Cli::command();
    let matches = command.clone().try_get_matches_from(args)?;
    let base = std::env::current_dir()?;
    let mut forwarded = vec![
        OsString::from("app-server"),
        OsString::from("--internal-acp-backend"),
    ];
    for argument in command
        .get_arguments()
        .filter(|argument| argument.is_global_set())
    {
        let id = argument.get_id().as_str();
        if matches.value_source(id) != Some(ValueSource::CommandLine)
            || matches!(
                id,
                "cwd" | "json" | "no_alt_screen" | "internal_acp_backend"
            )
        {
            continue;
        }
        let Some(long) = argument.get_long() else {
            continue;
        };
        if argument.get_action().takes_values() {
            if let Some(values) = matches.get_raw(id) {
                for value in values {
                    forwarded.push(format!("--{long}").into());
                    if matches!(id, "settings_files" | "credential_env_file") {
                        let path = std::path::Path::new(value);
                        forwarded.push(
                            if path.is_absolute() {
                                path.to_path_buf()
                            } else {
                                base.join(path)
                            }
                            .into_os_string(),
                        );
                    } else {
                        forwarded.push(value.to_owned());
                    }
                }
            }
        } else if matches.get_flag(id) {
            forwarded.push(format!("--{long}").into());
        }
    }
    #[cfg(target_os = "linux")]
    let executable = std::path::PathBuf::from(format!("/proc/{}/exe", std::process::id()));
    #[cfg(not(target_os = "linux"))]
    let executable = std::env::current_exe()?;
    Ok(kcoder_acp::AppServerConfig {
        executable,
        args: forwarded,
        environment: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forwarding_uses_parsed_arguments_instead_of_removing_a_word_named_acp() {
        let args: Vec<OsString> = [
            "kcoder",
            "--model",
            "acp",
            "acp",
            "--settings-file",
            "overlay.json",
            "--max-tokens",
            "123",
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        let cli = Cli::try_parse_from(&args).unwrap();
        let launch = launch_config(&args, &cli).unwrap();
        assert_eq!(launch.args[0], "app-server");
        let parsed =
            Cli::try_parse_from(std::iter::once(OsString::from("kcoder")).chain(launch.args))
                .unwrap();
        assert_eq!(parsed.model.as_deref(), Some("acp"));
        assert!(parsed.internal_acp_backend);
        assert!(
            !Cli::try_parse_from(["kcoder", "app-server"])
                .unwrap()
                .internal_acp_backend
        );
        assert!(
            !Cli::command()
                .render_long_help()
                .to_string()
                .contains("--internal-acp-backend")
        );
        assert_eq!(parsed.max_tokens, Some(123));
        assert!(parsed.settings_files[0].is_absolute());
        assert!(matches!(parsed.command, Some(Commands::AppServer { .. })));
    }
}
