import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Actions } from "./actions.ts";
import { GameConnection, defaultServerUrl } from "./net/connection.ts";
import { GameState } from "./state/gameState.ts";
import { GameContext, HoverStore, type GameContextValue } from "./ui/context.ts";
import { GameView } from "./ui/GameView.tsx";
import { LoginScreen, type SavedLogin } from "./ui/LoginScreen.tsx";
import { rendererRef } from "./ui/WorldCanvas.tsx";

const profile = new URLSearchParams(location.search).get("profile") ?? "default";

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode); logins will not be remembered */
  }
}
const loginKey = (url: string): string => `codefarmer:${profile}:login:${url}`;
const urlKey = `codefarmer:${profile}:server`;

function loadSaved(url: string): SavedLogin | null {
  const raw = storageGet(loginKey(url));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SavedLogin;
    return typeof v.name === "string" && typeof v.token === "string" ? v : null;
  } catch {
    return null;
  }
}

export function App(): JSX.Element {
  const [serverUrl, setServerUrl] = useState(() => storageGet(urlKey) ?? defaultServerUrl());
  const [saved, setSaved] = useState<SavedLogin | null>(() => loadSaved(serverUrl));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inGame, setInGame] = useState(false);
  const state = useMemo(() => new GameState(), []);
  const hover = useMemo(() => new HoverStore(), []);
  const connRef = useRef<GameConnection | null>(null);
  const [ctx, setCtx] = useState<GameContextValue | null>(null);

  const logout = useCallback(() => {
    connRef.current?.close();
    connRef.current = null;
    state.reset();
    state.playerId = 0;
    setInGame(false);
    setCtx(null);
    setBusy(false);
  }, [state]);

  const login = useCallback(
    (opts: { serverUrl: string; name: string; race: string; token?: string }) => {
      setError("");
      setBusy(true);
      setServerUrl(opts.serverUrl);
      storageSet(urlKey, opts.serverUrl);
      connRef.current?.close();
      const conn = new GameConnection(opts.serverUrl);
      connRef.current = conn;
      const actions = new Actions(conn, state);
      conn.onStatus = (s, detail) => {
        state.setConnection(s, detail ?? "");
        if (s === "offline" && !state.playerId) {
          setBusy(false);
          setError(detail || `Could not connect to ${opts.serverUrl}. Is the game server running (npm run server)?`);
        }
      };
      conn.onMessage = (m) => {
        state.apply(m);
        if (m.t === "welcome") {
          const s = { name: m.name, token: m.token };
          storageSet(loginKey(opts.serverUrl), JSON.stringify(s));
          setSaved(s);
          setBusy(false);
          setInGame(true);
        }
        if (m.t === "error" && m.reqId === undefined && !state.playerId) {
          setError(m.message);
          if (m.code === "bad_token") {
            storageSet(loginKey(opts.serverUrl), null);
            setSaved(null);
          }
        }
      };
      conn.onReady = () => rendererRef.current?.resubscribe();
      setCtx({ state, actions, hover, logout });
      const creds: { name: string; race: string; token?: string } = { name: opts.name, race: opts.race };
      if (opts.token) creds.token = opts.token;
      conn.connect(creds);
    },
    [state, hover, logout],
  );

  useEffect(() => () => connRef.current?.close(), []);

  if (!inGame || !ctx) {
    return (
      <LoginScreen
        serverUrl={serverUrl}
        saved={saved}
        error={error}
        busy={busy}
        onLogin={login}
        onForget={() => {
          storageSet(loginKey(serverUrl), null);
          setSaved(null);
        }}
      />
    );
  }
  return (
    <GameContext.Provider value={ctx}>
      <GameView />
    </GameContext.Provider>
  );
}
