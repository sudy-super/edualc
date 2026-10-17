import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('update_sdk', Path(__file__).resolve().parents[1] / 'scripts/update-sdk.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class SdkUpdateTests(unittest.TestCase):
    def scenario(self, *, probe_fails=False, corrupt_binary=False):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = Path(directory.name).resolve()
        old = store / 'versions/0.3.301'
        old.mkdir(parents=True)
        current = store / 'current'
        current.symlink_to(old)
        version = '0.3.302'
        target = store / 'versions' / version
        sdk = target / 'node_modules' / updater.PACKAGE
        sdk.mkdir(parents=True)
        (sdk / 'package.json').write_text(json.dumps({'version': version, 'claudeCodeVersion': '2.1.302'}))
        native = sdk.parent / 'claude-agent-sdk-darwin-arm64/claude'
        native.parent.mkdir()
        native.write_bytes(b'binary-fixture')
        (sdk / 'manifest.json').write_text(json.dumps({'version': '2.1.302', 'platforms': {'darwin-arm64': {'checksum': 'corrupt' if corrupt_binary else hashlib.sha256(native.read_bytes()).hexdigest()}}}))

        def command(arguments, **kwargs):
            if arguments[:2] == ['npm', 'view']:
                return SimpleNamespace(stdout=json.dumps(version))
            if arguments[:2] == ['npm', 'install']:
                return SimpleNamespace(stdout='')
            if probe_fails:
                raise subprocess.CalledProcessError(1, arguments, stderr='compatibility failure')
            self.assertEqual(kwargs['env']['EDUALC_SDK_PACKAGE'], str(sdk))
            return SimpleNamespace(stdout=json.dumps({'pass': True, 'checks': ['fixture']}))

        patches = [patch.object(updater, 'STORE', store), patch.object(updater, 'run', side_effect=command),
                   patch.object(updater.platform, 'machine', return_value='arm64'), patch.object(updater.sys, 'platform', 'darwin')]
        for context in patches:
            context.start()
            self.addCleanup(context.stop)
        return current, old, target

    def test_success_selects_verified_candidate_and_keeps_previous_version(self):
        current, old, target = self.scenario()
        updater.update()
        self.assertEqual(current.resolve(), target)
        self.assertTrue(old.is_dir())
        self.assertTrue(json.loads((target / 'verified.json').read_text())['pass'])

    def test_failed_compatibility_check_preserves_current_version(self):
        current, old, target = self.scenario(probe_fails=True)
        with self.assertRaises(subprocess.CalledProcessError):
            updater.update()
        self.assertEqual(current.resolve(), old)
        self.assertFalse((target / 'verified.json').exists())

    def test_corrupt_native_binary_is_not_activated(self):
        current, old, target = self.scenario(corrupt_binary=True)
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            updater.update()
        self.assertEqual(current.resolve(), old)
        self.assertFalse((target / 'verified.json').exists())


if __name__ == '__main__':
    unittest.main()
