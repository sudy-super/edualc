import { loadNativeModule } from './claude';
import type { RunParams } from './sdk-run';
import { sdkRun, alignSdkHistory, getSdkHistory } from './sdk-run';
import { appendFileSync } from 'node:fs';

type Message = RunParams['messages'][number];
type Context = RunParams['toolUseContext'] & {
  messages: Message[];
  onCompactEvent?(event: Record<string, unknown>): void;
  onQueryEvent?(event: Record<string, unknown>): void;
}
interface CompactOptions { customInstructions: string; mainThreadAgentDefinition?: unknown; trigger?: string; origin?: unknown }
interface Dependencies {
  run: typeof sdkRun;
  parameters(context: Context, options: CompactOptions): Promise<RunParams>;
  display(verbose: boolean, text?: string): Promise<string>;
  commandOutput(events: Message[]): Promise<{ type: 'text'; value: string; level?: 'error' } | undefined>;
  align(parentId: string, messages: Message[]): void;
  history(parentId: string): Promise<Message[]>;
  persist(messages: Message[]): Promise<void>;
}

export function createSdkCompact(dependencies: Dependencies) {
  async function compactManually(context: Context, options: CompactOptions) {
    if (context.abortController.signal.aborted) throw new Error('Compaction canceled');
    const params = await dependencies.parameters(context, options);
    const events: Message[] = [];
    let success = false;
    context.onCompactEvent?.({ type: 'sdk_status', status: 'compacting' });
    context.onCompactEvent?.({ type: 'compact_progress', event: { type: 'compact_start' } });
    try {
      const result = dependencies.run({ ...params, sdkCommand: `/compact${options.customInstructions.trim() ? ` ${options.customInstructions.trim()}` : ''}` });
      let terminal;
      while (true) {
        const next = await result.next();
        if (next.done) { terminal = next.value; break; }
        if (next.value.type === 'sdk_status') context.onCompactEvent?.(next.value);
        else events.push(next.value);
      }
      if (terminal?.reason !== 'completed') throw new Error('Compaction canceled');
      const boundaryMarker = events.find(message => message.type === 'system' && message.subtype === 'compact_boundary');
      const commandOutput = await dependencies.commandOutput(events);
      if (!boundaryMarker) {
        if (commandOutput) return commandOutput;
        throw new Error('The SDK did not return a compaction boundary');
      }
      const saved = await dependencies.history(context.session.id);
      const original = new Map(saved.map(message => [message.uuid, message]));
      const metadata = boundaryMarker.compactMetadata;
      const retained: string[] = metadata?.preservedMessages?.uuids ?? [];
      const messagesToKeep = retained.map(uuid => {
        const message = original.get(uuid);
        if (!message) throw new Error(`The SDK retained a message unavailable to the original TUI: ${uuid}`);
        return message;
      });
      const summaryMessages = events.filter(message => message.type === 'user' && !message.isReplay && !retained.includes(message.uuid!))
        .map(message => ({ ...message, isMeta: true, isCompactSummary: true }));
      if (!summaryMessages.length) throw new Error('The SDK did not return the compacted conversation summary');
      const compactionResult = { boundaryMarker, summaryMessages, messagesToKeep, attachments: [], hookResults: [] };
      await dependencies.persist([boundaryMarker, ...summaryMessages, ...messagesToKeep]);
      const displayText = commandOutput?.value ?? await dependencies.display(Boolean(context.options.verbose));
      dependencies.align(context.session.id, [boundaryMarker, ...summaryMessages, ...messagesToKeep]);
      success = true;
      return {
        type: 'compact' as const, compactionResult,
        displayText,
        displayRepeatsSummary: false,
        result: { tokensBefore: metadata?.preTokens, tokensAfter: metadata?.postTokens },
      };
    } catch (error) {
      if (process.env.EDUALC_TRACE === '1') appendFileSync(new URL('../test/artifacts/sdk-run.jsonl', import.meta.url), `${JSON.stringify({ at: new Date().toISOString(), kind: 'sdk_compact_error', error: String(error) })}\n`);
      throw error;
    } finally {
      context.onQueryEvent?.({ type: 'response_length', op: 'reset' });
      context.onCompactEvent?.({ type: 'compact_progress', event: { type: 'compact_end' } });
      context.onCompactEvent?.({ type: 'sdk_status', status: null, metadata: { compactResult: success ? 'success' : 'failed' } });
    }
  }
  return { compactManually, call(instructions: string, context: Context) { return compactManually(context, { customInstructions: instructions }); } };
}

type NativeDisplay = (verbose: boolean, text?: string) => string;
function nativeCompact(display: NativeDisplay) {
  if (typeof display !== 'function') throw new Error('The native compact display callback is required');
  return createSdkCompact({
    run: sdkRun, align: alignSdkHistory, history: getSdkHistory,
    persist: async messages => {
      const writer = await loadNativeModule('chunk-hqtnbrjd.js');
      await writer.Ov(messages);
      await writer.Ou();
      await writer._Fn();
    },
    commandOutput: async events => {
      const [{ Ms }, { km }] = await Promise.all([
        loadNativeModule('chunk-nhvhsxnt.js'),
        loadNativeModule('chunk-25a3z2dq.js'),
      ]);
      for (const event of events.toReversed()) {
        if (!(event.type === 'user' && event.isReplay) && !(event.type === 'system' && event.subtype === 'local_command')) continue;
        const content = event.type === 'user' ? event.message?.content : event.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
        const stderr = Ms(text, 'local-command-stderr');
        if (stderr !== null) return { type: 'text', value: km(stderr), level: 'error' };
        const stdout = Ms(text, 'local-command-stdout');
        if (stdout !== null) return { type: 'text', value: km(stdout) };
      }
    },
    parameters: async (context, options) => {
      const native = await loadNativeModule('chunk-w899cfp5.js');
      const params = await native.f5t({ toolUseContext: context, forkContextMessages: context.messages, mainThreadAgentDefinition: options.mainThreadAgentDefinition });
      return { ...params, messages: context.messages, canUseTool: async () => ({ behavior: 'deny', message: 'Compaction cannot execute tools' }) };
    },
    display: async (verbose, text) => display(verbose, text),
  });
}
export function sdkCompactCall(instructions: string, context: Context, display: NativeDisplay) {
  return nativeCompact(display).call(instructions, context);
}
export function sdkCompactManually(context: Context, options: CompactOptions, display: NativeDisplay) {
  return nativeCompact(display).compactManually(context, options);
}
