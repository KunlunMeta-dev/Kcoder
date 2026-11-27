import { FeishuAdapter,DingTalkAdapter,WeComAdapter } from './sdk.mjs';
import { QQAdapter } from './qq.mjs';
import { WeixinAdapter } from './weixin.mjs';
import { GithubAdapter } from './github.mjs';
import { assertChannelAdapter } from './contract.mjs';
import { effectiveChannelConfiguration } from './feature-options.mjs';
const adapters = { feishu: FeishuAdapter, dingtalk: DingTalkAdapter, qq: QQAdapter,
  weixin: WeixinAdapter, wecom: WeComAdapter, github: GithubAdapter };
export function officialAdapters() {
  return new Map(Object.entries(adapters).map(([platform, Adapter]) =>
    [platform, options => assertChannelAdapter(new Adapter({ ...options,
      configuration: effectiveChannelConfiguration(platform, options.configuration) }))]));
}
export {FeishuAdapter,DingTalkAdapter,WeComAdapter,QQAdapter,WeixinAdapter,GithubAdapter};
