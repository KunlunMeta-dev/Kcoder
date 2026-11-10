import { useEffect, useRef, useState } from 'react';
import type { GatewayProfile, KCoderServer } from '@/gateway/types';
import type { TaskRuntime, TaskSnapshot } from '@/runtime/task-runtime';
import { defaultModelOption, selectedModelOption, type ModelOption } from '@/runtime/task-runtime/modelCatalog';
import { modelSelectorLabel } from './model-selector-presentation';

/** A display-only lookup on the conversation's exact connection; never writes preferences. */
export function useConversationModelLabel(task: TaskRuntime, snapshot: TaskSnapshot, models: readonly ModelOption[], profile?: GatewayProfile, server?: KCoderServer, demo = false): string {
  const selection = snapshot.pendingTurnPreferences?.model ?? snapshot.model;
  const knownDefault = defaultModelOption(models);
  const owner = () => JSON.stringify([task.runtimeInstanceNonce, task.clientGeneration, task.getSnapshot().threadId, task.getSnapshot().cwd,
    profile?.id, profile?.baseUrl, profile?.authorizationGeneration, profile?.deviceId, server]);
  const key = owner();
  const current = useRef({ key, task }); current.current = { key, task };
  const [read, setRead] = useState<{ key: string; task: TaskRuntime; model?: ModelOption }>();
  useEffect(() => {
    if (demo || !snapshot.connected || selection?.trim() || knownDefault) return;
    let cancelled = false;
    void task.request<{ data?: ModelOption[] }>('runtime.models.list').then(result => {
      if (!cancelled && current.current.task === task && current.current.key === key && owner() === key && task.getSnapshot().connected)
        setRead({ key, task, model: defaultModelOption(Array.isArray(result.data) ? result.data : []) });
    }).catch(() => { /* Optional display metadata stays unresolved; picker errors retain their own UI. */ });
    return () => { cancelled = true; };
  }, [task, key, snapshot.connected, selection, knownDefault, demo]);
  return modelSelectorLabel({ selection, selected: selectedModelOption(models, selection),
    defaultModel: knownDefault ?? (read?.key === key && read.task === task ? read.model : undefined) });
}
