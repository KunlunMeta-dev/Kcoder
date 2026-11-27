import assert from 'node:assert/strict';
import { waitForStdioChildClose } from './app-server-stdio.mjs';

const stopRecipient = `
import os, select, signal, sys
pid, owner = int(sys.argv[1]), int(sys.argv[2])
try:
    fd = os.pidfd_open(pid)
except ProcessLookupError:
    sys.exit(0)
try:
    try:
        assert os.path.samefile('/proc/%d/exe' % pid, sys.argv[3])
        assert os.path.samefile('/proc/%d/cwd' % pid, sys.argv[4])
        ancestor = pid
        while ancestor != owner and ancestor > 1:
            with open('/proc/%d/stat' % ancestor) as stat:
                ancestor = int(stat.read().rsplit(')', 1)[1].split()[1])
        assert ancestor == owner
        signal.pidfd_send_signal(fd, signal.SIGTERM)
    except (FileNotFoundError, ProcessLookupError):
        pass
    exited = select.poll()
    exited.register(fd, select.POLLIN)
    assert exited.poll(15000), 'original destination app-server did not exit'
finally:
    os.close(fd)`;

/** Stop only the held app-server for this run's original workspace. */
export async function stopOwnedPeerWorkspaceProcess(context, { processId, gatewayPid, binary, workspace }) {
  const stopper = context.spawnOwned('stop-owned-recipient', '/usr/bin/python3', ['-c', stopRecipient,
    String(processId), String(gatewayPid), binary, workspace], { stdin: 'ignore' });
  assert.equal((await waitForStdioChildClose(stopper, 20000, 'original recipient process exit')).code, 0);
}
