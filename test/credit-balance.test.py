import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
import threading
import subprocess
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('credit_balance', ROOT / 'src/credit-balance.py')
balance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(balance)


def response(amount=12.34, organization='Fixture Org', currency='USD'):
    return [{'provider': 'claudeplatform', 'usage': {
        'identity': {'accountOrganization': organization, 'loginMethod': 'Console session'},
        'providerCost': {'balance': amount, 'currencyCode': currency},
    }}]


class CreditBalanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.home = Path(self.directory.name)
        self.config = self.home / '.edualc'
        self.config.mkdir()
        self.auth = self.config / 'runtime-auth.json'
        auth = {'env': {'ANTHROPIC_API_KEY': 'private-api-fixture'}}
        self.auth.write_text(json.dumps(auth))
        (self.config / 'settings.json').write_text(json.dumps(auth))
        (self.config / 'balance.json').write_text(json.dumps({'organization': 'Fixture Org'}))
        self.env = patch.dict(os.environ, {'EDUALC_AUTH_SETTINGS_FILE': str(self.auth)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def cache(self, amount=12.34, **changes):
        value = {'balance': amount, 'organization': 'Fixture Org',
                 'key': balance.key_identity(self.home),
                 'attempted_at': time.time(), 'updated_at': time.time(), **changes}
        balance.atomic_json(self.config / 'balance-cache.json', value)

    def test_actual_balance_including_zero_is_distinct_from_missing_or_invalid(self):
        for value in [0, 12.34, 169.16]:
            self.assertEqual(balance.parse_balance(response(value), 'Fixture Org'), value)
        for value in [None, True, '12.34', -1, float('nan'), float('inf')]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                balance.parse_balance(response(value), 'Fixture Org')

    def test_wrong_organization_currency_and_provider_do_not_supply_balance(self):
        samples = [response(organization='Other Org'), response(currency='EUR'),
                   [{'provider': 'claude', 'usage': response()[0]['usage']}], [],
                   [{'provider': 'claudeplatform', 'error': {'code': 'auth'}}],
                   [['bad payload']], [{'provider': 'claudeplatform', 'usage': None}]]
        for sample in samples:
            with self.subTest(sample=sample), self.assertRaises((ValueError, KeyError)):
                balance.parse_balance(sample, 'Fixture Org')

    def test_original_claude_and_non_api_sessions_do_not_show_credit(self):
        self.cache()
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(balance.status(self.home), '')
        self.auth.write_text(json.dumps({'env': {'CLAUDE_CODE_OAUTH_TOKEN': 'oauth-fixture'}}))
        self.assertEqual(balance.status(self.home), '')

    def test_api_key_change_and_organization_change_invalidate_old_balance(self):
        self.cache()
        self.assertEqual(balance.status(self.home), '$12.34 left')
        with patch.object(balance.subprocess, 'Popen') as spawn:
            (self.config / 'balance.json').write_text(json.dumps({'organization': 'Other Org'}))
            self.assertEqual(balance.status(self.home), 'balance unavailable')
            spawn.assert_called_once()
        (self.config / 'balance.json').write_text(json.dumps({'organization': 'Fixture Org'}))
        auth = {'env': {'ANTHROPIC_API_KEY': 'changed-api-fixture'}}
        self.auth.write_text(json.dumps(auth))
        (self.config / 'settings.json').write_text(json.dumps(auth))
        with patch.object(balance.subprocess, 'Popen'):
            self.assertEqual(balance.status(self.home), 'balance unavailable')

    def test_expiration_starts_detached_refresh_without_waiting_and_failure_drops_old_balance(self):
        self.cache(updated_at=time.time() - balance.TTL - 1,
                   attempted_at=time.time() - balance.TTL - 1)
        with patch.object(balance.subprocess, 'Popen') as spawn:
            self.assertEqual(balance.status(self.home), 'balance unavailable')
            self.assertTrue(spawn.call_args.kwargs['start_new_session'])
        self.cache(error='unavailable')
        with patch.object(balance.subprocess, 'Popen') as spawn:
            self.assertEqual(balance.status(self.home), 'balance unavailable')
            spawn.assert_not_called()

    def test_renewal_keeps_still_valid_balance_visible(self):
        self.cache(updated_at=time.time() - balance.REFRESH_INTERVAL - 1,
                   attempted_at=time.time() - balance.REFRESH_INTERVAL - 1)
        with patch.object(balance.subprocess, 'Popen') as spawn:
            self.assertEqual(balance.status(self.home), '$12.34 left')
            spawn.assert_called_once()

    def test_parallel_refreshes_make_only_one_console_request(self):
        barrier = threading.Barrier(4)
        def request(*args, **kwargs):
            time.sleep(.2)
            return subprocess.CompletedProcess(args[0], 0, json.dumps(response()).encode())
        def run():
            barrier.wait()
            balance.refresh(self.home)
        with patch.object(balance.subprocess, 'run', side_effect=request) as fetch:
            with ThreadPoolExecutor(max_workers=4) as workers:
                list(workers.map(lambda _: run(), range(4)))
            self.assertEqual(fetch.call_count, 1)
        self.assertEqual(balance.status(self.home), '$12.34 left')

    def test_refresh_uses_real_subprocess_without_inheriting_credentials_or_proxy(self):
        executable = self.home / '.local/share/edualc/tools/codexbar/0.79.0/CodexBarCLI'
        executable.parent.mkdir(parents=True)
        # A fake Console client asserts the actual child environment before returning a balance.
        executable.write_text('#!/usr/bin/python3\nimport os,json\n'
            'assert not any(k.startswith(("ANTHROPIC_","CLAUDE_","BUN_","EDUALC_")) for k in os.environ)\n'
            'assert not any("PROXY" in k.upper() for k in os.environ)\n'
            f'print({json.dumps(json.dumps(response()))})\n')
        executable.chmod(0o755)
        with patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'secret-fixture',
                                    'CLAUDE_CODE_OAUTH_TOKEN': 'secret-oauth',
                                    'HTTPS_PROXY': 'http://bad-proxy', 'BUN_OPTIONS': 'bad-preload'}):
            balance.refresh(self.home)
        cache_path = self.config / 'balance-cache.json'
        value = json.loads(cache_path.read_text())
        self.assertEqual(value['balance'], 12.34)
        self.assertNotIn('private-api-fixture', cache_path.read_text())
        self.assertEqual(stat.S_IMODE(cache_path.stat().st_mode), 0o600)
        self.assertEqual(balance.status(self.home), '$12.34 left')
        executable.write_text('#!/bin/sh\nexit 1\n')
        balance.refresh(self.home)
        self.assertNotIn('balance', json.loads(cache_path.read_text()))
        self.assertEqual(balance.status(self.home), 'balance unavailable')


if __name__ == '__main__':
    unittest.main()
