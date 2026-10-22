#!/usr/bin/env python3
"""Install an independent version directory and switch the local command to it."""
import argparse
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keep-sdk', action='store_true', help='Keep the currently selected SDK version.')
    parser.add_argument('--binary', type=Path, help='Claude Code native binary; defaults to the active claude command.')
    parser.add_argument('--launcher', choices=['direct', 'proxy'], default='direct')
    options = parser.parse_args()
    spec = importlib.util.spec_from_file_location('native_layout', ROOT / 'scripts/native-layout.py')
    layout = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(layout)
    source = options.binary or os.environ.get('CLAUDE_NATIVE_BINARY') or shutil.which('claude')
    if not source:
        parser.error('Claude Codeのネイティブ版をインストールしてください。')
    binary = Path(source).resolve()
    data = binary.read_bytes()
    _, records = layout.parse_records(data)
    version = layout.binary_version(data, records)
    del data, records
    target = Path.home() / f'.local/share/edualc/versions/{version}-native.26'
    command = Path.home() / '.local/bin/edualc'
    if target.exists():
        parser.error(f'インストール先が既にあります: {target}')
    if command.exists() and not command.is_symlink():
        parser.error(f'通常ファイルは置き換えません: {command}')
    if options.launcher == 'proxy' and not (Path.home() / '.litellm/claude-launch.sh').is_file():
        parser.error('proxyには ~/.litellm/claude-launch.sh が必要です。')
    launcher = 'edualc-direct' if options.launcher == 'direct' else 'edualc'
    target.mkdir(parents=True)
    try:
        for name in ['bootstrap.mjs', 'package.json', 'package-lock.json']:
            shutil.copy2(ROOT / name, target / name)
        for name in ['bin', 'src', 'profiles']:
            shutil.copytree(ROOT / name, target / name, symlinks=True)
        (target / 'scripts').mkdir()
        for name in ['build-native.py', 'native-layout.py', 'native-ast.mjs',
                     'native-symbols.mjs', 'resolve-native.mjs', 'update-sdk.py', 'check-sdk-update.mjs']:
            shutil.copy2(ROOT / 'scripts' / name, target / 'scripts' / name)
        # The source parser is also needed when verifying the installed native executable.
        shutil.copytree(ROOT / 'node_modules/typescript', target / 'node_modules/typescript')
        (target / 'test/artifacts').mkdir(parents=True)
        (target / 'evidence').mkdir()
        build = [sys.executable, str(target / 'scripts/build-native.py'), '--binary', str(binary)]
        subprocess.run(build, check=True)
        subprocess.run(build + ['--verify'], check=True)
        if not options.keep_sdk:
            subprocess.run([sys.executable, str(target / 'scripts/update-sdk.py')], check=True)
        subprocess.run([str(target / 'bin/edualc-direct'), '--version'], check=True)
    except BaseException:
        shutil.rmtree(target)
        raise
    command.parent.mkdir(parents=True, exist_ok=True)
    pending = command.with_name('edualc.installing')
    if pending.is_symlink():
        pending.unlink()
    pending.symlink_to(target / 'bin' / launcher)
    pending.replace(command)
    print(f'Installed: {command} -> {target / "bin" / launcher}')


if __name__ == '__main__':
    main()
