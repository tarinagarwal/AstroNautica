import type { Event, PublishResult } from "@azaadawaaz/core";
import type { AuditForwarder } from "./audit.js";

export interface RelayPublisher {
  publish(relays: string[], event: Event): Promise<PublishResult[]>;
}

/** Forwards audit events to our own relays in the background; failures are logged (relay URL only), never thrown. */
export class RelayAuditForwarder implements AuditForwarder {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly pool: RelayPublisher,
    private readonly relays: () => string[],
    private readonly log: { warn(obj: object, msg?: string): void },
  ) {}

  forward(event: Event): void {
    const relays = this.relays();
    if (relays.length === 0) return;
    const p = this.pool
      .publish(relays, event)
      .then((results) => {
        const failed = results.filter((r) => !r.ok).map((r) => r.relay);
        if (failed.length) this.log.warn({ eventId: event.id, failed }, "audit event not accepted by every relay");
      })
      .catch((e: unknown) => this.log.warn({ err: e instanceof Error ? e.message : String(e) }, "audit forward failed"))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Wait for in-flight forwards (used on shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
