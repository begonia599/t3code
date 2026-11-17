import type { DesktopMcpProgress } from "@t3tools/contracts";

/** SDK progress callbacks cannot await delivery. Keep one send and replace one pending value. */
export function createLatestMcpProgress(send: (value: DesktopMcpProgress) => Promise<void>) {
  let pending: DesktopMcpProgress | undefined;
  let sending: Promise<void> | undefined;
  let closed = false;
  let failed = false;
  let failure: unknown;
  const stop = () => {
    closed = true;
    pending = undefined;
  };
  return {
    push(value: DesktopMcpProgress) {
      if (closed) return;
      pending = value;
      if (sending) return;
      sending = (async () => {
        try {
          while (pending) {
            const value = pending;
            pending = undefined;
            await send(value);
          }
        } catch (cause) {
          failed = true;
          failure = cause;
          stop();
        } finally {
          sending = undefined;
        }
      })();
    },
    stop,
    async finish() {
      stop();
      await sending;
      if (failed) throw failure;
    },
  };
}
