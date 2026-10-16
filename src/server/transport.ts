import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerMessage } from "../shared/protocol.ts";
import type { ServerConfig } from "./config.ts";
import type { Connection, GameServer } from "./gameServer.ts";
import type { Logger } from "./logger.ts";

/**
 * HTTP + WebSocket transport (library: `ws`). WebSocket clients connect to /ws.
 * HTTP endpoints: GET /health (public) and GET /admin/status (Bearer admin token).
 */
export function startTransport(game: GameServer, cfg: ServerConfig, log: Logger): Promise<{ http: Server; wss: WebSocketServer; port: number; close: () => Promise<void> }> {
  const http = createServer((req, res) => handleHttp(game, cfg, req, res));
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.network.maxMessageBytes, perMessageDeflate: { threshold: 1024 } });
  let nextId = 1;

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = req.headers.origin ?? "";
    const allowed = cfg.server.allowedOrigins;
    if (!allowed.includes("*") && origin && !allowed.includes(origin)) {
      log.warn(`Rejected WebSocket from origin ${origin}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const remote = `${req.socket.remoteAddress ?? "?"}:${req.socket.remotePort ?? "?"}`;
    const conn: Connection = {
      id: nextId++,
      remote,
      send(msg: ServerMessage) {
        if (ws.readyState !== ws.OPEN) return;
        const data = JSON.stringify(msg);
        game.netStats.bytesOut += data.length;
        ws.send(data);
      },
      close(code: number, reason: string) {
        ws.close(code, reason);
      },
    };
    game.onConnect(conn);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        conn.send({ t: "error", code: "bad_request", message: "Binary frames are not supported" });
        return;
      }
      game.onMessage(conn, data.toString());
    });
    ws.on("close", () => game.onClose(conn));
    ws.on("error", (e) => log.warn(`WebSocket error from ${remote}: ${e.message}`));
  });

  return new Promise((resolveP, reject) => {
    http.once("error", reject);
    http.listen(cfg.server.port, cfg.server.host, () => {
      const addr = http.address();
      const port = typeof addr === "object" && addr ? addr.port : cfg.server.port;
      resolveP({
        http,
        wss,
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => http.close(() => r()));
          }),
      });
    });
  });
}

function handleHttp(game: GameServer, cfg: ServerConfig, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body, null, 2));
  };
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });
  if (url.pathname === "/health") return json(200, { ok: true, tick: game.world.tick, persistenceError: game.persistStatus.error || null });
  if (url.pathname === "/admin/status") {
    const token = cfg.admin.token;
    if (!token) return json(404, { error: "Admin endpoint disabled (set CODEFARMER_ADMIN_TOKEN)" });
    const auth = req.headers.authorization ?? "";
    const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
    const want = Buffer.from(token);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return json(401, { error: "Unauthorized" });
    return json(200, game.status());
  }
  json(404, { error: "Not found. WebSocket endpoint is /ws" });
}
