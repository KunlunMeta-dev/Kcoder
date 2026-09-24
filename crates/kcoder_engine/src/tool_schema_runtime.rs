use super::*;

pub(super) fn build_tool_caches(
    tools: &ToolRegistry,
) -> (
    Vec<kcoder_types::ToolDefinition>,
    HashMap<String, serde_json::Value>,
    crate::tool_input_hints::ToolInputHints,
) {
    let mut definitions = Vec::new();
    let mut input_schemas = HashMap::new();
    let mut hints = crate::tool_input_hints::ToolInputHints::new(tools.revision());
    for tool in tools.all() {
        let name = tool.name();
        let input_schema = tool.input_schema();
        let input_format = tool.input_format();
        let model_schema = model_schema_for_tool_input(&name, &input_schema, &input_format);
        let static_description = tool.description();
        let description =
            kcoder_tools::description_with_input_shape(&static_description, &model_schema);
        let suffix = match &input_format {
            kcoder_tools::ToolInputFormat::Json => {
                description[static_description.trim().len()..].to_owned()
            }
            _ => description_for_model_with_input_format("", &model_schema, &input_format),
        };
        hints.insert(&name, &input_format, suffix);
        input_schemas.insert(name.clone(), input_schema);
        definitions.push(kcoder_types::ToolDefinition {
            name,
            description,
            input_schema: model_schema,
        });
    }
    (definitions, input_schemas, hints)
}

pub(super) fn model_schema_for_tool_input(
    tool_name: &str,
    schema: &Value,
    format: &kcoder_tools::ToolInputFormat,
) -> Value {
    match format {
        kcoder_tools::ToolInputFormat::Json => {
            let schema = kcoder_tools::schema_with_parameter_guidance(tool_name, schema);
            kcoder_tools::inline_local_schema_refs_for_model(&schema)
        }
        kcoder_tools::ToolInputFormat::Freeform { syntax, .. } => serde_json::json!({
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": format!("Raw FREEFORM tool input using {syntax}. This field is not a natural-language description; it is the complete raw body to execute. Do not send explanatory prose outside the freeform payload.")
                }
            },
            "required": ["description"],
            "additionalProperties": false
        }),
    }
}

pub(super) fn description_for_model_with_input_format(
    description: &str,
    schema: &Value,
    format: &kcoder_tools::ToolInputFormat,
) -> String {
    match format {
        kcoder_tools::ToolInputFormat::Json => {
            kcoder_tools::description_with_input_shape(description, schema)
        }
        kcoder_tools::ToolInputFormat::Freeform { syntax, example } => {
            let mut output = description.trim().to_string();
            output.push_str("\n\nInput format: FREEFORM text, not a JSON object.");
            output.push_str(" Syntax: ");
            output.push_str(syntax);
            output.push_str(". Use the dedicated FREEFORM call syntax. If the provider requires function-call JSON arguments, put the complete raw text in the `description` string field; the engine unwraps it before execution. The `description` field name is a transport wrapper only, not a prose summary.");
            if !example.trim().is_empty() {
                output.push_str(" Example:\n```diff\n");
                output.push_str(example.trim());
                output.push_str("\n```");
            }
            output
        }
    }
}

pub(super) fn normalize_freeform_tool_input(
    format: &kcoder_tools::ToolInputFormat,
    input: &mut Value,
) {
    if !matches!(format, kcoder_tools::ToolInputFormat::Freeform { .. }) || input.is_string() {
        return;
    }
    let Some(object) = input.as_object() else {
        return;
    };
    if let Some(text) = object.get("description").and_then(Value::as_str) {
        *input = Value::String(text.to_string());
        return;
    }
    for key in ["input", "text", "patch", "diff"] {
        if let Some(text) = object.get(key).and_then(Value::as_str) {
            *input = Value::String(text.to_string());
            return;
        }
    }
    if object.len() == 1
        && let Some(text) = object.values().next().and_then(Value::as_str)
    {
        *input = Value::String(text.to_string());
    }
}

fn tool_permission_mode(mode: PermissionMode) -> ToolPermissionMode {
    match mode {
        PermissionMode::Ask => ToolPermissionMode::Ask,
        PermissionMode::Auto => ToolPermissionMode::Auto,
        PermissionMode::AcceptEdits => ToolPermissionMode::AcceptEdits,
        PermissionMode::DontAsk => ToolPermissionMode::DontAsk,
        PermissionMode::Bypass => ToolPermissionMode::Bypass,
        PermissionMode::Yolo => ToolPermissionMode::Yolo,
    }
}

fn description_is_non_interactive(
    mode: WorkspacePersistenceMode,
    detect_terminal: impl FnOnce() -> bool,
) -> bool {
    // Client runtimes use a protocol input channel, never an interactive prompt.
    // On Windows, terminal probing can block behind a pending stdin pipe read.
    matches!(mode, WorkspacePersistenceMode::Client) || !detect_terminal()
}

pub(super) fn format_schema_example_for_prompt(schema: &Value) -> Option<String> {
    let example = kcoder_tools::example_input_for_schema(schema)?;
    let raw = serde_json::to_string(&example).ok()?;
    (raw.chars().count() <= 900).then_some(raw)
}

impl QueryEngine {
    /// Snapshot UI metadata for exactly the tools exposed to this engine's model.
    pub async fn effective_tool_catalog(&self) -> Vec<kcoder_types::tool_ui::ToolCatalogEntry> {
        let definitions = self.tool_definitions_for_model().await;
        let registry = self.active_tool_registry();
        let mut catalog = definitions
            .into_iter()
            .filter_map(|definition| {
                let tool = registry.get(&definition.name)?;
                Some(kcoder_types::tool_ui::ToolCatalogEntry {
                    ui: tool.ui_metadata().bounded(&definition.name),
                    name: definition.name,
                })
            })
            .collect::<Vec<_>>();
        catalog.sort_by(|left, right| left.name.cmp(&right.name));
        catalog
    }

    pub(super) async fn tool_definitions_for_model(&self) -> Vec<kcoder_types::ToolDefinition> {
        self.tool_definitions_for_request(false).await
    }

    pub(super) async fn tool_definitions_for_request(&self, terminal_verdict_only: bool) -> Vec<kcoder_types::ToolDefinition> {
        if !recover_read_lock(&self.settings, "settings")
            .model_capabilities
            .tools
        {
            return Vec::new();
        }
        let mut ctx = self.tool_description_context();
        let (goal_enabled, suppress_user_elicitation) = {
            let settings = recover_read_lock(&self.settings, "settings");
            (
                settings.goal_enabled,
                settings.permission_mode.suppresses_user_elicitation(),
            )
        };
        // The edit surface is pinned at engine creation; the live setting is
        // deliberately not consulted here.
        let file_edit_surface = self.file_edit_surface;
        let arrangement_mode = self.is_arrangement_mode_active();
        let active_tools = self.active_tool_registry();
        ctx.available_tools = active_tools.names().into_iter().filter(|name| {
            (goal_enabled || !is_goal_tool_name(name))
                && (!suppress_user_elicitation || !is_user_elicitation_tool_name(name))
                && !edit_surface_is_hidden(file_edit_surface, name)
                && (!terminal_verdict_only || name == kcoder_tools::VERIFIER_VOTE_TOOL_NAME)
        }).collect();
        if arrangement_mode || self.tools.revision() != self.tool_schema_revision {
            let mut definitions = Vec::new();
            for tool in active_tools.all() {
                let name = tool.name();
                if !ctx.available_tools.contains(&name) { continue; }
                let input_schema = tool.input_schema();
                let input_format = tool.input_format();
                let input_schema = if arrangement_mode {
                    self.orchestrate_schema_for_tool(&name, input_schema)
                } else {
                    model_schema_for_tool_input(&name, &input_schema, &input_format)
                };
                let description = tool.description_for_model(None, &ctx).await;
                let description = description_for_model_with_input_format(
                    &description,
                    &input_schema,
                    &input_format,
                );
                let mut definition = kcoder_types::ToolDefinition { name, description, input_schema };
                if matches!(tool.source(), kcoder_tools::ToolSource::Builtin) {
                    kcoder_tools::project_builtin_peer_guidance(&mut definition, &ctx);
                }
                definitions.push(definition);
            }
            return definitions;
        }

        let registry_revision = self.tools.revision();
        let mut definitions = Vec::new();
        for cached in self.tool_definitions.as_ref() {
            if !ctx.available_tools.contains(&cached.name) { continue; }
            let Some(tool) = active_tools.get(&cached.name) else {
                continue;
            };
            let description = tool.description_for_model(None, &ctx).await;
            let input_format = tool.input_format();
            let cached_description = tool
                .input_schema_is_stable()
                .then(|| {
                    self.tool_input_hints.render(
                        &registry_revision,
                        &cached.name,
                        &input_format,
                        &description,
                    )
                })
                .flatten();
            let (input_schema, description) = if let Some(description) = cached_description {
                (cached.input_schema.clone(), description)
            } else {
                // The transport schema must follow the same format as the rendered hint.
                let input_schema =
                    model_schema_for_tool_input(&cached.name, &tool.input_schema(), &input_format);
                let description = description_for_model_with_input_format(
                    &description,
                    &input_schema,
                    &input_format,
                );
                (input_schema, description)
            };
            let mut definition = kcoder_types::ToolDefinition {
                name: cached.name.clone(), description, input_schema,
            };
            if matches!(tool.source(), kcoder_tools::ToolSource::Builtin) {
                kcoder_tools::project_builtin_peer_guidance(&mut definition, &ctx);
            }
            definitions.push(definition);
        }
        definitions
    }

    fn tool_description_context(&self) -> ToolDescriptionContext {
        let (permission_mode, active_skills) = {
            let settings = recover_read_lock(&self.settings, "settings");
            let mode = tool_permission_mode(settings.permission_mode);
            let skills = recover_read_lock(&self.active_skills, "active_skills").clone();
            (mode, skills)
        };
        ToolDescriptionContext {
            permission_mode,
            is_non_interactive: description_is_non_interactive(
                self.workspace_persistence_mode,
                || std::io::stdin().is_terminal(),
            ),
            active_skills,
            available_tools: Default::default(),
        }
    }

    pub(super) fn input_schema_for_tool(&self, name: &str, tool: &dyn kcoder_tools::Tool) -> Value {
        let can_use_cache = tool.input_schema_is_stable()
            && self.tools.revision() == self.tool_schema_revision
            && !self.is_arrangement_mode_active()
            && self
                .tools
                .get(name)
                .is_some_and(|cached| std::ptr::eq(cached.as_ref(), tool));
        let schema = if can_use_cache {
            self.tool_input_schemas
                .get(name)
                .cloned()
                .unwrap_or_else(|| tool.input_schema())
        } else {
            tool.input_schema()
        };
        self.orchestrate_schema_for_tool(name, schema)
    }

    fn orchestrate_schema_for_tool(&self, name: &str, mut schema: Value) -> Value {
        if name != "spawn_agent"
            || self.state.session_mode() != kcoder_state::SessionMode::Orchestrate
        {
            return schema;
        }
        let roster = recover_read_lock(&self.settings, "settings")
            .orchestrate
            .roster
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let Some(agent_type) = schema
            .get_mut("properties")
            .and_then(Value::as_object_mut)
            .and_then(|properties| properties.get_mut("agent_type"))
            .and_then(Value::as_object_mut)
        else {
            return schema;
        };
        let mut values = kcoder_tools::AgentKind::spawn_agent_schema_values()
            .iter()
            .map(|value| Value::String((*value).to_string()))
            .collect::<Vec<_>>();
        values.extend(roster.iter().cloned().map(Value::String));
        agent_type.insert("enum".to_string(), Value::Array(values));
        agent_type.insert(
            "description".to_string(),
            Value::String(format!(
                "Canonical base roles plus this Orchestrate session's resolved persona roster: {}. Persona entries use compile-time base-role capabilities intersected with any configured shrinking allowlist; choosing a persona cannot add tools.",
                roster.join(", ")
            )),
        );
        schema
    }
}

#[cfg(test)]
#[path = "tests/tool_schema_runtime_unit.rs"]
mod tests;
