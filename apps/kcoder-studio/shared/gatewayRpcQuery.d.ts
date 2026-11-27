export interface GatewayRpcQuery {
  token: string;
  server?: string;
  channel?: 'runtime' | 'browser' | 'ssh-terminal';
  workspace?: string;
  channelObserver?: string;
  runtimeObserver?: string;
}

export function createGatewayRpcQuery(values: GatewayRpcQuery): URLSearchParams;
export function isGatewayRpcQuery(params: URLSearchParams): boolean;
