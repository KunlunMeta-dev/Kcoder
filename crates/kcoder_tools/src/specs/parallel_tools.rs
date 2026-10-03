//! Spec parallel tools adapter behavior; domain operations remain in kcoder_specs.

use super::*;

#[async_trait]
impl Tool for SpecParallelDraftTool {
    fn name(&self) -> String {
        "SpecParallelDraft".to_string()
    }

    fn description(&self) -> String {
        "Draft delta specs for multiple independent domains in parallel. \
         Spawns one subagent per domain, each writing \
         `.kcoder/specs/changes/<name>/specs/<domain>/spec.md`."
            .to_string()
    }

    fn input_schema_is_stable(&self) -> bool {
        true
    }

    fn input_schema(&self) -> Value {
        schema_with_agent_turn_bounds::<SpecParallelDraftInput>()
    }

    fn is_destructive(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn call(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let input: SpecParallelDraftInput = parse_input(&input)?;
        require_using_specs_skill(ctx)?;

        if input.name.trim().is_empty() {
            return Err(ToolError::InvalidInput(
                "change name cannot be empty".to_string(),
            ));
        }
        if input.domains.is_empty() {
            return Err(ToolError::InvalidInput(
                "at least one domain must be specified".to_string(),
            ));
        }

        let cwd = ctx.state.cwd();
        let change_dir = cwd
            .join(".kcoder")
            .join("specs")
            .join("changes")
            .join(&input.name);
        if !change_dir.exists() {
            return Err(ToolError::Execution(format!(
                "change '{}' does not exist",
                input.name
            )));
        }

        let proposal = fs::read_to_string(change_dir.join("proposal.md")).unwrap_or_default();
        let runner = ctx
            .agent_runner
            .as_ref()
            .map(Arc::clone)
            .ok_or_else(|| ToolError::Execution("agent runner not available".into()))?;

        if ctx.is_aborted() {
            return Err(ToolError::Aborted);
        }

        let name = input.name;
        let max_turns = clamp_agent_max_turns(input.max_turns);
        let domains: Vec<String> = input
            .domains
            .into_iter()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .collect();
        let id = ctx.spawn_subagent_background(
            format!("parallel spec draft for {} ({} domains)", name, domains.len()),
            async move {
                let mut join_set = JoinSet::new();
                for domain in domains {
                    let prompt = format!(
                        "You are drafting the spec delta for the '{domain}' capability as part of change \"{name}\".\n\n\
                         Context:\n\
                         - Proposal:\n{proposal}\n\n\
                         - Current authoritative spec: read `.kcoder/specs/specs/{domain}/spec.md` if it exists.\n\
                         - Change directory: `.kcoder/specs/changes/{name}/`\n\n\
                         Your task:\n\
                         1. Read the authoritative spec for '{domain}' if it exists.\n\
                         2. Write `.kcoder/specs/changes/{name}/specs/{domain}/spec.md` with ADDED/MODIFIED/REMOVED/RENAMED requirements as needed.\n\
                         3. Each requirement MUST use SHALL/MUST/SHOULD/MAY and each scenario MUST use WHEN/THEN.\n\
                         4. Do NOT edit other domains or implementation files.\n\n\
                         Return a concise summary of what you added/modified/removed.",
                        domain = domain,
                        name = name,
                        proposal = proposal
                    );
                    let runner = Arc::clone(&runner);
                    join_set.spawn(async move {
                        let result = runner.run_agent(prompt, max_turns).await;
                        (domain, result)
                    });
                }

                let mut summaries = Vec::new();
                while let Some(res) = join_set.join_next().await {
                    match res {
                        Ok((domain, Ok(output))) => {
                            summaries.push(format!("## Domain: {}\n\n{}", domain, output));
                        }
                        Ok((domain, Err(e))) => {
                            summaries.push(format!(
                                "## Domain: {}\n\nError: review subagent failed: {}",
                                domain, e
                            ));
                        }
                        Err(e) => {
                            summaries.push(format!(
                                "## Domain: (unknown)\n\nError: task panicked: {}",
                                e
                            ));
                        }
                    }
                }

                ToolOutput::text(summaries.join("\n\n"))
            },
        )?;

        Ok(ToolOutput::text(format!(
            "Started background parallel spec draft task {id}. It will run independently and the result will be incorporated automatically when it completes."
        )))
    }
}
