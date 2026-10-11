import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const lifecyclePath = fileURLToPath(new URL("../harness/remote-relay-lifecycle.mjs", import.meta.url));
const lifecycleSource = readFileSync(lifecyclePath, "utf8");
const helperMatch = lifecycleSource.match(/# KCUX_PORT_RELEASE_CHECK_BEGIN\n([\s\S]*?)\n# KCUX_PORT_RELEASE_CHECK_END/);
assert.ok(helperMatch, "the ROOT_STOP port-release helper must be present between its stable markers");

test("ROOT_STOP port gate rejects live sockets and allows only kernel TIME_WAIT residue", () => {
  const python = `${helperMatch[1]}
import json,socket,time

def must_reject(port, label):
 try: assert_no_active_tcp_socket(port)
 except RuntimeError: return
 raise AssertionError(label + ' must be rejected')

listener=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
listener.bind(('127.0.0.1',0)); listener.listen(1); listen_port=listener.getsockname()[1]
must_reject(listen_port,'LISTEN socket')
listener.close()

listener=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
listener.bind(('127.0.0.1',0)); listener.listen(1); established_port=listener.getsockname()[1]
client=socket.socket(socket.AF_INET,socket.SOCK_STREAM); client.connect(('127.0.0.1',established_port))
accepted,_=listener.accept()
must_reject(established_port,'ESTABLISHED socket')
accepted.close(); client.close(); listener.close()

listener=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
listener.bind(('127.0.0.1',0)); listener.listen(1); time_wait_port=listener.getsockname()[1]
client=socket.socket(socket.AF_INET,socket.SOCK_STREAM); client.connect(('127.0.0.1',time_wait_port))
accepted,_=listener.accept()
accepted.shutdown(socket.SHUT_WR); accepted.close()
assert client.recv(1)==b''
client.close(); listener.close()
deadline=time.monotonic()+2.0
observed=[]
while time.monotonic()<deadline:
 observed=tcp_socket_states(time_wait_port)
 if observed and all(state=='06' for state in observed): break
 time.sleep(.01)
assert observed and all(state=='06' for state in observed), 'fixture must produce only TIME_WAIT for the tested port'
time_wait_count=assert_no_active_tcp_socket(time_wait_port)
assert time_wait_count>0
print(json.dumps({'listenRejected':True,'establishedRejected':True,'timeWaitAllowed':True,
 'timeWaitSocketCount':time_wait_count},separators=(',',':')))
`;
  const output = execFileSync("/usr/bin/python3", ["-c", python], {
    encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"],
  });
  const result = JSON.parse(output);
  assert.equal(result.listenRejected, true);
  assert.equal(result.establishedRejected, true);
  assert.equal(result.timeWaitAllowed, true);
  assert.ok(Number.isInteger(result.timeWaitSocketCount) && result.timeWaitSocketCount > 0);
});
