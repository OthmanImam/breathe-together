/**
 * Minimal WebSocket client for the breath protocol. No reconnection logic
 * here — the app layer decides what to do on disconnect (calm notice +
 * reconnect offer, Step 5). Reconnecting is a fresh connection with a fresh
 * hello; consent is per page load, and a reconnect does NOT re-grant it.
 */

import {
  encodeFrameHeader,
  type ClientMessage,
  type ServerMessage,
} from "../server/protocol.js";

export type ConnectionState = "connecting" | "open" | "closed";

export class WsClient {
  private socket: WebSocket | undefined;
  private state: ConnectionState = "closed";
  private messageCb: (m: ServerMessage) => void = () => undefined;
  private stateCb: (s: ConnectionState) => void = () => undefined;

  onMessage(cb: (m: ServerMessage) => void): void {
    this.messageCb = cb;
  }
  onState(cb: (s: ConnectionState) => void): void {
    this.stateCb = cb;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(url: string): void {
    const socket = new WebSocket(url);
    this.socket = socket;
    this.setState("connecting");
    socket.addEventListener("open", () => this.setState("open"));
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.setState("closed");
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      try {
        this.messageCb(JSON.parse(ev.data) as ServerMessage);
      } catch {
        // Malformed server frames are ignored; the server never sends them.
      }
    });
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  /** Send one camera frame: 8-byte µs header + raw RGBA pixels. */
  sendFrame(pixels: Uint8Array, timestampUs: number, maxBufferedBytes = 65_536): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > maxBufferedBytes) return false; // back-pressure: skip, don't queue
    const header = encodeFrameHeader(timestampUs);
    const out = new Uint8Array(header.length + pixels.length);
    out.set(header, 0);
    out.set(pixels, header.length);
    this.socket.send(out);
    return true;
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.setState("closed");
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.stateCb(s);
  }
}
