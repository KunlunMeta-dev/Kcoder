export type SettingsSectionId =
  | "connections_devices"
  | "models_services"
  | "execution_permissions"
  | "appearance"
  | "conversation_preferences"
  | "quick_phrases"
  | "custom_instructions"
  | "tool_configuration"
  | "plugins_skills"
  | "usage"
  | "migration_results"
  | "storage_cache"
  | "terminal"
  | "connection_diagnostics"
  | "about";

export type SettingsHubStatus =
  | "gateway"
  | "appearance"
  | "terminal"
  | "diagnostics"
  | "version"
  | "target_scope"
  | "device_scope"
  | "in_session";

export type SettingsHubDestination =
  | "overview"
  | "connections"
  | "appearance"
  | "terminal"
  | "diagnostics"
  | "about";

export interface SettingsHubSection {
  id: SettingsSectionId;
  labelKey: string;
  descriptionKey: string;
  scope: "device" | "runtime_target";
  status: SettingsHubStatus;
  destination: SettingsHubDestination;
}

export interface SettingsHubGroup {
  id: string;
  titleKey: string;
  sections: SettingsHubSection[];
}

export const SETTINGS_SECTION_GROUPS: SettingsHubGroup[] = [
  {
    id: "connection_runtime",
    titleKey: "settings_hub.group_connection_runtime",
    sections: [
      {
        id: "connections_devices",
        labelKey: "settings_hub.entry_connections_devices",
        descriptionKey: "settings_hub.description_connections_devices",
        scope: "device",
        status: "gateway",
        destination: "connections",
      },
      {
        id: "models_services",
        labelKey: "settings_hub.entry_models_services",
        descriptionKey: "settings_hub.description_models_services",
        scope: "runtime_target",
        status: "target_scope",
        destination: "overview",
      },
      {
        id: "execution_permissions",
        labelKey: "settings_hub.entry_execution_permissions",
        descriptionKey: "settings_hub.description_execution_permissions",
        scope: "runtime_target",
        status: "target_scope",
        destination: "overview",
      },
    ],
  },
  {
    id: "conversation_personalization",
    titleKey: "settings_hub.group_conversation_personalization",
    sections: [
      {
        id: "appearance",
        labelKey: "settings_hub.entry_appearance",
        descriptionKey: "settings_hub.description_appearance",
        scope: "device",
        status: "appearance",
        destination: "appearance",
      },
      {
        id: "conversation_preferences",
        labelKey: "settings_hub.entry_conversation_preferences",
        descriptionKey: "settings_hub.description_conversation_preferences",
        scope: "device",
        status: "device_scope",
        destination: "overview",
      },
      {
        id: "quick_phrases",
        labelKey: "settings_hub.entry_quick_phrases",
        descriptionKey: "settings_hub.description_quick_phrases",
        scope: "device",
        status: "device_scope",
        destination: "overview",
      },
      {
        id: "custom_instructions",
        labelKey: "settings_hub.entry_custom_instructions",
        descriptionKey: "settings_hub.description_custom_instructions",
        scope: "runtime_target",
        status: "target_scope",
        destination: "overview",
      },
    ],
  },
  {
    id: "tools_extensions",
    titleKey: "settings_hub.group_tools_extensions",
    sections: [
      {
        id: "tool_configuration",
        labelKey: "settings_hub.entry_tool_configuration",
        descriptionKey: "settings_hub.description_tool_configuration",
        scope: "runtime_target",
        status: "target_scope",
        destination: "overview",
      },
      {
        id: "plugins_skills",
        labelKey: "settings_hub.entry_plugins_skills",
        descriptionKey: "settings_hub.description_plugins_skills",
        scope: "runtime_target",
        status: "target_scope",
        destination: "overview",
      },
    ],
  },
  {
    id: "data_support",
    titleKey: "settings_hub.group_data_support",
    sections: [
      {
        id: "migration_results",
        labelKey: "migration_results.title",
        descriptionKey: "migration_results.description",
        scope: "runtime_target",
        status: "target_scope",
        destination: "overview",
      },
      {
        id: "usage",
        labelKey: "settings_hub.entry_usage",
        descriptionKey: "settings_hub.description_usage",
        scope: "runtime_target",
        status: "target_scope",
        destination: "overview",
      },
      {
        id: "storage_cache",
        labelKey: "settings_hub.entry_storage_cache",
        descriptionKey: "settings_hub.description_storage_cache",
        scope: "device",
        status: "device_scope",
        destination: "overview",
      },
      {
        id: "terminal",
        labelKey: "settings_hub.entry_terminal",
        descriptionKey: "settings_hub.description_terminal",
        scope: "device",
        status: "terminal",
        destination: "terminal",
      },
      {
        id: "connection_diagnostics",
        labelKey: "settings_hub.entry_connection_diagnostics",
        descriptionKey: "settings_hub.description_connection_diagnostics",
        scope: "device",
        status: "diagnostics",
        destination: "diagnostics",
      },
      {
        id: "about",
        labelKey: "settings_hub.entry_about",
        descriptionKey: "settings_hub.description_about",
        scope: "device",
        status: "version",
        destination: "about",
      },
    ],
  },
];

export function getSettingsHubSection(sectionId: string | undefined): SettingsHubSection | undefined {
  if (!sectionId) return undefined;
  for (const group of SETTINGS_SECTION_GROUPS) {
    const section = group.sections.find((candidate) => candidate.id === sectionId);
    if (section) return section;
  }
  return undefined;
}
