import { WS_BASE_URL } from "../config";
import { API_BASE } from "./api";
type MarketSocketListener = (payload: unknown) => void;

type SocketEntry = {
  symbol: string;
  socket: WebSocket | null;
  listeners: Set<MarketSocketListener>;
  reconnectTimer: number | null;
  connectTimer: number | null;
  shouldReconnect: boolean;
  isConnecting: boolean;
  intentionalClose: boolean;
  reconnectAttempts: number;
  connectionId: number;
  lastConnectAt: number;
};

const MAX_RECONNECT_ATTEMPTS = 8;
const MIN_CONNECT_SPACING_MS = 350;
const BASE_RECONNECT_DELAY_MS = 1_200;
const MAX_RECONNECT_DELAY_MS = 12_000;

function resolveWsBaseUrl(): string {
  const envWs = String(import.meta.env.VITE_WS_URL || "").trim();
  const configWs = String(WS_BASE_URL || "").trim();
  const rawWs = envWs || configWs;

  const normalizeWs = (value: string): string => {
    const trimmed = value.trim().replace(/\/$/, "");
    if (!trimmed || trimmed === "/") {
      throw new Error("empty ws base");
    }

    const withProtocol = trimmed.startsWith("ws://") || trimmed.startsWith("wss://")
      ? trimmed
      : trimmed.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

    try {
      const url = new URL(withProtocol);
      const hasExplicitPort = Boolean(url.port);
      const isBareOrigin = url.pathname === "/" || url.pathname === "";
      if (!hasExplicitPort && isBareOrigin) {
        url.port = "8000";
      }
      return url.toString().replace(/\/$/, "");
    } catch {
      return withProtocol;
    }
  };

  try {
    if (rawWs && rawWs !== "/") {
      return normalizeWs(rawWs);
    }

    const apiUrl = new URL(API_BASE);
    apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
    if (!apiUrl.port && (apiUrl.pathname === "/" || apiUrl.pathname === "")) {
      apiUrl.port = "8000";
    }
    return apiUrl.toString().replace(/\/$/, "");
  } catch {
    if (typeof window !== "undefined") {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${protocol}//${window.location.hostname}:8000`;
    }
    return "ws://127.0.0.1:8000";
  }
}

const MARKET_WS_BASE = resolveWsBaseUrl();

function getMarketWsUrl(symbol: string): string {
  return `${MARKET_WS_BASE}/ws/market?symbol=${encodeURIComponent(symbol)}`;
}
function isSocketAlive(socket: WebSocket | null): boolean {
  return !!socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN);
}

class MarketSocketManager {
  private entries = new Map<string, SocketEntry>();
  private paused = typeof document !== "undefined" ? document.visibilityState === "hidden" : false;

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        this.setPaused(document.visibilityState === "hidden");
      });
    }
  }

  private setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;

    if (paused) {
      for (const entry of Array.from(this.entries.values())) {
        this.disconnectButKeepListeners(entry, "page-hidden");
      }
      return;
    }

    for (const entry of Array.from(this.entries.values())) {
      if (entry.listeners.size > 0) {
        entry.shouldReconnect = true;
        entry.intentionalClose = false;
        this.scheduleConnect(entry, 250);
      }
    }
  }

  subscribe(symbol: string, listener: MarketSocketListener): void {
    const key = symbol.trim().toUpperCase();
    if (!key) return;

    const entry = this.ensureEntry(key);
    entry.listeners.add(listener);
    entry.shouldReconnect = true;
    entry.intentionalClose = false;

    if (!this.paused && !isSocketAlive(entry.socket) && !entry.isConnecting) {
      this.scheduleConnect(entry, 0);
    }
  }

  unsubscribe(symbol: string, listener: MarketSocketListener): void {
    const key = symbol.trim().toUpperCase();
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.listeners.delete(listener);

    if (entry.listeners.size === 0) {
      this.closeEntry(entry, "unsubscribe");
      this.entries.delete(key);
    }
  }

  closeAll(): void {
    for (const entry of Array.from(this.entries.values())) {
      this.closeEntry(entry, "closeAll");
    }
    this.entries.clear();
  }

  private ensureEntry(symbol: string): SocketEntry {
    let entry = this.entries.get(symbol);
    if (entry) return entry;

    entry = {
      symbol,
      socket: null,
      listeners: new Set<MarketSocketListener>(),
      reconnectTimer: null,
      connectTimer: null,
      shouldReconnect: true,
      isConnecting: false,
      intentionalClose: false,
      reconnectAttempts: 0,
      connectionId: 0,
      lastConnectAt: 0,
    };
    this.entries.set(symbol, entry);
    return entry;
  }

  private clearTimers(entry: SocketEntry): void {
    if (entry.reconnectTimer != null) {
      window.clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.connectTimer != null) {
      window.clearTimeout(entry.connectTimer);
      entry.connectTimer = null;
    }
  }

  private disconnectButKeepListeners(entry: SocketEntry, reason: string): void {
    entry.intentionalClose = true;
    entry.isConnecting = false;
    this.clearTimers(entry);

    const socket = entry.socket;
    entry.socket = null;
    entry.connectionId += 1;

    if (!socket) return;

    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;

    try {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close(1000, reason);
      }
    } catch {
      // Safe to ignore.
    }
  }

  private closeEntry(entry: SocketEntry, reason: string): void {
    entry.shouldReconnect = false;
    entry.intentionalClose = true;
    entry.isConnecting = false;
    this.clearTimers(entry);

    const socket = entry.socket;
    entry.socket = null;
    entry.connectionId += 1;

    if (!socket) return;

    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;

    try {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close(1000, reason);
      }
    } catch {
      // Browser can throw if the socket is already closing. Safe to ignore.
    }
  }

  private scheduleConnect(entry: SocketEntry, delayMs: number): void {
    if (this.paused || !entry.shouldReconnect || entry.listeners.size === 0) return;
    if (entry.isConnecting || isSocketAlive(entry.socket)) return;

    if (entry.connectTimer != null) {
      window.clearTimeout(entry.connectTimer);
      entry.connectTimer = null;
    }

    const elapsed = Date.now() - entry.lastConnectAt;
    const safeDelay = Math.max(delayMs, elapsed < MIN_CONNECT_SPACING_MS ? MIN_CONNECT_SPACING_MS - elapsed : 0);

    entry.connectTimer = window.setTimeout(() => {
      entry.connectTimer = null;
      this.connect(entry);
    }, safeDelay);
  }

  private connect(entry: SocketEntry): void {
    if (this.paused || entry.isConnecting || isSocketAlive(entry.socket)) return;
    if (!entry.shouldReconnect || entry.listeners.size === 0) return;

    entry.isConnecting = true;
    entry.intentionalClose = false;
    entry.lastConnectAt = Date.now();
    entry.connectionId += 1;

    const connectionId = entry.connectionId;
    const socket = new WebSocket(getMarketWsUrl(entry.symbol));
    entry.socket = socket;

    socket.onopen = () => {
      if (entry.connectionId !== connectionId || entry.socket !== socket) return;
      entry.isConnecting = false;
      entry.reconnectAttempts = 0;
      console.log("[marketSocket] connected", entry.symbol);
    };

    socket.onmessage = (event) => {
      if (entry.connectionId !== connectionId || entry.socket !== socket) return;

      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        console.error("[marketSocket] parse error", entry.symbol, error);
        return;
      }

      for (const listener of Array.from(entry.listeners)) {
        try {
          listener(payload);
        } catch (error) {
          console.error("[marketSocket] listener error", entry.symbol, error);
        }
      }
    };

    socket.onerror = (event) => {
      if (entry.connectionId !== connectionId || entry.socket !== socket) return;

      // Avoid flooding DevTools during intentional React cleanup or rapid symbol switching.
      if (entry.intentionalClose || !entry.shouldReconnect || entry.listeners.size === 0) return;

      console.warn("[marketSocket] socket error", entry.symbol, event);
    };

    socket.onclose = () => {
      if (entry.connectionId !== connectionId || entry.socket !== socket) return;

      entry.isConnecting = false;
      entry.socket = null;

      if (entry.intentionalClose || !entry.shouldReconnect || entry.listeners.size === 0) {
        if (entry.listeners.size === 0) this.entries.delete(entry.symbol);
        return;
      }

      entry.reconnectAttempts += 1;

      if (entry.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.warn("[marketSocket] max reconnect attempts reached", entry.symbol);
        entry.shouldReconnect = false;
        return;
      }

      const jitter = Math.floor(Math.random() * 350);
      const backoff = Math.min(
        MAX_RECONNECT_DELAY_MS,
        BASE_RECONNECT_DELAY_MS * Math.pow(1.45, entry.reconnectAttempts - 1) + jitter
      );

      console.log("[marketSocket] closed", entry.symbol, "retry", entry.reconnectAttempts, "in", Math.round(backoff), "ms");
      this.scheduleConnect(entry, backoff);
    };
  }
}

export const marketSocket = new MarketSocketManager();
