import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AuthenticationTests(unittest.TestCase):
    def test_startup_auth_survives_another_launcher_without_proxy_headers(self):
        with tempfile.TemporaryDirectory(prefix='edualc-concurrent-auth-') as directory:
            home = Path(directory)
            (home / '.edualc').mkdir()
            settings = home / '.edualc/settings.json'
            settings.write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': 'first-api-fixture',
                'ANTHROPIC_CUSTOM_HEADERS': 'anthropic-workspace-id: wrkspc_first'}}))
            current = home / '.local/share/edualc/sdk/current'
            current.parent.mkdir(parents=True)
            current.symlink_to(ROOT)
            env = {k:v for k,v in os.environ.items()
                   if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_', 'BUN_'))}
            env.update({'HOME':str(home), 'ANTHROPIC_CUSTOM_HEADERS':'x-litellm-api-key: proxy-fixture',
                'CLAUDE_CODE_OAUTH_TOKEN':'original-oauth-fixture',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1'})
            subprocess.run([str(ROOT/'bin/edualc-direct'), '--version'], env=env,
                           check=True, capture_output=True, timeout=30)
            env.update({'EDUALC_AUTH_SETTINGS_FILE':str(home/'.edualc/runtime-auth.json'),
                        'EDUALC_TEST_SDK_SOURCE':str(ROOT/'src/sdk.ts')})
            script = home/'probe.mjs'
            script.write_text('''
import { createInterface } from 'node:readline';
const { sdkEnvironment, sdkSettings } = await import(process.env.EDUALC_TEST_SDK_SOURCE);
console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin })) {
  const env = sdkEnvironment();
  const settings = sdkSettings({ env: { ANTHROPIC_API_KEY: 'shared-fixture' } });
  console.log(JSON.stringify({
    originalKeyRetained: env.ANTHROPIC_API_KEY === 'first-api-fixture',
    privateSettingsRetained: settings.env.ANTHROPIC_API_KEY === 'first-api-fixture',
    proxyHeaderRetained: env.ANTHROPIC_CUSTOM_HEADERS.includes('x-litellm-api-key: proxy-fixture'),
    proxySettingsRetained: settings.env.ANTHROPIC_CUSTOM_HEADERS.includes('x-litellm-api-key: proxy-fixture'),
    privateWorkspaceRetained: env.ANTHROPIC_CUSTOM_HEADERS.includes('anthropic-workspace-id: wrkspc_first'),
    sdkOAuthCleared: env.CLAUDE_CODE_OAUTH_TOKEN === '',
    parentOAuthUnchanged: process.env.CLAUDE_CODE_OAUTH_TOKEN === 'original-oauth-fixture',
  }));
  break;
}
''')
            process = subprocess.Popen(['bun',str(script)],env=env,stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                self.assertEqual(json.loads(process.stdout.readline()), {'ready':True})
                settings.write_text(json.dumps({'env':{'ANTHROPIC_API_KEY':'second-api-fixture',
                    'ANTHROPIC_CUSTOM_HEADERS':'anthropic-workspace-id: wrkspc_second'}}))
                second = {k:v for k,v in env.items() if k != 'ANTHROPIC_CUSTOM_HEADERS'}
                subprocess.run([str(ROOT/'bin/edualc-direct'), '--version'], env=second,
                               check=True,capture_output=True,timeout=30)
                output, error = process.communicate('check\n',timeout=10)
                self.assertEqual(process.returncode,0,error)
                results = json.loads(output)
                self.assertTrue(all(results.values()),results)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)

    def launch(self, key):
        with tempfile.TemporaryDirectory(prefix='edualc-auth-test-') as directory:
            home = Path(directory)
            (home / '.edualc').mkdir()
            (home / '.claude').mkdir()
            (home / '.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': key}}))
            sdk_current = home / '.local/share/edualc/sdk/current'
            sdk_current.parent.mkdir(parents=True)
            sdk_current.symlink_to(ROOT)
            environment = {
                **os.environ, 'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(home / '.claude'),
                'ANTHROPIC_API_KEY': '', 'ANTHROPIC_AUTH_TOKEN': '',
                'CLAUDE_CODE_OAUTH_TOKEN': 'old-oauth-fixture',
                'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR': '',
                'CLAUDE_BG_AUTH_SNAPSHOT_PATH': '',
                'CLAUDE_SECURESTORAGE_CONFIG_DIR': str(home / '.claude'),
                'ANTHROPIC_BASE_URL': 'http://127.0.0.1:9', 'CLAUDE_CODE_MODEL_CATALOG': 'off',
                'HTTP_PROXY': '', 'HTTPS_PROXY': '', 'ALL_PROXY': '',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
            }
            result = subprocess.run([str(ROOT / 'bin/edualc-direct'), 'auth', 'status', '--json'],
                                    env=environment, capture_output=True, text=True, timeout=30)
            return result, home

    def test_tui_keeps_original_oauth_with_shared_configuration_and_history(self):
        result, home = self.launch('sk-ant-api03-edualc-fixture')
        self.assertEqual(result.returncode, 0, result.stderr)
        status = json.loads(result.stdout)
        self.assertTrue(status['loggedIn'])
        self.assertEqual(status['authMethod'], 'oauth_token')
        self.assertEqual(Path(status['configDirectory']).resolve(), (home / '.claude').resolve())
        self.assertEqual(Path(status['projectsDirectory']).resolve(), (home / '.claude/projects').resolve())

    def test_original_remote_auth_and_sdk_auth_are_separate(self):
        with tempfile.TemporaryDirectory(prefix='edualc-control-auth-') as directory:
            home = Path(directory)
            (home/'.edualc').mkdir()
            (home/'.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': 'sk-ant-private-fixture'}}))
            current = home/'.local/share/edualc/sdk/current'
            current.parent.mkdir(parents=True)
            current.symlink_to(ROOT)
            env = {k:v for k,v in os.environ.items() if not k.startswith(('ANTHROPIC_', 'CLAUDE_', 'EDUALC_', 'BUN_'))}
            env.update({'HOME':str(home), 'CLAUDE_CODE_OAUTH_TOKEN':'original-oauth-fixture',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1', 'CLAUDE_SECURESTORAGE_CONFIG_DIR':str(home/'.claude'),
                'ANTHROPIC_BASE_URL':'http://api.anthropic.com'})
            subprocess.run([str(ROOT/'bin/edualc-direct'), '--version'], env=env, capture_output=True, check=True)
            env.update({'BUN_OPTIONS':f'--preload={ROOT / "scripts/probe-control-auth.mjs"}',
                'EDUALC_AUTH_SETTINGS_FILE':str(home/'.edualc/runtime-auth.json')})
            result = subprocess.run([str(ROOT/'native/edualc'), '--version'], env=env,
                text=True, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            evidence = json.loads(result.stdout)
            self.assertTrue(evidence['remoteTokenUsesOriginalLogin'])
            self.assertTrue(evidence['childSettingsOverrideSharedAuth'])

    def test_missing_edualc_key_does_not_use_inherited_credentials(self):
        result, _ = self.launch('')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('env.ANTHROPIC_API_KEY', result.stderr)


if __name__ == '__main__':
    unittest.main()
