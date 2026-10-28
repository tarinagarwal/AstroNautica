/**
 * Metro resolves `libsodium-wrappers` to this module (see metro.config.js): packages/core's staging code then runs on
 * native libsodium. Never imported directly by app code.
 */
import NativeAzaadSodium from "../native/specs/NativeAzaadSodium";
import { createSodiumAdapter } from "./sodiumAdapter";

const sodium = createSodiumAdapter(NativeAzaadSodium);
export default sodium;
