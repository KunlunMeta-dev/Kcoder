import { t } from '@/i18n';
import type { ModelOption } from '@/runtime/task-runtime/modelCatalog';

export function followTargetDefaultLabel(model?: ModelOption): string {
  const name = model?.displayName?.trim() || model?.model?.trim();
  return name ? t('task.follow_target_default_with', { p0: name }) : t('task.follow_target_default');
}

/** Displaying a resolved default never turns it into an explicit selection. */
export function modelSelectorLabel({ selection, selected, defaultModel, followDefault = !selection?.trim() }: {
  selection?: string;
  selected?: ModelOption;
  defaultModel?: ModelOption;
  followDefault?: boolean;
}): string {
  if (followDefault) return followTargetDefaultLabel(defaultModel);
  return selected?.displayName?.trim() || selected?.model?.trim() || selection?.split('::').at(-1)?.trim() || t('task.follow_target_default');
}
