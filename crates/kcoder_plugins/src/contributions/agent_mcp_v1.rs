use super::mcp::canonical_server_name;
use crate::manifest::resources::resolve_resource;
use http::header::{HeaderName, HeaderValue};
use kcoder_config::McpServerConfig;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use url::{Host, Url};

const SCHEMA_SOURCE: &str = include_str!("mcp-v1.schema.json");

pub(crate) struct Outcome {
    pub configs: Vec<McpServerConfig>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Server {
    #[serde(rename = "type")]
    transport: String,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    url: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    cwd: Option<String>,
}

struct RuntimePaths {
    root: PathBuf,
    data: PathBuf,
    root_text: String,
    data_text: String,
}

pub(crate) fn resolve(
    plugin_id: &str,
    plugin_root: &Path,
    plugin_data: &Path,
    value: Value,
) -> Result<Outcome, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "mcp.json: top-level value must be an object".to_string())?;
    let servers = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| "mcp.json: `mcpServers` must be an object".to_string())?;

    let mut top_level = value.clone();
    top_level
        .as_object_mut()
        .expect("top-level object was checked")
        .insert("mcpServers".into(), Value::Object(Map::new()));
    top_level_validator()
        .as_ref()
        .map_err(|()| "mcp.json: embedded schema is invalid".to_string())?
        .validate(&top_level)
        .map_err(|_| "mcp.json: top-level schema validation failed".to_string())?;

    let server_validator = server_validator()
        .as_ref()
        .map_err(|()| "mcp.json: embedded server schema is invalid".to_string())?;
    let mut entries = servers.iter().collect::<Vec<_>>();
    entries.sort_by_key(|(label, _)| *label);
    let mut configs = Vec::new();
    let mut warnings = Vec::new();
    let mut used_names = BTreeSet::new();
    let mut paths = None;

    for (index, (label, entry)) in entries.into_iter().enumerate() {
        let entry_path = format!("mcpServers[{index}]");
        if server_validator.validate(entry).is_err() {
            warnings.push(format!(
                "{entry_path}: invalid server schema; entry skipped"
            ));
            continue;
        }

        let Ok(server) = serde_json::from_value::<Server>(entry.clone()) else {
            warnings.push(format!(
                "{entry_path}: invalid server fields; entry skipped"
            ));
            continue;
        };
        let Ok(name) = canonical_server_name(label) else {
            warnings.push(format!("{entry_path}: invalid server name; entry skipped"));
            continue;
        };
        if used_names.contains(&name) {
            warnings.push(format!(
                "{entry_path}: normalized server name collision; entry skipped"
            ));
            continue;
        }

        let runtime_paths = if server.transport == "stdio" {
            match paths.get_or_insert_with(|| prepare_runtime_paths(plugin_root, plugin_data)) {
                Ok(paths) => Some(&*paths),
                Err(category) => {
                    warnings.push(format!("{entry_path}: {category}; entry skipped"));
                    continue;
                }
            }
        } else {
            None
        };
        match resolve_server(plugin_id, runtime_paths, name.clone(), server) {
            Ok(config) => {
                used_names.insert(name);
                configs.push(config);
            }
            Err(category) => warnings.push(format!("{entry_path}: {category}; entry skipped")),
        }
    }

    Ok(Outcome { configs, warnings })
}

fn resolve_server(
    plugin_id: &str,
    paths: Option<&RuntimePaths>,
    name: String,
    server: Server,
) -> Result<McpServerConfig, &'static str> {
    let mut config = McpServerConfig {
        name: format!("plugin.{plugin_id}.{name}"),
        transport: String::new(),
        command: String::new(),
        args: Vec::new(),
        url: String::new(),
        env: HashMap::new(),
        headers: HashMap::new(),
        policy: kcoder_types::McpServerPolicy::default(),
    };

    match server.transport.as_str() {
        "stdio" => {
            let paths = paths.ok_or("stdio runtime paths are unavailable")?;
            config.transport = "stdio".to_string();
            config.command = resolve_command(
                server
                    .command
                    .as_deref()
                    .ok_or("stdio command is missing")?,
                &paths.root,
            )?;
            config.args = server
                .args
                .iter()
                .map(|argument| {
                    if argument.contains('\0') {
                        return Err("stdio argument contains an invalid character");
                    }
                    Ok(expand_plugin_paths(
                        argument,
                        &paths.root_text,
                        &paths.data_text,
                    ))
                })
                .collect::<Result<_, _>>()?;

            for (key, value) in server.env {
                if is_reserved_environment_name(&key) {
                    return Err("stdio environment overrides a reserved variable");
                }
                if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
                    return Err("stdio environment entry is invalid");
                }
                config.env.insert(
                    key,
                    expand_plugin_paths(&value, &paths.root_text, &paths.data_text),
                );
            }
            config
                .env
                .insert("PLUGIN_ROOT".into(), paths.root_text.clone());
            config
                .env
                .insert("PLUGIN_DATA".into(), paths.data_text.clone());

            let cwd = match server.cwd.as_deref() {
                None => paths.root.to_path_buf(),
                Some(value) => resolve_cwd(
                    value,
                    &paths.root,
                    &paths.data,
                    &paths.root_text,
                    &paths.data_text,
                )?,
            };
            config.policy.cwd = Some(
                cwd.to_str()
                    .ok_or("stdio working directory is not valid UTF-8")?
                    .into(),
            );
        }
        "streamable-http" | "sse" => {
            config.transport = if server.transport == "streamable-http" {
                "http".to_string()
            } else {
                "sse".to_string()
            };
            let url = server.url.as_deref().ok_or("remote URL is missing")?;
            validate_remote_url(url)?;
            validate_headers(&server.headers)?;
            config.url = url.to_string();
            config.headers = server.headers;
        }
        _ => return Err("unsupported transport"),
    }

    Ok(config)
}

fn resolve_command(command: &str, plugin_root: &Path) -> Result<String, &'static str> {
    if let Some(command_relative) = command.strip_prefix("./") {
        let relative = normalize_relative(command_relative, false)?;
        if relative.is_empty() {
            return Err("plugin-relative command is empty");
        }
        let resource = resolve_resource(plugin_root, &format!("./{relative}"))
            .map_err(|_| "plugin-relative command escapes or traverses an unsafe path")?;
        if resource.relative_path != Path::new(&relative) {
            return Err("plugin-relative command path is not preserved exactly");
        }
        if !crate::manifest::resources::regular_file_under(plugin_root, &resource.relative_path)
            .map_err(|_| "plugin-relative command is not a safe regular file")?
        {
            return Err("plugin-relative command does not name an existing regular file");
        }
        return resource
            .absolute_path
            .to_str()
            .map(str::to_string)
            .ok_or("plugin-relative command path is not valid UTF-8");
    }
    if invalid_bare_command(command)
        || command.starts_with('/')
        || command.contains(['/', '\\', ':'])
        || matches!(command, "." | "..")
    {
        return Err("stdio command must be a bare executable or plugin-relative path");
    }
    Ok(command.to_string())
}

fn invalid_bare_command(value: &str) -> bool {
    value.is_empty()
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
}

fn resolve_cwd(
    raw: &str,
    plugin_root: &Path,
    plugin_data: &Path,
    plugin_root_text: &str,
    plugin_data_text: &str,
) -> Result<PathBuf, &'static str> {
    let (base, raw_suffix) = if let Some(suffix) = raw.strip_prefix("${PLUGIN_ROOT}/") {
        (plugin_root, suffix)
    } else if raw == "${PLUGIN_ROOT}" {
        (plugin_root, "")
    } else if let Some(suffix) = raw.strip_prefix("${PLUGIN_DATA}/") {
        (plugin_data, suffix)
    } else if raw == "${PLUGIN_DATA}" {
        (plugin_data, "")
    } else if let Some(suffix) = raw.strip_prefix("./") {
        (plugin_root, suffix)
    } else {
        return Err("stdio working directory has an unsupported anchor");
    };

    let expanded_suffix = expand_plugin_paths(raw_suffix, plugin_root_text, plugin_data_text);
    let relative = normalize_relative(&expanded_suffix, true)?;
    let candidate = if relative.is_empty() {
        base.to_path_buf()
    } else {
        let resource = resolve_resource(base, &format!("./{relative}"))
            .map_err(|_| "stdio working directory escapes or traverses an unsafe path")?;
        if resource.relative_path != Path::new(&relative) {
            return Err("stdio working directory is not preserved exactly");
        }
        resource.absolute_path
    };
    if !candidate.starts_with(base) {
        return Err("stdio working directory escapes its anchor");
    }
    match std::fs::symlink_metadata(&candidate) {
        Ok(metadata) if !metadata.is_dir() => Err("stdio working directory is not a directory"),
        Ok(_) => Ok(candidate),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(candidate),
        Err(_) => Err("stdio working directory cannot be inspected"),
    }
}

fn normalize_relative(raw: &str, allow_parent: bool) -> Result<String, &'static str> {
    if raw.contains(['\\', ':', '\0']) || raw.chars().any(char::is_control) {
        return Err("path uses an unsupported character");
    }
    let path = Path::new(raw);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::Prefix(_)))
    {
        return Err("path must be relative to its anchor");
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." if allow_parent => {
                if parts.pop().is_none() {
                    return Err("path escapes its anchor");
                }
            }
            ".." => return Err("path contains a parent traversal"),
            value => parts.push(value),
        }
    }
    Ok(parts.join("/"))
}

fn expand_plugin_paths(value: &str, plugin_root: &str, plugin_data: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut remaining = value;
    while let Some(start) = remaining.find("${") {
        output.push_str(&remaining[..start]);
        let token_start = start + 2;
        let Some(end) = remaining[token_start..].find('}') else {
            output.push_str(&remaining[start..]);
            return output;
        };
        let token_end = token_start + end;
        match &remaining[token_start..token_end] {
            "PLUGIN_ROOT" => output.push_str(plugin_root),
            "PLUGIN_DATA" => output.push_str(plugin_data),
            _ => output.push_str(&remaining[start..=token_end]),
        }
        remaining = &remaining[token_end + 1..];
    }
    output.push_str(remaining);
    output
}

fn is_reserved_environment_name(name: &str) -> bool {
    if cfg!(windows) {
        name.eq_ignore_ascii_case("PLUGIN_ROOT") || name.eq_ignore_ascii_case("PLUGIN_DATA")
    } else {
        name == "PLUGIN_ROOT" || name == "PLUGIN_DATA"
    }
}

fn validate_remote_url(value: &str) -> Result<(), &'static str> {
    let url = Url::parse(value).map_err(|_| "remote URL is invalid")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || authority_contains_userinfo(value)
    {
        return Err("remote URL must be absolute HTTP(S) without user information or fragment");
    }
    if url.scheme() == "http" && !is_loopback_url_host(url.host().ok_or("remote URL has no host")?)
    {
        return Err("remote HTTP URL must use localhost or a loopback IP literal");
    }
    Ok(())
}

fn authority_contains_userinfo(value: &str) -> bool {
    let Some((_, after_scheme)) = value.split_once("://") else {
        return false;
    };
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    authority.contains('@')
}

fn is_loopback_url_host(host: Host<&str>) -> bool {
    match host {
        Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    }
}

fn validate_headers(headers: &HashMap<String, String>) -> Result<(), &'static str> {
    let mut names = BTreeSet::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "remote headers contain an invalid or duplicate name")?;
        if !names.insert(name.as_str().to_string()) {
            return Err("remote headers contain an invalid or duplicate name");
        }
        HeaderValue::from_bytes(value.as_bytes())
            .map_err(|_| "remote headers contain an invalid field value")?;
    }
    Ok(())
}

fn safe_directory_root(path: &Path, allow_missing: bool) -> Result<PathBuf, &'static str> {
    let absolute = crate::manifest::resources::resolve_root(path)
        .map_err(|_| "directory root path is unsafe")?;
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) if metadata.is_dir() => Ok(absolute),
        Ok(_) => Err("directory root is not a directory"),
        Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => Ok(absolute),
        Err(_) => Err("directory root does not exist or cannot be inspected"),
    }
}

fn prepare_runtime_paths(
    plugin_root: &Path,
    plugin_data: &Path,
) -> Result<RuntimePaths, &'static str> {
    let root = safe_directory_root(plugin_root, false)
        .map_err(|_| "plugin root is not a safe existing directory")?;
    let data =
        safe_directory_root(plugin_data, true).map_err(|_| "plugin data path is not safe")?;
    let root_text = root
        .to_str()
        .ok_or("plugin root path is not valid UTF-8")?
        .to_string();
    let data_text = data
        .to_str()
        .ok_or("plugin data path is not valid UTF-8")?
        .to_string();
    Ok(RuntimePaths {
        root,
        data,
        root_text,
        data_text,
    })
}

fn schema_value() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| serde_json::from_str(SCHEMA_SOURCE).expect("embedded MCP schema is JSON"))
}

fn top_level_validator() -> &'static Result<jsonschema::Validator, ()> {
    static VALIDATOR: OnceLock<Result<jsonschema::Validator, ()>> = OnceLock::new();
    VALIDATOR.get_or_init(|| jsonschema::validator_for(schema_value()).map_err(|_| ()))
}

fn server_validator() -> &'static Result<jsonschema::Validator, ()> {
    static VALIDATOR: OnceLock<Result<jsonschema::Validator, ()>> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let mut schema = Map::new();
        schema.insert(
            "$schema".into(),
            Value::String("https://json-schema.org/draft/2020-12/schema".into()),
        );
        schema.insert("$ref".into(), Value::String("#/$defs/server".into()));
        schema.insert(
            "$defs".into(),
            schema_value().get("$defs").ok_or(())?.clone(),
        );
        jsonschema::validator_for(&Value::Object(schema)).map_err(|_| ())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    const SCHEMA_URI: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

    fn root_and_data() -> (TempDir, PathBuf, PathBuf) {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("plugin");
        let data = temp.path().join("data");
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        (temp, root, data)
    }

    fn document(servers: Value) -> Value {
        json!({"$schema": SCHEMA_URI, "mcpServers": servers})
    }

    fn resolve_fixture(root: &Path, data: &Path, servers: Value) -> Result<Outcome, String> {
        resolve("fixture", root, data, document(servers))
    }

    #[test]
    fn accepts_v1_transports_and_maps_streamable_http() {
        let (_temp, root, data) = root_and_data();
        std::fs::write(root.join("bin/server & helper"), "server").unwrap();
        let result = resolve_fixture(
            &root,
            &data,
            json!({
                "stdio": {"type":"stdio", "command":"node", "args":["${PLUGIN_ROOT}/x", "${OTHER}"], "env":{"CONFIG":"${PLUGIN_ROOT}/config.json", "HOME_COPY":"${HOME}"}, "cwd":"${PLUGIN_ROOT}"},
                "package path": {"type":"stdio", "command":"./bin/server & helper"},
                "literal command": {"type":"stdio", "command":"${PATH}"},
                "remote": {"type":"streamable-http", "url":"https://mcp.example.test/path", "headers":{"X-Tenant":"literal"}},
                "legacy": {"type":"sse", "url":"http://localhost:3456/sse"}
            }),
        )
        .unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.configs.len(), 5);
        let stdio = result
            .configs
            .iter()
            .find(|config| config.name.ends_with(".stdio"))
            .unwrap();
        assert_eq!(stdio.transport, "stdio");
        assert_eq!(
            stdio.args[0],
            format!("{}/x", dunce::canonicalize(&root).unwrap().display())
        );
        assert_eq!(stdio.args[1], "${OTHER}");
        assert_eq!(
            stdio.env["CONFIG"],
            format!("{}/config.json", root.display())
        );
        assert_eq!(stdio.env["HOME_COPY"], "${HOME}");
        assert_eq!(
            stdio.env["PLUGIN_ROOT"],
            dunce::canonicalize(&root).unwrap().to_string_lossy()
        );
        assert_eq!(
            stdio.env["PLUGIN_DATA"],
            dunce::canonicalize(&data).unwrap().to_string_lossy()
        );
        assert_eq!(
            stdio.policy.cwd.as_deref(),
            Some(dunce::canonicalize(&root).unwrap().to_str().unwrap())
        );
        let package_path = result
            .configs
            .iter()
            .find(|config| config.name.contains("package-path"))
            .unwrap();
        assert_eq!(
            package_path.command,
            root.join("bin").join("server & helper").to_string_lossy()
        );
        let literal_command = result
            .configs
            .iter()
            .find(|config| config.name.contains("literal-command"))
            .unwrap();
        assert_eq!(literal_command.command, "${PATH}");
        let remote = result
            .configs
            .iter()
            .find(|config| config.name.ends_with(".remote"))
            .unwrap();
        assert_eq!(remote.transport, "http");
        assert_eq!(
            remote.headers.get("X-Tenant").map(String::as_str),
            Some("literal")
        );
        assert_eq!(
            result
                .configs
                .iter()
                .find(|config| config.name.ends_with(".legacy"))
                .unwrap()
                .transport,
            "sse"
        );
    }

    #[test]
    fn rejects_invalid_document_but_skips_only_bad_server_entries() {
        let (_temp, root, data) = root_and_data();
        assert!(resolve("fixture", &root, &data, json!({"mcpServers":{}})).is_err());
        let result = resolve_fixture(
            &root,
            &data,
            json!({
                "good": {"type":"stdio", "command":"node"},
                "bad": {"type":"stdio", "command":"node", "unexpected":"no"}
            }),
        )
        .unwrap();
        assert_eq!(result.configs.len(), 1);
        assert_eq!(
            result.configs[0].policy.cwd.as_deref(),
            Some(root.to_str().unwrap())
        );
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].starts_with("mcpServers[0]:"));
        assert!(!result.warnings[0].contains("unexpected"));
    }

    #[test]
    fn stdio_paths_normalize_within_each_anchor_and_expand_once() {
        let (_temp, root, data) = root_and_data();
        std::fs::write(root.join("bin/server"), "fixture, never executed").unwrap();
        std::fs::create_dir(root.join("work")).unwrap();
        std::fs::create_dir(data.join("state")).unwrap();
        let result = resolve_fixture(
            &root,
            &data,
            json!({
                "root": {"type":"stdio", "command":"./bin/server", "cwd":"./work/../work", "args":["${PLUGIN_ROOT}/${PLUGIN_DATA}"]},
                "data": {"type":"stdio", "command":"node", "cwd":"${PLUGIN_DATA}/state"}
            }),
        )
        .unwrap();
        let root_config = result
            .configs
            .iter()
            .find(|config| config.name.ends_with(".root"))
            .unwrap();
        assert_eq!(
            root_config.policy.cwd.as_deref(),
            Some(root.join("work").to_str().unwrap())
        );
        assert_eq!(
            root_config.args[0],
            format!("{}/{}", root.display(), data.display())
        );
        let data_config = result
            .configs
            .iter()
            .find(|config| config.name.ends_with(".data"))
            .unwrap();
        assert_eq!(
            data_config.policy.cwd.as_deref(),
            Some(data.join("state").to_str().unwrap())
        );
        let missing_data = root
            .parent()
            .unwrap()
            .join("not-created")
            .join("plugin-data");
        let future = resolve_fixture(
            &root,
            &missing_data,
            json!({"x":{"type":"stdio","command":"node","cwd":"${PLUGIN_DATA}/child"}}),
        )
        .unwrap();
        assert_eq!(
            future.configs[0].env["PLUGIN_DATA"],
            missing_data.to_string_lossy()
        );
        assert_eq!(
            future.configs[0].policy.cwd.as_deref(),
            Some(missing_data.join("child").to_str().unwrap())
        );
        assert!(!missing_data.exists());
    }

    #[test]
    fn skips_command_and_cwd_traversal_or_shell_strings() {
        let (_temp, root, data) = root_and_data();
        let result = resolve_fixture(
            &root,
            &data,
            json!({
                "shell": {"type":"stdio", "command":"node -e 'bad'"},
                "absolute": {"type":"stdio", "command":"/bin/echo"},
                "dotdot": {"type":"stdio", "command":"./../outside"},
                "cwd": {"type":"stdio", "command":"node", "cwd":"${PLUGIN_ROOT}/../../outside"}
            }),
        )
        .unwrap();
        assert!(result.configs.is_empty());
        assert_eq!(result.warnings.len(), 4);
    }

    #[test]
    fn skips_reserved_env_and_unsafe_relative_resources() {
        let (_temp, root, data) = root_and_data();
        let result = resolve_fixture(
            &root,
            &data,
            json!({
                "reserved": {"type":"stdio", "command":"node", "env":{"PLUGIN_DATA":"attacker"}}
            }),
        )
        .unwrap();
        assert!(result.configs.is_empty());
        assert_eq!(result.warnings.len(), 1);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/tmp", root.join("bin/link")).unwrap();
            let result = resolve_fixture(
                &root,
                &data,
                json!({"symlink":{"type":"stdio","command":"./bin/link"}}),
            )
            .unwrap();
            assert!(result.configs.is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn skips_plugin_relative_hard_link_commands() {
        let (_temp, root, data) = root_and_data();
        std::fs::write(root.join("bin/real"), "server").unwrap();
        std::fs::hard_link(root.join("bin/real"), root.join("bin/alias")).unwrap();
        let result = resolve_fixture(
            &root,
            &data,
            json!({"linked":{"type":"stdio","command":"./bin/alias"}}),
        )
        .unwrap();
        assert!(result.configs.is_empty());
        assert_eq!(result.warnings.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_working_directory() {
        let (_temp, root, data) = root_and_data();
        let external = root.parent().unwrap().join("outside");
        std::fs::create_dir(&external).unwrap();
        std::os::unix::fs::symlink(&external, root.join("work-link")).unwrap();
        let result = resolve_fixture(
            &root,
            &data,
            json!({"linked":{"type":"stdio","command":"node","cwd":"${PLUGIN_ROOT}/work-link"}}),
        )
        .unwrap();
        assert!(result.configs.is_empty());
        assert_eq!(result.warnings.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn package_paths_preserve_significant_trailing_spaces() {
        let (_temp, root, data) = root_and_data();
        std::fs::create_dir(root.join("work ")).unwrap();
        std::fs::write(root.join("bin/server "), "server").unwrap();
        let result = resolve_fixture(
            &root,
            &data,
            json!({
                "command": {"type":"stdio","command":"./bin/server "},
                "cwd": {"type":"stdio","command":"node","cwd":"./work "}
            }),
        )
        .unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.configs.len(), 2);
        let command = result
            .configs
            .iter()
            .find(|config| config.name.ends_with(".command"))
            .unwrap();
        assert_eq!(command.command, root.join("bin/server ").to_str().unwrap());
        let cwd = result
            .configs
            .iter()
            .find(|config| config.name.ends_with(".cwd"))
            .unwrap();
        assert_eq!(cwd.policy.cwd.as_deref(), root.join("work ").to_str());
    }

    #[test]
    fn remote_urls_and_headers_follow_v1_constraints() {
        let (_temp, root, data) = root_and_data();
        let result = resolve_fixture(
            &root,
            &data,
            json!({
                "tls": {"type":"streamable-http", "url":"https://mcp.example.test", "headers":{"X-Test":"${PLUGIN_ROOT}"}},
                "loopback": {"type":"streamable-http", "url":"http://[::1]:3000/mcp"},
                "plain_remote": {"type":"sse", "url":"http://mcp.example.test/sse"},
                "userinfo": {"type":"streamable-http", "url":"https://user:pass@mcp.example.test/mcp"},
                "empty_userinfo": {"type":"streamable-http", "url":"https://@mcp.example.test/mcp"},
                "fragment": {"type":"streamable-http", "url":"https://mcp.example.test/mcp#"},
                "duplicate_header": {"type":"streamable-http", "url":"https://mcp.example.test", "headers":{"X-Test":"a","x-test":"b"}},
                "bad_header": {"type":"streamable-http", "url":"https://mcp.example.test", "headers":{"X-Test":"bad\r\nValue"}}
            }),
        )
        .unwrap();
        assert_eq!(result.configs.len(), 2);
        let tls = result
            .configs
            .iter()
            .find(|config| config.name.ends_with(".tls"))
            .unwrap();
        assert_eq!(tls.headers["X-Test"], "${PLUGIN_ROOT}");
        assert_eq!(
            result
                .configs
                .iter()
                .find(|config| config.name.ends_with(".loopback"))
                .unwrap()
                .transport,
            "http"
        );
        assert_eq!(result.warnings.len(), 6);
    }

    #[test]
    fn rejects_top_level_extras_and_noncanonical_schema() {
        let (_temp, root, data) = root_and_data();
        let mut extra = document(json!({}));
        extra
            .as_object_mut()
            .unwrap()
            .insert("other".into(), Value::Bool(true));
        assert!(resolve("fixture", &root, &data, extra).is_err());
        let mut unsupported = document(json!({}));
        unsupported.as_object_mut().unwrap().insert(
            "$schema".into(),
            Value::String("https://example.test/mcp.schema.json".into()),
        );
        assert!(resolve("fixture", &root, &data, unsupported).is_err());
    }

    #[test]
    fn placeholder_expansion_is_exact_and_non_recursive() {
        assert_eq!(
            expand_plugin_paths(
                "x${PLUGIN_ROOT}y${UNKNOWN}z${OTHER:-${PLUGIN_ROOT}}",
                "/root/${PLUGIN_DATA}",
                "/data"
            ),
            "x/root/${PLUGIN_DATA}y${UNKNOWN}z${OTHER:-${PLUGIN_ROOT}}"
        );
        assert_eq!(
            expand_plugin_paths("${PLUGIN_ROOT}/bin", "/tmp/${PLUGIN_DATA}/plugin", "/data"),
            "/tmp/${PLUGIN_DATA}/plugin/bin"
        );
    }
}
