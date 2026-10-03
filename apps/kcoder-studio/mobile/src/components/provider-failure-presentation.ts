import type { ProviderFailureDetails } from '../../../shared/providerFailure';

const summaries: Record<ProviderFailureDetails['category'], string> = {
  authentication_error: '模型认证失败，请检查当前目标账号的凭据。',
  forbidden: '模型服务拒绝访问，请检查账号和模型权限。',
  model_or_route: '模型或接口不可用，请检查模型 ID 和 API 地址。',
  invalid_parameter: '模型请求参数无效，请检查此模型的配置。',
  context_length_exceeded: '请求超过模型上下文限制。',
  quota_exceeded: '模型服务额度不足，请检查账号额度。',
  rate_limit: '模型服务请求过于频繁，请稍后重试。',
  network_error: '连接模型服务失败，请检查目标主机的网络。',
  timeout_error: '模型请求超时，请检查服务状态后重试。',
  model_protocol_error: '模型响应格式无效，请检查接口协议。',
  provider_error: '模型服务返回错误，请查看详情并核实服务状态。',
};

export function providerFailureSummary(failure: ProviderFailureDetails | undefined): string {
  return failure ? summaries[failure.category] : '任务生成失败，请查看详情并核实执行状态。';
}
