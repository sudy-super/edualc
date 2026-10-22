import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// SDK の出力は一箇所で読み、会話中は generator へ、それ以外は本家のイベント処理へ渡す。
export function createSdkStream(connection: Pick<Query, 'next'>, handlers: {
  idle(message: SDKMessage): Promise<void>;
  failed(error: unknown, inTurn: boolean): Promise<void>;
}) {
  const queued: SDKMessage[] = [];
  let waiting: ReturnType<typeof Promise.withResolvers<IteratorResult<SDKMessage>>> | undefined;
  let failure: unknown;
  let closed = false;
  let active = false;
  let started = false;
  let releaseFrame: (() => void) | undefined;

  function close(error?: unknown) {
    closed = true;
    failure = error;
    queued.length = 0;
    releaseFrame?.();
    releaseFrame = undefined;
    if (error !== undefined) waiting?.reject(error);
    else waiting?.resolve({ done: true, value: undefined });
    waiting = undefined;
  }

  async function pump() {
    try {
      while (!closed) {
        const next = await connection.next();
        if (closed) return;
        if (next.done) throw new Error('The SDK output stream ended unexpectedly');
        if (!active) await handlers.idle(next.value);
        else {
          const consumed = new Promise<void>(done => { releaseFrame = done; });
          if (waiting) {
            waiting.resolve({ done: false, value: next.value });
            waiting = undefined;
          } else queued.push(next.value);
          // 親が次の行を要求するまで待ち、通知・例外を表示処理より先へ進めない。
          await consumed;
        }
      }
    } catch (error) {
      if (closed) return;
      const inTurn = active;
      close(error);
      await handlers.failed(error, inTurn);
    }
  }

  return {
    start() {
      if (started || closed) return;
      started = true;
      // failed は親の終了処理なので、ここで生じた例外も next() に残す。
      void pump().catch(error => close(error));
    },
    beginTurn() {
      if (closed) throw failure ?? new Error('The SDK output stream is closed');
      if (active) throw new Error('The SDK output stream already has an active turn');
      active = true;
    },
    async finishTurn() {
      active = false;
      // 中断と同時に届いた未読の通知も、本家の入力待ち中の処理へ渡す。
      const pending = queued.splice(0);
      try {
        for (const message of pending) await handlers.idle(message);
      } finally {
        releaseFrame?.();
        releaseFrame = undefined;
      }
    },
    next(signal?: AbortSignal): Promise<IteratorResult<SDKMessage>> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      releaseFrame?.();
      releaseFrame = undefined;
      if (failure !== undefined) return Promise.reject(failure);
      const message = queued.shift();
      if (message) return Promise.resolve({ done: false, value: message });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      if (waiting) return Promise.reject(new Error('Overlapping SDK output reads'));
      const pending = Promise.withResolvers<IteratorResult<SDKMessage>>();
      waiting = pending;
      const abort = () => {
        if (waiting === pending) waiting = undefined;
        pending.reject(signal!.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      return pending.promise.finally(() => signal?.removeEventListener('abort', abort));
    },
    close,
  };
}
