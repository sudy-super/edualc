import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = Path.home() / '.local/share/claude/versions/2.1.302'


class AuthenticationTests(unittest.TestCase):
    def launch(self, key):
        with tempfile.TemporaryDirectory(prefix='edualc-auth-test-') as directory:
            home = Path(directory)
            (home / '.edualc').mkdir()
            (home / '.claude').mkdir()
            (home / '.edualc/settings.json').write_text(json.dumps({'env': {'ANTHROPIC_API_KEY': key}}))
            runtime = home / '.local/share/claude/versions/2.1.302'
            runtime.parent.mkdir(parents=True)
            runtime.symlink_to(RUNTIME)
            sdk_current = home / '.local/share/edualc/sdk/current'
            sdk_current.parent.mkdir(parents=True)
            sdk_current.symlink_to(ROOT)
            environment = {
                **os.environ, 'HOME': str(home), 'CLAUDE_CONFIG_DIR': str(home / '.claude'),
                'ANTHROPIC_API_KEY': 'old-key-fixture', 'ANTHROPIC_AUTH_TOKEN': 'old-auth-fixture',
                'CLAUDE_CODE_OAUTH_TOKEN': 'old-oauth-fixture',
                'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR': '99',
                'CLAUDE_BG_AUTH_SNAPSHOT_PATH': '/nonexistent-edualc-auth-test',
                'CLAUDE_SECURESTORAGE_CONFIG_DIR': str(home / '.claude'),
                'ANTHROPIC_BASE_URL': 'http://127.0.0.1:9', 'CLAUDE_CODE_MODEL_CATALOG': 'off',
                'HTTP_PROXY': '', 'HTTPS_PROXY': '', 'ALL_PROXY': '',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
            }
            result = subprocess.run([str(ROOT / 'bin/edualc-direct'), 'auth', 'status', '--json'],
                                    env=environment, capture_output=True, text=True, timeout=30)
            return result, home

    def test_native_cli_uses_api_key_with_the_shared_configuration_and_history(self):
        result, home = self.launch('sk-ant-api03-edualc-fixture')
        self.assertEqual(result.returncode, 0, result.stderr)
        status = json.loads(result.stdout)
        self.assertTrue(status['loggedIn'])
        self.assertEqual(status['authMethod'], 'api_key')
        self.assertEqual(status['apiKeySource'], 'ANTHROPIC_API_KEY')
        self.assertEqual(Path(status['configDirectory']).resolve(), (home / '.claude').resolve())
        self.assertEqual(Path(status['projectsDirectory']).resolve(), (home / '.claude/projects').resolve())

    def test_missing_edualc_key_does_not_use_inherited_credentials(self):
        result, _ = self.launch('')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('env.ANTHROPIC_API_KEY', result.stderr)


if __name__ == '__main__':
    unittest.main()
