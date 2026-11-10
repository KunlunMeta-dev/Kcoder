export const migrationAgentsEn = {
  "migration_agents.adapt": "Adapt this static Agent to a native Agent",
  "migration_agents.boundary": "Preserve the reviewed prompt and tool restrictions, then publish disabled. Source approvals, user-question permissions and unsupported dependencies stay pending.",
  "migration_agents.inspect": "Inspect compatibility",
  "migration_agents.failed": "Compatibility could not be confirmed. Retry the original preview.",
  "migration_agents.update_required": "Update the target to adapt Agent definitions.",
  "migration_agents.unsupported": "This definition needs unsupported behavior or dependencies. Keep its original pending definition for review.",
  "migration_agents.model_policy": "Native model mapping",
  "migration_agents.model": "Model identifier",
  "migration_agents.provider": "Provider identifier",
  "migration_agents.choose": "Choose explicitly",
  "migration_agents.inherit": "Inherit the current model when spawned",
  "migration_agents.target": "Use a configured provider and model",
  "migration_agents.model_boundary": "Source model aliases do not select native models. The configured deployment is checked at spawn and pinned for continuation. A changed deployment requires a new Agent.",
  "migration_agents.tools": "Reviewed native tools",
  "migration_agents.confirm": "I reviewed the source prompt, native model mapping and restricted tools. Publish disabled."
} as const;
