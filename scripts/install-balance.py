#!/usr/bin/env python3
"""Install the pinned CodexBar CLI used for Console credit balances."""
import hashlib
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile

VERSION = '0.79.0'
DIGESTS = {
    'arm64': '26929fd4bc5a62687d1498dda6cc4798761192e43d5dd342cf7f7f13576ba33e',
    'x86_64': '9664c8e146926e7e43796744ec67bbf7e987c3abec385e1b0f2893f44959910f',
}


def main():
    architecture = platform.machine()
    if platform.system() != 'Darwin' or architecture not in DIGESTS:
        raise SystemExit('残高取得の自動設定はmacOSのChromeを対象としています。')
    target = Path.home() / f'.local/share/edualc/tools/codexbar/{VERSION}'
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        name = f'CodexBarCLI-v{VERSION}-macos-{architecture}.tar.gz'
        with tempfile.TemporaryDirectory(dir=target.parent) as staging:
            archive = Path(staging) / name
            subprocess.run([
                '/usr/bin/curl', '--fail', '--location', '--silent', '--show-error',
                '--noproxy', '*', '--max-time', '120', '--output', str(archive),
                f'https://github.com/steipete/CodexBar/releases/download/v{VERSION}/{name}',
            ], check=True)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != DIGESTS[architecture]:
                raise SystemExit('CodexBarのSHA256が一致しません。')
            unpacked = Path(staging) / 'unpacked'
            with tarfile.open(archive) as bundle:
                bundle.extractall(unpacked, filter='data')
            subprocess.run([str(unpacked / 'CodexBarCLI'), '--version'], check=True)
            unpacked.rename(target)
    print(f'CodexBar CLI: {target / "CodexBarCLI"}')


if __name__ == '__main__':
    main()
