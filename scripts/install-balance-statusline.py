#!/usr/bin/env python3
"""Add the edualc-only balance hook to the existing shared status line."""
from datetime import datetime
from pathlib import Path
import shutil

path = Path.home() / '.claude/statusline.sh'
text = path.read_text()
hook = '''
# edualcの会話がAPIキー認証の場合だけ、Consoleの実残高を表示する。
if [[ -n "${EDUALC_BALANCE_COMMAND-}" && "$model_id" == claude-* ]]; then
  if balance="$("$EDUALC_BALANCE_COMMAND" status 2>/dev/null)"; then
    if [[ -n "$balance" ]]; then
      output="$output | $balance"
    fi
  else
    output="$output | balance unavailable"
  fi
fi
'''
if hook not in text:
    anchor = '\nif [[ -n "$limit_pct" ]]; then'
    if text.count(anchor) != 1 or 'EDUALC_BALANCE_COMMAND' in text:
        raise SystemExit('statuslineの挿入箇所を一意に確認できません。変更していません。')
    backup = path.with_name(f'statusline.sh.before-balance-{datetime.now():%Y%m%d-%H%M%S}')
    shutil.copy2(path, backup)
    path.write_text(text.replace(anchor, hook + anchor))
    print(f'Status line updated; backup: {backup}')
else:
    print('Status line balance hook already installed.')
