import { http, type Transport } from "viem";

/** Space request starts across all readers/signers sharing this transport. */
export function requestGate(intervalMs = 200) {
  let next = 0;
  return async () => {
    const slot = Math.max(Date.now(), next);
    next = slot + intervalMs;
    const delay = slot - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  };
}
export function limitedHttp(url: string, intervalMs = 200): Transport {
  const enter = requestGate(intervalMs);
  const base = http(url, { timeout: 10000, retryCount: 0 });
  return (options) => {
    const transport = base(options);
    const request: typeof transport.request = async (args, requestOptions) => {
      await enter();
      return transport.request(args, requestOptions);
    };
    return { ...transport, request };
  };
}
