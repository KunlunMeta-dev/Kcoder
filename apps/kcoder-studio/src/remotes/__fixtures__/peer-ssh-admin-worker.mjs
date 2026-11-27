// Contract fixture only: this worker never enrolls a Native peer or grants a route.
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
let result;
if (args.includes('apply')) {
  let bytes = Buffer.alloc(0);
  for await (const chunk of process.stdin) bytes = Buffer.concat([bytes, chunk]);
  if (process.env.OWNED_PEER_CAPTURE) await writeFile(process.env.OWNED_PEER_CAPTURE, bytes, { mode: 0o600 });
  const command = JSON.parse(bytes.toString('utf8'));
  result = { version: 1, operationId: command.operationId, enrollmentId: command.action.enrollment.enrollmentId,
    revision: 1, generation: 1, status: 'pinned' };
} else {
  result = { version: 1, native: { accountUid: 1001, profileIdentity: 'owned-profile', targetId: 'native-target',
    workspaceId: 'native-workspace', identityEpoch: 'epoch', publicKey: Array(32).fill(7) }, pinRevision: 0 };
}
process.stdout.write(JSON.stringify(result) + '\n');
