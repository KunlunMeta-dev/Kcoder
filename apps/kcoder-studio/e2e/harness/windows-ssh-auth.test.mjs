import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsSshInvocation } from './windows-ssh-auth.mjs';
test('Windows password auth is scoped, redacted and absent from argv', () => {
 const secrets=[];const context={registerSecret:value=>secrets.push(value),isolatedEnvironment:value=>value};
 const spec=windowsSshInvocation(context,'ssh',['-o','BatchMode=yes','user@host','whoami'],'user@host','fixture-secret');
 assert.equal(spec.command,'sshpass');assert.ok(spec.args.includes('BatchMode=no'));
 assert.ok(!JSON.stringify(spec.args).includes('fixture-secret'));assert.deepEqual(secrets,['fixture-secret']);
 assert.equal(spec.options.env.SSHPASS,'fixture-secret');
 context.registerSecret=()=>{throw new Error('context is finishing');};
 context.isolatedEnvironment=()=>{throw new Error('context is finishing');};
 assert.equal(windowsSshInvocation(context,'ssh',['user@host','cleanup'],'user@host','fixture-secret').options.env.SSHPASS,'fixture-secret');
 assert.throws(()=>windowsSshInvocation(context,'ssh',['other@host'],'user@host','fixture-secret'),/explicit target/);
 assert.equal(windowsSshInvocation(context,'ssh',['-o','BatchMode=yes','user@host'],'user@host',null).command,'ssh');
});
