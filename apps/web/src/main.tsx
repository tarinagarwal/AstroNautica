import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/noto-sans/latin-400.css";
import "@fontsource/noto-sans/latin-700.css";
import "@fontsource/noto-sans-devanagari/devanagari-400.css";
import "@fontsource/noto-sans-devanagari/devanagari-700.css";
import "./styles.css";
import { App } from "./App.js";
import { AppData } from "./data/appData.js";
import { RelayPool } from "@core/relays.js";
import { getConfig } from "./config.js";

const app = new AppData(getConfig(), new RelayPool());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>,
);
