import Gateway from '@alicloud/dingtalk/dist/gateway_1_0/client.js';
import OAuth from '@alicloud/dingtalk/dist/oauth2_1_0/client.js';
import Robot from '@alicloud/dingtalk/dist/robot_1_0/client.js';
import Card from '@alicloud/dingtalk/dist/card_1_0/client.js';
import OpenApi from '@alicloud/openapi-client';
import Util from '@alicloud/tea-util';
import { requireValue } from '../errors.mjs';

/** Official request/response models over the owned, bounded transport; no global hooks or SDK retry. */
export class DingTalkRest {
  constructor(transport) { this.transport = transport; }

  async call(sdk, operation, body, { token, signal } = {}) {
    const client = new sdk.default(new OpenApi.Config({ protocol: 'https', endpoint: 'api.dingtalk.com' }));
    const method = operation[0].toLowerCase() + operation.slice(1) + 'WithOptions';
    const headers = token ? { xAcsDingtalkAccessToken: token } : {};
    let dispatched = false;
    // Replace only this client's HTTP execution. The generated API method still owns
    // field selection, endpoint/method/header construction and response decoding.
    client.execute = async (params, request) => {
      requireValue(params.pathname.startsWith('/v1.0/') && ['POST', 'PUT'].includes(params.method)
        && !request.query && !request.stream, 'DINGTALK_SDK_REQUEST_UNSUPPORTED');
      signal?.throwIfAborted();
      dispatched = true;
      const result = await this.transport('https://api.dingtalk.com' + params.pathname, {
        method: params.method, body: request.body,
        headers: { 'Content-Type': 'application/json', ...request.headers }, signal, hosts: ['api.dingtalk.com'],
      });
      signal?.throwIfAborted();
      return { statusCode: 200, headers: {}, body: result };
    };
    try {
      signal?.throwIfAborted();
      const result = await client[method](new sdk[operation + 'Request'](body),
        sdk[operation + 'Headers'] ? new sdk[operation + 'Headers'](headers) : {},
        new Util.RuntimeOptions({ autoretry: false, maxAttempts: 1 }));
      return result.body;
    } catch (error) {
      if (!dispatched) error.externalOutcome = 'failed';
      throw error;
    }
  }

  openConnection(body, signal) { return this.call(Gateway, 'OpenConnection', body, { signal }); }
  accessToken(body, signal) { return this.call(OAuth, 'GetAccessToken', body, { signal }); }
  sendMessage(body, group, options) { return this.call(Robot, group ? 'OrgGroupSend' : 'BatchSendOTO', body, options); }
  card(body, update, options) { return this.call(Card, update ? 'UpdateCard' : 'CreateAndDeliver', body, options); }
  download(body, options) { return this.call(Robot, 'RobotMessageFileDownload', body, options); }
}
