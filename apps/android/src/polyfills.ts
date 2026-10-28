// Order matters: crypto.getRandomValues and URL first (nostr-tools and @noble use them at module load), then the
// language polyfills Hermes lacks.
import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import { installLanguagePolyfills } from "./polyfills/lang";

installLanguagePolyfills();
