import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

// jsdom has no object URLs; the app only needs unique strings for verified blobs.
let n = 0;
if (!URL.createObjectURL) URL.createObjectURL = () => `blob:test/${++n}`;
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

// jsdom has no canvas; blurhash placeholders and QR codes simply stay blank in unit tests.
if (typeof HTMLCanvasElement !== "undefined")
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];

// jsdom's Blob has no arrayBuffer() and can't be structured-cloned into (fake) IndexedDB; browsers' Blob can do
// both, and so can Node's, so tests use Node's.
globalThis.Blob = NodeBlob as unknown as typeof Blob;
