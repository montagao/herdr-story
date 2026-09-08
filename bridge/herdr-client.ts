export class HerdrClient {
  private seq = 0;
  private announced = false;
  constructor(private path: string) {}
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = `hs_${++this.seq}`;
    return new Promise((resolve, reject) => {
      let socket: any = null, buffer = '', settled = false;
      const timeout = setTimeout(() => finish(reject, new Error(`timeout ${method}`)), method === 'agent.start' ? 90_000 : 10_000);
      const finish = (complete: (value: any) => void, value: any) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        try { socket?.end(); } catch {}
        complete(value);
      };
      Bun.connect({
        unix: this.path,
        socket: {
          open: (s) => {
            socket = s;
            if (!this.announced) { this.announced = true; console.log(`[bridge] connected ${this.path}`); }
            s.write(JSON.stringify({ id, method, params }) + '\n');
          },
          data: (_s, data) => {
            buffer += data.toString();
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
              if (!line) continue;
              let msg: any; try { msg = JSON.parse(line); } catch { continue; }
              // A parse rejection cannot recover the request id. This socket carries one request.
              if (msg.id !== id && !(msg.id === '' && msg.error?.code === 'invalid_request')) continue;
              if (msg.error) finish(reject, Object.assign(new Error(msg.error.message ?? 'error'), { code: msg.error.code, ...(msg.error.code === 'invalid_request' ? { notSent: true } : {}) }));
              else finish(resolve, msg.result);
            }
          },
          close: () => { if (!settled) finish(reject, new Error(`Herdr connection closed during ${method} before confirming the result`)); },
          error: (_s, e) => finish(reject, e),
        },
      }).catch((e) => finish(reject, e));
    });
  }
}
