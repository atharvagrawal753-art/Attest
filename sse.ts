import type { Response } from "express";

/** Server-Sent Events fan-out. Pushes alert events to every open console. */
export class EventHub {
  private clients = new Set<Response>();
  private beat?: NodeJS.Timeout;

  add(res: Response) {
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write("retry: 5000\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
    if (!this.beat) {
      // Comment lines keep proxies from closing idle connections.
      this.beat = setInterval(() => this.clients.forEach((c) => c.write(": keep-alive\n\n")), 25_000);
      this.beat.unref();
    }
  }

  publish(event: string, data: unknown) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.clients.forEach((c) => c.write(frame));
  }

  get size() { return this.clients.size; }

  closeAll() {
    if (this.beat) clearInterval(this.beat);
    this.beat = undefined;
    this.clients.forEach((c) => c.end());
    this.clients.clear();
  }
}
