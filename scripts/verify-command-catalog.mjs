import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const native = await import('file:///$bunfs/root/chunk-hqtnbrjd.js');
const commands = native.v4();
const records = [];
for (const command of commands) {
  const record = {
    descriptors: Object.fromEntries(Object.entries(Object.getOwnPropertyDescriptors(command)).map(([key, descriptor]) => [key,
      descriptor.get || descriptor.set
        ? { get: descriptor.get ? String(descriptor.get) : null, set: descriptor.set ? String(descriptor.set) : null }
        : { value: typeof descriptor.value === 'function' ? String(descriptor.value) : descriptor.value }])),
    name: command.name,
    type: command.type,
    aliases: command.aliases ?? [],
    description: Object.getOwnPropertyDescriptor(command, 'description')?.value,
    requires: command.requires ?? {},
    enabled: String(command.isEnabled),
    load: typeof command.load === 'function' ? String(command.load) : undefined,
    prompt: typeof command.getPromptForCommand === 'function' ? String(command.getPromptForCommand) : undefined,
  };
  if (command.load) {
    try {
      const module = await command.load();
      const handler = module.call ?? module.default;
      assert.equal(typeof handler, 'function', `Missing handler for /${command.name}`);
      if (process.env.EDUALC_COMMAND_SOURCES === '1') record.handlerSource = String(handler);
      record.handlerHash = createHash('sha256').update(String(handler)).digest('hex');
      record.loaded = true;
    } catch (error) {
      record.loaded = false;
      record.error = error instanceof Error ? error.message : String(error);
    }
  }
  records.push(record);
}
const output = process.env.EDUALC_COMMAND_CATALOG_FILE;
assert.ok(output, 'Set EDUALC_COMMAND_CATALOG_FILE to the disposable artifact path');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ commandEntries: records.length, uniqueNames: new Set(records.map(c => c.name)).size, commands: records }, null, 2) + '\n');
console.log(`Command catalog: ${records.length} entries; ${records.filter(c => c.loaded).length} handlers loaded; ${records.filter(c => c.loaded === false).length} load failures`);
process.exit(records.some(c => c.loaded === false) ? 1 : 0);
