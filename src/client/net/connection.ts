import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "../../shared/protocol.ts";

export type ConnectionStatus = "idle" | "connecting" | "online" | "reconnecting" | "offline";

export interface Credentials {
  name: string;
  race: string;
  token?: string;
}

type Pending = { resolve: (m: ServerMessage) => void; timer: ReturnType<typeof setTimeout> };

/**
 * WebSocket client with request/response correlation (reqId) and automatic
 * reconnection using the saved login token. It never simulates anything: the
 * server's messages are the only source of game state.
 */
export class GameConnection {
  readonly url: string;
  private ws: WebSocket | null = null;
  private creds: Credentials | null = null;
  private nextReq = 1;
  private pending = new Map<number, Pending>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private everWelcomed = false;
  status: ConnectionStatus = "idle";
  onMessage: (m: ServerMessage) => void = () => {};
  onStatus: (s: ConnectionStatus, detail?: string) => void = () => {};
  /** Called on (re)connection after welcome so the app can resubscribe. */
  onReady: () => void = () => {};

  constructor(url: string) {
    this.url = url;
  }

  connect(creds: Credentials): void {
    this.creds = creds;
    this.closedByUser = false;
    this.open();
  }

  /** Update the token after the server issues one (first login). */
  setToken(token: string): void {
    if (this.creds) this.creds.token = token;
  }

  private setStatus(s: ConnectionStatus, detail?: string): void {
    this.status = s;
    this.onStatus(s, detail);
  }

  private open(): void {
    if (!this.creds) return;
    this.setStatus(this.everWelcomed ? "reconnecting" : "connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.setStatus("offline", `Invalid server URL: ${(e as Error).message}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const c = this.creds;
      if (!c) return;
      const hello: ClientMessage = { t: "hello", v: PROTOCOL_VERSION, name: c.name, race: c.race };
      if (c.token) hello.token = c.token;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        console.error("Malformed server message", ev.data);
        return;
      }
      if (m.t === "welcome") {
        this.retry = 0;
        this.everWelcomed = true;
        this.setToken(m.token);
        this.setStatus("online");
      }
      if (m.t === "kicked") this.closedByUser = true;
      if ("reqId" in m && typeof m.reqId === "number") {
        const p = this.pending.get(m.reqId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.reqId);
          p.resolve(m);
        }
      }
      this.onMessage(m);
      if (m.t === "welcome") this.onReady();
      if (m.t === "error" && !this.everWelcomed && m.reqId === undefined && ["bad_name", "name_taken", "bad_token", "bad_race", "protocol_version", "server_full"].includes(m.code)) {
        this.closedByUser = true;
        ws.close();
        this.setStatus("offline", m.message);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ t: "error", reqId: id, code: "disconnected", message: "Connection lost before the server replied" });
      }
      this.pending.clear();
      if (this.closedByUser) {
        if (this.status !== "offline") this.setStatus("offline");
        return;
      }
      const delay = Math.min(15_000, 1000 * 2 ** this.retry++);
      this.setStatus(this.everWelcomed ? "reconnecting" : "offline", `Connection lost; retrying in ${Math.round(delay / 1000)}s`);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
  }

  /** Fire-and-forget message (subscribe). */
  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Send a request with a fresh reqId and resolve with the server's ack/error/program reply. */
  request(msg: Record<string, unknown> & { t: string }): Promise<ServerMessage> {
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        resolve({ t: "error", reqId, code: "offline", message: "Not connected to the server" });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve({ t: "error", reqId, code: "timeout", message: "The server did not reply in time" });
      }, 10_000);
      this.pending.set(reqId, { resolve, timer });
      this.ws.send(JSON.stringify({ ...msg, reqId }));
    });
  }
}

export function defaultServerUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SERVER_URL;
  if (env) return env;
  const host = typeof location !== "undefined" && location.hostname ? location.hostname : "127.0.0.1";
  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${host}:3001/ws`;
}
