import { loadNativeModule } from '../src/claude.ts';
import { sdkEnvironment, sdkSettings } from '../src/sdk.ts';
globalThis[Symbol.for('edualc.sdk')] = Object.freeze({ originals: new Map() });
const remote = await loadNativeModule('chunk-pq44p05f.js');
const nativeAuth = await loadNativeModule('chunk-2jyw98bz.js');
await nativeAuth.Xht();
const parentToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const child = sdkEnvironment();
const settings = sdkSettings({ env: { ANTHROPIC_API_KEY: 'shared-conflicting-key', CLAUDE_CODE_OAUTH_TOKEN: parentToken } });
const result = {
  remoteTokenUsesOriginalLogin: remote.LC() === parentToken && Boolean(parentToken),
  remoteAsyncTokenUsesOriginalLogin: await remote.$v() === parentToken && Boolean(parentToken),
  remoteBase: remote.xL(),
  childUsesPrivateKey: child.ANTHROPIC_API_KEY === 'sk-ant-private-fixture',
  childDoesNotUseOAuth: child.CLAUDE_CODE_OAUTH_TOKEN === '' && child.ANTHROPIC_AUTH_TOKEN === '',
  childSettingsOverrideSharedAuth: settings.env.ANTHROPIC_API_KEY === 'sk-ant-private-fixture' && settings.env.CLAUDE_CODE_OAUTH_TOKEN === '',
  parentAuthUnchanged: process.env.CLAUDE_CODE_OAUTH_TOKEN === parentToken && !process.env.ANTHROPIC_API_KEY,
};
process.stdout.write(JSON.stringify(result)+'\n');
process.exit(Object.entries(result).every(([key, value]) => key === 'remoteBase' ? value === 'https://api.anthropic.com' : value === true) ? 0 : 1);
