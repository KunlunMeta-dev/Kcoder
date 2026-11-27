"""Synthetic model credentials owned by actual account workers in the Docker matrix."""
import json
import pwd
from pathlib import Path
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def verify_account_models(administrator, create_empty_account, alice, bob, success):
    observed = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            model = body.get('model')
            owner = {'shared-model': 'administrator', 'alice-model': 'alice', 'bob-model': 'bob'}.get(model)
            authenticated = owner is not None and self.headers.get('authorization') == f'Bearer synthetic-{owner}-model-key'
            observed.append((model, authenticated))
            if not authenticated:
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"wrong account model credential"}}')
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for delta, finish in [({'role': 'assistant', 'content': 'ACCOUNT_MODEL_OK'}, None), ({}, 'stop')]:
                frame = {'id': 'account-model', 'object': 'chat.completion.chunk', 'created': 1,
                    'model': model, 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                self.wfile.write(('data: ' + json.dumps(frame) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        endpoint = f'http://127.0.0.1:{server.server_port}/v1'
        success(administrator.request('runtime.providers.upsert', {
            'id': 'shared-provider', 'apiFormat': 'openai_chat_completions',
            'endpoint': endpoint, 'model': 'shared-model', 'contextWindowTokens': 32000,
            'maxOutputTokens': 1024, 'apiKey': 'synthetic-administrator-model-key', 'makeDefault': True,
        }))
        admin_thread = success(administrator.request('thread/start', {'clientRequestId': 'administrator-model-proof'}))['thread']['id']
        success(administrator.request('turn/start', {'threadId': admin_thread,
            'input': [{'type': 'text', 'text': 'Verify the administrator model.'}]}))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            frame = administrator.read(max(0.1, deadline - time.monotonic()))
            if frame.get('method') == 'turn/completed' and frame.get('params', {}).get('threadId') == admin_thread:
                assert frame['params']['turn']['status'] == 'completed'
                break
        else:
            raise AssertionError('administrator model did not complete')
        assert observed == [('shared-model', True), ('shared-model', True)]

        # Only non-secret model configuration is supplied to the new account.
        # Same profile/model namespace makes a fallback to the administrator's
        # stored key observable as an unexpected real HTTP request.
        empty, empty_uid = create_empty_account()
        assert success(empty.request('runtime.models.list'))['data'] == [], 'fresh account inherited the administrator catalog'
        config = Path(pwd.getpwuid(empty_uid).pw_dir) / '.config/kcoder'
        settings = config / 'settings.json'
        settings.write_text(json.dumps({'active_provider': 'shared-provider', 'max_retries': 0,
            'providers': {'shared-provider': {'api_format': 'openai_chat_completions',
                'endpoint': endpoint, 'default_model': 'shared-model', 'no_proxy': True,
                'context_window_tokens': 32000, 'max_output_tokens': 1024, 'output_headroom_tokens': 1024}}}))
        assert settings.stat().st_uid == empty_uid
        credentials = config / 'credentials.json'
        assert not credentials.exists() or 'synthetic-administrator-model-key' not in credentials.read_text()
        catalog = success(empty.request('runtime.models.list'))
        model = next(row for row in catalog['data'] if row['id'] == 'shared-provider::shared-model')
        assert model['available'] is False, 'new account inherited an available administrator model'
        profile = next(row for row in success(empty.request('runtime.providers.list'))['profiles'] if row['id'] == 'shared-provider')
        assert profile['apiKeyConfigured'] is False, 'new account inherited administrator credentials'
        thread = success(empty.request('thread/start', {'clientRequestId': 'empty-account-model-proof'}))['thread']['id']
        admitted = empty.request('turn/start', {'threadId': thread, 'model': 'shared-provider::shared-model',
            'input': [{'type': 'text', 'text': 'This must fail without credentials.'}]})
        if 'error' not in admitted:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                frame = empty.read(max(0.1, deadline - time.monotonic()))
                if frame.get('method') == 'turn/completed' and frame.get('params', {}).get('threadId') == thread:
                    assert frame['params']['turn']['status'] == 'failed', 'empty account model unexpectedly completed'
                    break
            else:
                raise AssertionError('empty account did not clearly fail')
        assert len(observed) == 2, 'empty account made a model request or fell back to administrator'
        success(empty.request('thread/delete', {'threadId': thread}))

        for name, client in [('alice', alice), ('bob', bob)]:
            success(client.request('runtime.providers.upsert', {
                'id': f'{name}-provider', 'apiFormat': 'openai_chat_completions',
                'endpoint': f'http://127.0.0.1:{server.server_port}/v1', 'model': f'{name}-model',
                'contextWindowTokens': 32000, 'maxOutputTokens': 1024,
                'apiKey': f'synthetic-{name}-model-key', 'makeDefault': True,
            }))
        for name, client, other in [('alice', alice, 'bob'), ('bob', bob, 'alice')]:
            catalog = success(client.request('runtime.models.list'))
            assert any(row['model'] == f'{name}-model' for row in catalog['data'])
            assert not any(row['model'] == f'{other}-model' for row in catalog['data']), 'cross-account model catalog'
            public = json.dumps(catalog)
            assert 'synthetic-' not in public, 'catalog leaked a credential'
            thread = success(client.request('thread/start', {'clientRequestId': f'{name}-model-proof'}))['thread']['id']
            success(client.request('turn/start', {'threadId': thread, 'model': f'{name}-provider::{name}-model',
                'input': [{'type': 'text', 'text': 'Verify this account model.'}]}))
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                frame = client.read(max(0.1, deadline - time.monotonic()))
                if frame.get('method') == 'turn/completed' and frame.get('params', {}).get('threadId') == thread:
                    assert frame['params']['turn']['status'] == 'completed'
                    break
            else:
                raise AssertionError('account model turn did not complete')
        assert sorted(model for model, _ in observed) == ['alice-model', 'alice-model', 'bob-model', 'bob-model', 'shared-model', 'shared-model']
        assert all(authenticated for _, authenticated in observed), 'a model request used another account credential'
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
