#!/usr/bin/env python3
"""Install an independent version directory and switch the local command to it."""
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
target = Path.home() / '.local/share/edualc/versions/2.1.302'
command = Path.home() / '.local/bin/edualc'
if target.exists():
    sys.exit(f'インストール先が既にあります: {target}')
if command.exists() and not command.is_symlink():
    sys.exit(f'通常ファイルは置き換えません: {command}')
if not (root / 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs').is_file():
    sys.exit('先に npm ci --omit=optional を実行してください。')

target.mkdir(parents=True)
for name in ['bootstrap.mjs', 'package.json', 'package-lock.json']:
    shutil.copy2(root / name, target / name)
for name in ['bin', 'src', 'node_modules']:
    shutil.copytree(root / name, target / name, symlinks=True)
(target / 'scripts').mkdir()
for name in ['extract.py', 'extract-full.py', 'imports.mjs', 'update-sdk.py', 'check-sdk-update.mjs']:
    shutil.copy2(root / 'scripts' / name, target / 'scripts' / name)
(target / 'test/artifacts').mkdir(parents=True)

# 抽出コードの絶対参照をインストール先に合わせて生成する。
subprocess.run([sys.executable, str(target / 'scripts/extract-full.py')], check=True)
subprocess.run([sys.executable, str(target / 'scripts/update-sdk.py')], check=True)
subprocess.run([str(target / 'bin/edualc-direct'), '--version'], check=True)
command.parent.mkdir(parents=True, exist_ok=True)
pending = command.with_name('edualc.installing')
pending.symlink_to(target / 'bin/edualc')
pending.replace(command)
print(f'Installed: {command} -> {target / "bin/edualc"}')
