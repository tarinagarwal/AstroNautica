/**
 * Comments (NIP-22) and reactions (NIP-25) on a story (spec §7), filtered by core: valid signature, committed
 * proof-of-work, not hidden, author not muted. Posting mines proof-of-work first and publishes to every relay.
 */
import {
  KIND_COMMENT,
  KIND_REACTION,
  buildCommentThread,
  commentTemplate,
  countReactions,
  myReactions,
  reactionTemplate,
  type CommentNode,
  type Event,
  type PublishResult,
  type Reaction,
  type StoryRef,
} from "@azaadawaaz/core";
import type { AppData } from "./appData";
import { mineEvent, type NativeMiner } from "./pow";

export interface SocialState {
  comments: CommentNode[];
  reactions: Record<Reaction, number>;
  mine: Set<Reaction>;
  total: number;
}

export class StorySocial {
  private readonly events = new Map<string, Event>();
  private unsub?: () => void;

  constructor(
    private readonly app: AppData,
    private readonly story: StoryRef,
    private readonly miner?: NativeMiner,
  ) {}

  private filters() {
    return [
      { kinds: [KIND_COMMENT], "#A": [this.story.address], limit: 500 },
      { kinds: [KIND_REACTION], "#a": [this.story.address], limit: 2000 },
    ];
  }

  async load(): Promise<void> {
    const relays = this.app.relayUrls();
    const results = await Promise.all(
      this.filters().map((f) => this.app.pool.query(relays, f).catch(() => [] as Event[])),
    );
    for (const e of results.flat()) this.events.set(e.id, e);
  }

  watch(onChange: () => void): () => void {
    const relays = this.app.relayUrls();
    const since = Math.floor(Date.now() / 1000) - 30;
    const subs = this.filters().map((f) =>
      this.app.pool.subscribe(relays, { ...f, since }, (e) => {
        if (!this.events.has(e.id)) {
          this.events.set(e.id, e);
          onChange();
        }
      }),
    );
    this.unsub = () => subs.forEach((s) => s());
    return this.unsub;
  }

  state(myPubkey?: string): SocialState {
    const lists = this.app.lists ?? { hidden: new Set<string>(), muted: new Set<string>() };
    const all = [...this.events.values()];
    const minPow = this.app.config.powDifficulty;
    const comments = buildCommentThread(all, this.story.address, lists, minPow);
    const count = (ns: CommentNode[]): number => ns.reduce((n, c) => n + 1 + count(c.replies), 0);
    return {
      comments,
      reactions: countReactions(all, this.story.address, lists, minPow),
      mine: myPubkey ? myReactions(all, this.story.address, myPubkey) : new Set(),
      total: count(comments),
    };
  }

  private async post(template: Parameters<typeof mineEvent>[0], secretKey: Uint8Array, signal?: AbortSignal) {
    const event = await mineEvent(template, secretKey, this.app.config.powDifficulty, this.miner, signal);
    const results: PublishResult[] = await this.app.publish(event);
    if (results.some((r) => r.ok)) this.events.set(event.id, event);
    return { event, results };
  }

  comment(text: string, secretKey: Uint8Array, parent?: Event, signal?: AbortSignal) {
    return this.post(commentTemplate({ story: this.story, content: text, parent }), secretKey, signal);
  }

  react(reaction: Reaction, secretKey: Uint8Array, signal?: AbortSignal) {
    return this.post(reactionTemplate({ story: this.story, reaction }), secretKey, signal);
  }

  close(): void {
    this.unsub?.();
  }
}
