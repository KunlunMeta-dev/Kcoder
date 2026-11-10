"""Deterministic owned ACP peer for transport/ownership tests, never model quality."""
import json
import os
import signal
import sys
import time

journal = os.environ['OWNED_JOURNAL']
mode = os.environ.get('OWNED_MODE', 'normal')
session = 'owned-session'

def record(value):
    with open(journal, 'a', encoding='utf8') as target:
        target.write(json.dumps(value) + '\n')
        target.flush()

def emit(value):
    print(json.dumps(value), flush=True)

for raw in sys.stdin:
    frame = json.loads(raw)
    method = frame.get('method')
    record({'method': method, 'pid': os.getpid()})
    if method == 'initialize':
        auth = [{'id': 'actual-auth-required', 'name': 'Independent authentication'}] if mode == 'auth' else []
        if mode == 'bad-auth':
            auth = 'invalid-auth-declaration'
        name = 'kcoder' if mode == 'claimed-native-control' else 'owned-fixture'
        emit({'jsonrpc': '2.0', 'id': frame['id'], 'result': {'protocolVersion': 1, 'agentInfo': {'name': name, 'version': '1'}, 'authMethods': auth}})
    elif method == 'session/new':
        record({'cwd': frame['params']['cwd']})
        emit({'jsonrpc': '2.0', 'id': frame['id'], 'result': {'sessionId': session}})
    elif method == 'session/prompt':
        record({'effect': 'prompt_received'})
        if mode == 'escaped':
            child = os.fork()
            if child == 0:
                os.setsid()
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                record({'escaped_pid': os.getpid()})
                while True:
                    time.sleep(1)
            while True:
                time.sleep(1)
        if mode == 'lost':
            while True:
                time.sleep(1)
        if mode == 'claimed-native-control':
            emit({'jsonrpc': '2.0', 'id': 'untrusted-native-claim',
                  'method': 'kcoder/nativeRemote/controlV1', 'params': {
                      'version': 1, 'operationId': 'not-an-authority',
                      'requestId': 'untrusted-control-request',
                      'endpointRevision': 'claimed-native-revision',
                      'endpointInstanceId': 'claimed-native-instance',
                      'sourceAcceptedSha256': 'a' * 64,
                      'message': {'method': 'observe_original'}}})
            reply = json.loads(sys.stdin.readline())
            denied = reply.get('id') == 'untrusted-native-claim' and 'error' in reply
            record({'native_control_rejected': denied})
            if not denied:
                sys.exit(4)
        emit({'jsonrpc': '2.0', 'id': 'permission-owned', 'method': 'session/request_permission', 'params': {'sessionId': session}})
        denied = json.loads(sys.stdin.readline())
        record({'permission': denied.get('result', {}).get('outcome')})
        if denied.get('result', {}).get('outcome', {}).get('outcome') != 'cancelled':
            record({'unsafe_permission': True})
            sys.exit(3)
        emit({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session, 'update': {'sessionUpdate': 'agent_message_chunk', 'content': {'type': 'text', 'text': 'Actual owned process response'}}}})
        emit({'jsonrpc': '2.0', 'id': frame['id'], 'result': {'stopReason': 'end_turn'}})
