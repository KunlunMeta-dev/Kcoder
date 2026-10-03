import type { GatewayProfile, KCoderServer } from "@/gateway/types";
import { TaskRuntime, type StagedAttachment } from "@/runtime/task-runtime";
import { type WorkspaceViewState } from "@/storage/workspace-preferences";

export interface AttachmentAsset {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  blob?: Blob;
  base64?: string | null;
}

export type ComposerStagedAttachment = StagedAttachment & {
  localPreviewUri?: string;
  ownsLocalPreviewUri?: boolean;
};

export type AgentPanelProps = {
  task: TaskRuntime;
  profile?: GatewayProfile;
  server?: KCoderServer;
  bottomInset: number;
  demo: boolean;
  initialDraft?: string;
  initialQueuedMessages?: WorkspaceViewState["queuedMessages"];
  onDraftChange?(value: string | undefined): void;
  onQueuedMessagesChange?(value: WorkspaceViewState["queuedMessages"]): void;
  onTurnPreferencesChange?(model: string, reasoningEffort?: string): void;
  onOpenFile(link: string): boolean;
  onOpenChanges(): void;
};
