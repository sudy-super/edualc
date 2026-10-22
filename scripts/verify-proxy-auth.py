#!/usr/bin/env python3
"""Run the installed LiteLLM against a local Anthropic fixture with a dummy key."""
import argparse
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


def unused_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--litellm', required=True, type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    seen = []
    dummy_key = 'sk-ant-edualc-local-fixture'

    class Provider(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            seen.append({'path': self.path, 'model': body['model'],
                         'private_key_received': self.headers.get('x-api-key') == dummy_key,
                         'proxy_key_leaked': self.headers.get('x-litellm-api-key') is not None,
                         'bearer_received': self.headers.get('authorization') is not None})
            response = json.dumps({'id': 'msg_fixture', 'type': 'message', 'role': 'assistant',
                                   'model': body['model'], 'content': [{'type': 'text', 'text': 'fixture success'}],
                                   'stop_reason': 'end_turn', 'stop_sequence': None,
                                   'usage': {'input_tokens': 1, 'output_tokens': 2}}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, *args):
            pass

    provider = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    results = []
    try:
        with tempfile.TemporaryDirectory(prefix='edualc-proxy-auth-') as temporary:
            root = Path(temporary)
            for enabled in (False, True):
                port = unused_port()
                config = {'model_list': [{'model_name': 'claude-fixture', 'litellm_params': {
                    'model': 'anthropic/claude-fixture',
                    'api_base': f'http://127.0.0.1:{provider.server_port}'}}],
                    'general_settings': {'forward_client_headers_to_llm_api': True,
                                         'forward_llm_provider_auth_headers': enabled}}
                config_path = root / f'{enabled}.json'
                config_path.write_text(json.dumps(config))
                env = {key: value for key, value in os.environ.items()
                       if not any(marker in key.upper() for marker in
                                  ('API_KEY', 'AUTH_TOKEN', 'OAUTH_TOKEN', 'PROXY'))}
                env.update({'LITELLM_LOCAL_MODEL_COST_MAP': 'True', 'NO_PROXY': '*',
                            'LITELLM_LOG': 'ERROR', 'HOME': str(root)})
                with (root / f'{enabled}.log').open('wb') as log:
                    process = subprocess.Popen([str(args.litellm), '--config', str(config_path),
                                                '--host', '127.0.0.1', '--port', str(port)],
                                               env=env, stdout=log, stderr=log, start_new_session=True)
                    try:
                        deadline = time.monotonic() + 60
                        while True:
                            try:
                                with opener.open(f'http://127.0.0.1:{port}/health/liveliness', timeout=1):
                                    break
                            except (OSError, urllib.error.URLError):
                                if process.poll() is not None or time.monotonic() > deadline:
                                    raise RuntimeError('Fixture proxy failed to start')
                                time.sleep(.1)
                        request = urllib.request.Request(f'http://127.0.0.1:{port}/v1/messages',
                            data=json.dumps({'model': 'claude-fixture', 'max_tokens': 8,
                                             'messages': [{'role': 'user', 'content': 'fixture'}]}).encode(),
                            headers={'Content-Type': 'application/json', 'x-api-key': dummy_key,
                                     'x-litellm-api-key': 'sk-local', 'anthropic-version': '2023-06-01'})
                        before = len(seen)
                        try:
                            with opener.open(request, timeout=20) as response:
                                status, body = response.status, response.read().decode()
                        except urllib.error.HTTPError as error:
                            status, body = error.code, error.read().decode()
                        results.append({'forward_llm_provider_auth_headers': enabled,
                                        'status': status, 'missing_key_error': 'Missing Anthropic API Key' in body,
                                        'provider_requests': seen[before:]})
                    finally:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
        assert results[0]['status'] == 401 and results[0]['missing_key_error'], results[0]
        assert results[0]['provider_requests'] == [], results[0]
        assert results[1]['status'] == 200, results[1]
        assert results[1]['provider_requests'] == [{'path': '/v1/messages', 'model': 'claude-fixture',
            'private_key_received': True, 'proxy_key_leaked': False, 'bearer_received': False}], results[1]
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps({'scope': 'installed LiteLLM, dummy key, localhost only',
                                           'results': results}, indent=2) + '\n')
        print(json.dumps(results, indent=2))
    finally:
        provider.shutdown()
        provider.server_close()


if __name__ == '__main__':
    main()
