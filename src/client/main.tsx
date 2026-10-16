import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// New Rocker (SIL Open Font License), bundled so the game needs no font server at runtime.
import "@fontsource/new-rocker/400.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
