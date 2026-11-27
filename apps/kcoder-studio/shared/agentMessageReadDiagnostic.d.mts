export type AgentMessageReadStage = 'support' | 'journal' | 'policy' | 'targets' | 'validation';
export interface AgentMessageReadDiagnostic { stage: AgentMessageReadStage; reason: string }
export function closedAgentMessageReason(value: unknown): string;
export function agentMessageDiagnosticData(error: unknown): { reason: string };
export function agentMessageReadDiagnostic(stage: AgentMessageReadStage, error: unknown): AgentMessageReadDiagnostic | undefined;
export function isAgentMessageReadDiagnostic(value: unknown): value is AgentMessageReadDiagnostic;
