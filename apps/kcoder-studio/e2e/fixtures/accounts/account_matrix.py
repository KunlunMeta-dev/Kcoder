"""Real account workers over one SSH root identity, inside an owned disposable container only."""
import base64
import json
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

if os.geteuid() != 0 or os.environ.get("KCODER_TEST_SYSTEM_USERS") != "1" or not Path("/.dockerenv").is_file():
    raise RuntimeError("This fixture may only create accounts inside its disposable Docker container")

REPO = Path('/repo')
sys.path.insert(0, str(REPO / 'scripts/install/lib'))
from studio_accounts import AccountStore
from studio_account_deploy import install_command

PASSWORD = 'synthetic-isolation-password'
NEW_PASSWORD = 'synthetic-rotated-password'
ADMIN_PASSWORD = 'synthetic-account-admin-password'

class Rpc:
    def __init__(self, process):
        self.process = process
        self.frames = queue.Queue()
        self.next_id = 40
        def receive():
            for line in process.stdout:
                try: self.frames.put(json.loads(line))
                except ValueError: self.frames.put({'invalidFrame': True})
            self.frames.put(None)
        threading.Thread(target=receive, daemon=True).start()

    def send(self, value):
        self.process.stdin.write((json.dumps(value) + '\n').encode())
        self.process.stdin.flush()

    def read(self, timeout=20):
        frame = self.frames.get(timeout=timeout)
        assert frame is not None and not frame.get('invalidFrame'), 'account RPC closed or malformed'
        return frame

    def request(self, method, params=None):
        self.next_id += 1
        self.send({'jsonrpc': '2.0', 'id': self.next_id, 'method': method, 'params': params or {}})
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            value = self.read(max(0.1, deadline - time.monotonic()))
            if value.get('id') == self.next_id: return value
        raise AssertionError('account RPC timed out: ' + method)

    def close(self):
        if not self.process.stdin.closed: self.process.stdin.close()
        try: self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.process.stdout.close()


def success(value):
    assert 'result' in value and 'error' not in value, value.get('error', 'missing result')
    return value['result']


def main():
    with tempfile.TemporaryDirectory(prefix='kcoder-account-matrix-') as directory:
        root = Path(directory)
        root.chmod(0o711)
        prefix = root / 'installed'
        (prefix / 'bin').mkdir(parents=True)
        shutil.copytree(REPO / 'scripts/install/lib', prefix / 'lib')
        shutil.copyfile(REPO / 'scripts/install/installers/studio-account-entry.py', prefix / 'bin/studio-account-entry.py')
        store = AccountStore(root / 'authority')
        store.create('administrator', ADMIN_PASSWORD, 'admin')
        command = Path('/usr/local/bin/kcoder-account')
        install_command(prefix=prefix, command_path=command, state=root / 'authority', homes=root / 'homes', runtime=Path('/usr/local/bin/kcoder'))
        host_key, client_key = root / 'host-key', root / 'shared-key'
        for key in [host_key, client_key]:
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)], check=True)
        (root / 'authorized_keys').write_bytes(client_key.with_suffix('.pub').read_bytes())
        (root / 'authorized_keys').chmod(0o600)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        host_public = host_key.with_suffix('.pub').read_text().split()
        (root / 'known_hosts').write_text(f'[127.0.0.1]:{port} {host_public[0]} {host_public[1]}\n')
        config = root / 'sshd_config'
        config.write_text('\n'.join([f'Port {port}', 'ListenAddress 127.0.0.1', f'HostKey {host_key}',
            f'AuthorizedKeysFile {root / "authorized_keys"}', 'PermitRootLogin yes', 'PasswordAuthentication no',
            'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', 'AllowUsers root',
            f'PidFile {root / "sshd.pid"}', 'LogLevel ERROR', '']))
        Path('/run/sshd').mkdir(exist_ok=True)
        # Only this container root account is changed; SSH password authentication remains disabled.
        subprocess.run(['passwd', '-d', 'root'], stdout=subprocess.DEVNULL, check=True)
        sshd = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(config)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sessions = []
        ssh_args = ['/usr/bin/ssh', '-F', '/dev/null', '-p', str(port), '-i', str(client_key),
            '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', f'UserKnownHostsFile={root / "known_hosts"}', 'root@127.0.0.1']
        deadline = time.monotonic() + 5
        while True:
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.2): break
            except OSError:
                assert time.monotonic() < deadline, 'isolated sshd did not start'
                time.sleep(0.05)

        def connect(name, password, mode='runtime', entry=command, operation=None):
            process = subprocess.Popen(ssh_args + [str(entry)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            client = Rpc(process)
            sessions.append(client)
            client.send({'protocol': 'kcoder-account-v1', 'username': name, 'password': password, 'mode': mode})
            if operation is not None: client.send(operation)
            authenticated = client.read()
            return client, authenticated

        def administer(operation, entry=command, admin_name='administrator'):
            client, result = connect(admin_name, ADMIN_PASSWORD, 'admin', entry, operation)
            assert result.get('authenticated') is True, 'administrator operation failed'
            client.close()
            return result['result']

        def runtime(name, password, entry=command):
            client, identity = connect(name, password, entry=entry)
            assert identity.get('authenticated') is True, 'runtime authentication failed'
            success(client.request('initialize', {'protocolVersion': '2026-07-27', 'clientInfo': {'name': 'account-matrix', 'version': '1'}}))
            client.send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
            return client, identity

        try:
            alice_identity = administer({'operation': 'create', 'username': 'alice', 'password': PASSWORD, 'role': 'user'})
            bob_identity = administer({'operation': 'create', 'username': 'bob', 'password': PASSWORD, 'role': 'user'})
            administrator, _ = runtime('administrator', ADMIN_PASSWORD)
            alice, alice_auth = runtime('alice', PASSWORD)
            bob, bob_auth = runtime('bob', PASSWORD)
            assert alice_auth['uid'] != bob_auth['uid']
            assert alice_auth['principalId'] == alice_identity['id']
            assert bob_auth['principalId'] == bob_identity['id']
            for identity in [alice_auth, bob_auth]:
                status = Path(f'/proc/{identity["runtimePid"]}/status').read_text()
                assert 'NoNewPrivs:\t1' in status
            def create_empty_model_account():
                administer({'operation': 'create', 'username': 'empty-model', 'password': PASSWORD, 'role': 'user'})
                client, identity = runtime('empty-model', PASSWORD)
                assert identity['uid'] not in (alice_auth['uid'], bob_auth['uid'])
                return client, identity['uid']
            from account_model_matrix import verify_account_models
            verify_account_models(administrator, create_empty_model_account, alice, bob, success)
            alice_thread = success(alice.request('thread/start', {'clientRequestId': 'alice-only'}))['thread']['id']
            bob_thread = success(bob.request('thread/start', {'clientRequestId': 'bob-only'}))['thread']['id']
            alice_file = success(alice.request('attachment/save', {'filename': 'private.txt', 'content_base64': base64.b64encode(b'alice-only-content').decode()}))['path']
            for method, params in [('thread/read', {'threadId': alice_thread}),
                ('thread/delete', {'threadId': alice_thread}),
                ('attachment/read', {'threadId': bob_thread, 'path': alice_file})]:
                assert 'error' in bob.request(method, params), 'Bob crossed Alice boundary: ' + method
            assert success(alice.request('thread/read', {'threadId': alice_thread}))['thread']['id'] == alice_thread
            bob_threads = success(bob.request('thread/list'))['threads']
            assert all(thread['id'] != alice_thread for thread in bob_threads)
            assert any(thread['id'] == bob_thread for thread in bob_threads), 'Bob lost his own thread after cross-account refusals'
            denied, denied_result = connect('bob', PASSWORD, 'admin', operation={'operation': 'list'})
            assert denied_result.get('authenticated') is False, 'ordinary KCoder account gained administrator API'
            denied.close()
            assert subprocess.check_output(ssh_args + ['id -u']).strip() == b'0', 'ordinary SSH root was restricted'

            administer({'operation': 'password', 'username': 'alice', 'password': NEW_PASSWORD})
            alice.process.wait(timeout=8)
            assert bob.process.poll() is None, 'changing Alice affected Bob'
            old, old_result = connect('alice', PASSWORD)
            assert old_result.get('authenticated') is False
            old.close()
            alice, alice_new = runtime('alice', NEW_PASSWORD)
            assert alice_new['principalId'] == alice_auth['principalId'] and alice_new['uid'] == alice_auth['uid']
            administer({'operation': 'disable', 'username': 'bob'})
            bob.process.wait(timeout=8)
            assert alice.process.poll() is None, 'disabling Bob affected Alice'
            disabled, disabled_result = connect('bob', PASSWORD)
            assert disabled_result.get('authenticated') is False
            disabled.close()
            administer({'operation': 'enable', 'username': 'bob'})
            bob, _ = runtime('bob', PASSWORD)
            administer({'operation': 'revoke', 'username': 'alice'})
            alice.process.wait(timeout=8)
            assert bob.process.poll() is None, 'revoking Alice affected Bob'

            bundle = administer({'operation': 'export'})
            assert set(bundle) == {'format', 'version', 'accounts'}, 'identity export included host bindings or context'
            target = AccountStore(root / 'migration-authority')
            target.create('migration-admin', ADMIN_PASSWORD, 'admin')
            migrated_command = Path('/usr/local/bin/kcoder-account-migrated')
            install_command(prefix=prefix, command_path=migrated_command, state=root / 'migration-authority', homes=root / 'migration-homes', runtime=Path('/usr/local/bin/kcoder'))
            imported = administer({'operation': 'import', 'bundle': bundle}, migrated_command, 'migration-admin')
            assert imported['added'] == len(bundle['accounts'])
            repeated = administer({'operation': 'import', 'bundle': bundle}, migrated_command, 'migration-admin')
            assert repeated['added'] == 0 and repeated['total'] == imported['total']
            assert all(set(account) == {'id', 'username', 'role', 'disabled', 'password', 'revision'} for account in bundle['accounts'])
            conflict = json.loads(json.dumps(bundle))
            incoming = next(account for account in conflict['accounts'] if account['username'] == 'alice')
            fresh = dict(incoming, id=str(uuid.uuid4()), username='must-not-half-import')
            changed = dict(incoming, role='admin')
            conflict['accounts'] = [fresh, changed]
            rejected, rejected_result = connect('migration-admin', ADMIN_PASSWORD, 'admin', migrated_command,
                {'operation': 'import', 'bundle': conflict})
            assert rejected_result.get('authenticated') is False, 'conflicting migration was accepted'
            rejected.close()
            target_accounts = administer({'operation': 'list'}, migrated_command, 'migration-admin')
            assert all(account['username'] != 'must-not-half-import' for account in target_accounts), 'conflicting import partially wrote identities'
            assert next(account for account in target_accounts if account['username'] == 'alice')['role'] == 'user'
            migrated, migrated_auth = runtime('alice', NEW_PASSWORD, migrated_command)
            assert migrated_auth['principalId'] == alice_auth['principalId']
            assert migrated_auth['uid'] != alice_auth['uid'], 'new host instance reused the old worker binding'
            assert success(migrated.request('thread/list'))['threads'] == [], 'identity migration copied conversation context'
            assert subprocess.check_output(ssh_args + ['id -u']).strip() == b'0'
            print(json.dumps({'sameSshRootAndKey': True, 'privateThreadAndAttachment': True, 'privateModelCatalogAndCredentials': True, 'emptyAccountNoInheritedCredential': True,
                'adminApiDeniedToOrdinaryAccount': True, 'passwordDisableRevokeIsolated': True,
                'identityMigrationWithoutContext': True, 'repeatedAndConflictingImportAtomic': True, 'ordinarySshRootPreserved': True}))
        finally:
            for client in sessions:
                try: client.close()
                except (BrokenPipeError, ValueError): pass
            sshd.terminate()
            sshd.wait(timeout=5)

if __name__ == '__main__': main()
