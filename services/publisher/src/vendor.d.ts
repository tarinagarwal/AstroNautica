declare module "create-torrent" {
  type Callback = (err: Error | null, torrent: Buffer) => void;
  function createTorrent(input: string | string[], opts: Record<string, unknown>, cb: Callback): void;
  export default createTorrent;
}

declare module "magnet-uri" {
  export function encode(obj: Record<string, unknown>): string;
  export function decode(uri: string): Record<string, unknown>;
}
