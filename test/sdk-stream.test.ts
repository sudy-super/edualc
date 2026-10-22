import { expect, test } from 'bun:test';
import { createSdkStream } from '../src/sdk-stream';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const event = (type: string, uuid: string) => ({ type, uuid }) as SDKMessage;

test('continues reading after result and delivers an idle notification without another input', async () => {
  const afterResult = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<SDKMessage>();
  const connection = (async function* () {
    yield event('assistant', 'answer');
    yield event('result', 'result');
    await afterResult.promise;
    yield event('system', 'completed');
    await new Promise(() => {});
  })() as Query;
  const stream = createSdkStream(connection, { idle: async message => { idle.resolve(message); }, failed: async () => {} });
  stream.beginTurn(); stream.start();
  expect((await stream.next()).value.uuid).toBe('answer');
  expect((await stream.next()).value.uuid).toBe('result');
  afterResult.resolve();
  stream.finishTurn();
  expect(String((await idle.promise).uuid)).toBe('completed');
  stream.close();
});

test('separates consecutive turns without reading the SDK concurrently', async () => {
  let reading = false;
  let index = 0;
  const connection = { async next() {
    expect(reading).toBe(false); reading = true;
    await Promise.resolve(); reading = false;
    return { done: false, value: event(index++ % 2 ? 'result' : 'assistant', String(index)) };
  } } as Pick<Query, 'next'>;
  const stream = createSdkStream(connection, { idle: async () => {}, failed: async () => {} });
  stream.beginTurn(); stream.start();
  for (let turn = 0; turn < 2; turn++) {
    expect((await stream.next()).value.type).toBe('assistant');
    expect((await stream.next()).value.type).toBe('result');
    stream.finishTurn();
    if (!turn) stream.beginTurn();
  }
  stream.close();
});

test('propagates stream failure and releases a pending reader on close', async () => {
  const error = new Error('fixture transport closed');
  const failed = Promise.withResolvers<boolean>();
  const stream = createSdkStream({ next: async () => { throw error; } }, {
    idle: async () => {}, failed: async (_error, inTurn) => { failed.resolve(inTurn); },
  });
  stream.beginTurn();
  const pending = stream.next();
  stream.start();
  await expect(pending).rejects.toBe(error);
  expect(await failed.promise).toBe(true);
  const closed = createSdkStream({ next: async () => new Promise(() => {}) }, { idle: async () => {}, failed: async () => {} });
  const reading = closed.next();
  closed.close();
  expect((await reading).done).toBe(true);
});


test('cancels only the active read without closing the idle SDK reader', async () => {
  const response = Promise.withResolvers<IteratorResult<SDKMessage>>();
  const idle = Promise.withResolvers<SDKMessage>();
  const stream = createSdkStream({ next: () => response.promise }, { idle: async value => { idle.resolve(value); }, failed: async () => {} });
  stream.beginTurn(); stream.start();
  const controller = new AbortController();
  const next = stream.next(controller.signal);
  controller.abort();
  await expect(next).rejects.toBe(controller.signal.reason);
  stream.finishTurn();
  response.resolve({ done: false, value: event('system', 'late-background-event') });
  expect(String((await idle.promise).uuid)).toBe('late-background-event');
  stream.close();
});


test('delivers a frame queued at interruption to the idle handler before the next turn', async () => {
  const consumed = Promise.withResolvers<void>();
  const delivered: string[] = [];
  const stream = createSdkStream({ async next() { consumed.resolve(); return { done: false, value: event('system', 'queued-before-abort') }; } }, {
    idle: async message => { delivered.push(String(message.uuid)); }, failed: async () => {},
  });
  stream.beginTurn(); stream.start();
  await consumed.promise;
  await Promise.resolve();
  await stream.finishTurn();
  expect(delivered).toContain('queued-before-abort');
  stream.close();
});
