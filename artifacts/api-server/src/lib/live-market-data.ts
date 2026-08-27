import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";
import { calculateFinalExecutionStake } from "./compound";
import {
  AutomaticPairExecutionSupervisor,
  type AutomaticPairExecutionStatus,
  type PairExecutionCandidate,
} from "./automatic-pair-execution";
import { OpportunityLogStore, OPPORTUNITY_LOG_THRESHOLD_PUSD, type OpportunityLogEntry } from "./opportunity-log";

const execFileAsync = promisify(execFile);
const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/btcusdt@ticker";
const POSITIONS_URL = "https://data-api.polymarket.com/positions";
const GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const FRESHNESS_MS = 8_000;
const MARKET_REFRESH_MS = 15_000;
const CONNECT_TIMEOUT_MS = 10_000;
const API_SERVER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CLOB_BALANCE_HELPER = path.resolve(
  API_SERVER_DIR,
  "scripts/read_clob_collateral_balance.py",
);

type BookLevel = { price: number; size: number };
type Position = { size: number | null; value: number | null };
type ActiveMarket = {
  conditionId: string | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  endAt: number | null;
  configured: boolean;
};

export type LiveMarketSnapshot = {
  ready: boolean;
  message: string;
  sequence: number;
  serverTime: string;
  market: {
    conditionId: string | null;
    yesTokenId: string | null;
    noTokenId: string | null;
    endAt: string | null;
    configured: boolean;
    streamConnected: boolean;
    lastBookAt: string | null;
  };
  spot: {
    priceUsd: number | null;
    change60sPct: number | null;
    lastEventAt: string | null;
    connected: boolean;
  };
  quotes: {
    yesBestAsk: number | null;
    yesAskSize: number | null;
    yesAskLevels: number | null;
    noBestAsk: number | null;
    noAskSize: number | null;
    noAskLevels: number | null;
    combinedAsk: number | null;
    commonDepth: number | null;
    edge: number | null;
    fresh: boolean;
  };
  wallet: {
    balancePusd: number | null;
    source: string;
    lastUpdatedAt: string | null;
  };
  inventory: {
    yesShares: number | null;
    noShares: number | null;
    netShares: number | null;
    atRiskPusd: number | null;
    source: string;
    lastUpdatedAt: string | null;
  };
  compound: {
    finalExecutionStakePusd: number | null;
    walletMaxStakePusd: number | null;
    marketAvailableVolumePusd: number | null;
    executable: boolean;
    reason: string;
  };
  execution: AutomaticPairExecutionStatus;
};

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function configuredMarket() {
  const conditionId = process.env.POLYMARKET_CONDITION_ID?.trim() || null;
  const yesTokenId = process.env.POLYMARKET_YES_TOKEN_ID?.trim() || null;
  const noTokenId = process.env.POLYMARKET_NO_TOKEN_ID?.trim() || null;
  return {
    conditionId,
    yesTokenId,
    noTokenId,
    endAt: null,
    configured: Boolean(conditionId && yesTokenId && noTokenId),
  };
}

function parsedStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function activeMarketFromGamma(value: unknown): ActiveMarket | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.active === false || record.closed === true) return null;
  const accepting = record.accepting_orders ?? record.acceptingOrders;
  if (accepting !== true) return null;
  const outcomes = parsedStringArray(record.outcomes);
  const tokenIds = parsedStringArray(record.clobTokenIds ?? record.clob_token_ids);
  const upIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "up");
  const downIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "down");
  const conditionId = stringOrNull(record.conditionId ?? record.condition_id);
  const endDate = stringOrNull(record.endDate ?? record.end_date_iso);
  const endAt = endDate ? Date.parse(endDate) : Number.NaN;
  if (
    !conditionId ||
    upIndex < 0 ||
    downIndex < 0 ||
    !tokenIds[upIndex] ||
    !tokenIds[downIndex] ||
    !Number.isFinite(endAt) ||
    endAt <= Date.now()
  ) {
    return null;
  }
  return {
    conditionId,
    yesTokenId: tokenIds[upIndex],
    noTokenId: tokenIds[downIndex],
    endAt,
    configured: true,
  };
}

function proxyUrl(): string | null {
  return process.env.RESIDENTIAL_PROXY_URL?.trim() || null;
}

function asIso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function isFresh(timestamp: number | null): boolean {
  return timestamp !== null && Date.now() - timestamp <= FRESHNESS_MS;
}

function clobBalancePython(): string | null {
  // POLYMARKET_BALANCE_PYTHON is the dedicated override; POLYMARKET_EXECUTION_PYTHON
  // is accepted as a fallback because both must point at the same interpreter that
  // has the Polymarket CLOB client installed (deployments only configure one var).
  const configured =
    process.env.POLYMARKET_BALANCE_PYTHON?.trim() ||
    process.env.POLYMARKET_EXECUTION_PYTHON?.trim();
  // An explicit override is trusted as-is: it may be a bare command name (e.g.
  // "python3") meant to be resolved via $PATH, which existsSync() cannot check
  // since it only tests literal filesystem paths, not PATH lookups.
  if (configured) return configured;
  const candidates = [
    // Replit/Nix workspaces install the uv-managed interpreter here.
    path.resolve(process.cwd(), ".pythonlibs/bin/python"),
    path.resolve(API_SERVER_DIR, "../../.pythonlibs/bin/python"),
    // Plain `uv sync` (e.g. on a self-hosted VPS) creates a standard .venv instead.
    path.resolve(process.cwd(), ".venv/bin/python3"),
    path.resolve(process.cwd(), ".venv/bin/python"),
    path.resolve(API_SERVER_DIR, "../../.venv/bin/python3"),
    path.resolve(API_SERVER_DIR, "../../.venv/bin/python"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function curlJsonThroughProxy(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const proxy = proxyUrl();
  if (!proxy) throw new Error("RESIDENTIAL_PROXY_URL is not configured");

  const args = [
    "--silent",
    "--show-error",
    "--fail",
    "--location",
    "--max-time",
    "12",
    "--proxy",
    proxy,
  ];
  for (const [name, value] of Object.entries(headers)) {
    args.push("--header", `${name}: ${value}`);
  }
  args.push(url);

  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}

/**
 * Performs a SOCKS5 handshake (RFC 1928, username/password auth per RFC 1929)
 * on an already-connected raw socket, then calls onReady once the proxy has
 * established a tunnel to target. Used when the configured residential proxy
 * only speaks SOCKS5 (some proxy plans -- e.g. dedicated/static residential --
 * do not offer an HTTP CONNECT port at all).
 */
function socksHandshake(
  rawSocket: net.Socket,
  proxy: URL,
  target: URL,
  onReady: () => void,
  onError: (message: string) => void,
) {
  const username = proxy.username ? decodeURIComponent(proxy.username) : "";
  const password = proxy.password ? decodeURIComponent(proxy.password) : "";
  const useAuth = username.length > 0 || password.length > 0;
  let stage: "greeting" | "auth" | "connect" = "greeting";
  let buffer = Buffer.alloc(0);

  function sendConnectRequest() {
    const port = Number(target.port || 443);
    const hostBuf = Buffer.from(target.hostname, "utf8");
    stage = "connect";
    rawSocket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]),
    );
  }

  function pump() {
    if (stage === "greeting") {
      if (buffer.length < 2) return;
      const version = buffer[0];
      const method = buffer[1];
      buffer = buffer.subarray(2);
      if (version !== 0x05) return onError(`unexpected SOCKS version ${version}`);
      if (method === 0xff) return onError("proxy rejected all authentication methods");
      if (method === 0x02) {
        stage = "auth";
        const userBuf = Buffer.from(username, "utf8");
        const passBuf = Buffer.from(password, "utf8");
        rawSocket.write(
          Buffer.concat([
            Buffer.from([0x01, userBuf.length]),
            userBuf,
            Buffer.from([passBuf.length]),
            passBuf,
          ]),
        );
      } else {
        sendConnectRequest();
      }
      return pump();
    }
    if (stage === "auth") {
      if (buffer.length < 2) return;
      const status = buffer[1];
      buffer = buffer.subarray(2);
      if (status !== 0x00) return onError("authentication failed");
      sendConnectRequest();
      return pump();
    }
    if (stage === "connect") {
      if (buffer.length < 4) return;
      const reply = buffer[1];
      const addrType = buffer[3];
      let addrLen: number;
      if (addrType === 0x01) addrLen = 4;
      else if (addrType === 0x04) addrLen = 16;
      else if (addrType === 0x03) {
        if (buffer.length < 5) return;
        addrLen = 1 + buffer[4];
      } else {
        return onError(`unknown SOCKS address type ${addrType}`);
      }
      if (buffer.length < 4 + addrLen + 2) return;
      if (reply !== 0x00) return onError(`CONNECT failed with code ${reply}`);
      rawSocket.off("data", onData);
      onReady();
    }
  }

  function onData(chunk: Buffer) {
    buffer = Buffer.concat([buffer, chunk]);
    pump();
  }

  rawSocket.on("data", onData);
  rawSocket.write(
    useAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]),
  );
}

/**
 * A narrow WebSocket client that tunnels through the configured residential
 * proxy -- either via an HTTP CONNECT (http/https proxy URL) or a SOCKS5
 * handshake (socks5/socks5h proxy URL) -- to reach the public CLOB/Binance
 * market channels without adding a dependency that could silently bypass the
 * proxy.
 */
class ProxyWebSocket {
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private failed = false;
  private connectTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly targetUrl: string,
    private readonly proxy: string,
    private readonly onOpen: () => void,
    private readonly onMessage: (message: string) => void,
    private readonly onClose: (reason: string) => void,
  ) {}

  connect() {
    // The proxy CONNECT tunnel, TLS handshake, and WebSocket upgrade below are
    // driven entirely by socket events (data/error/close). If the residential
    // proxy or upstream host ever accepts the TCP connection but then goes
    // silent (a common failure mode, especially right after a cold start),
    // none of those events fire and this attempt would hang forever -- which
    // also means `fail()`/`onClose` never runs, so the reconnect loop that
    // depends on it never gets scheduled again. This timeout guarantees a
    // stuck attempt is abandoned and retried instead of wedging the stream.
    this.connectTimeout = setTimeout(
      () => this.fail("Connection attempt timed out"),
      CONNECT_TIMEOUT_MS,
    );
    this.connectTimeout.unref();

    const target = new URL(this.targetUrl);
    const proxy = new URL(this.proxy);
    const isSocks = proxy.protocol === "socks5:" || proxy.protocol === "socks5h:";
    const proxyPort = Number(
      proxy.port || (proxy.protocol === "https:" ? 443 : isSocks ? 1080 : 80),
    );
    const rawSocket =
      proxy.protocol === "https:"
        ? tls.connect({
            host: proxy.hostname,
            port: proxyPort,
            servername: proxy.hostname,
          })
        : net.connect({ host: proxy.hostname, port: proxyPort });

    const onRawError = (error: Error) => this.fail(error.message);
    rawSocket.once("error", onRawError);

    const proceedToTarget = () => {
      const secureSocket = tls.connect({
        socket: rawSocket,
        servername: target.hostname,
      });
      secureSocket.once("error", (error) => this.fail(error.message));
      secureSocket.once("secureConnect", () => {
        const key = randomBytes(16).toString("base64");
        secureSocket.write(
          `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\n` +
            "Sec-WebSocket-Version: 13\r\n\r\n",
        );
        this.awaitUpgrade(secureSocket);
      });
    };

    rawSocket.once(
      proxy.protocol === "https:" ? "secureConnect" : "connect",
      () => {
        if (isSocks) {
          socksHandshake(rawSocket, proxy, target, proceedToTarget, (message) => {
            this.fail(`SOCKS5 CONNECT failed: ${message}`);
            rawSocket.destroy();
          });
          return;
        }

        const authorization =
          proxy.username || proxy.password
            ? `Proxy-Authorization: Basic ${Buffer.from(
                `${decodeURIComponent(proxy.username)}:${decodeURIComponent(
                  proxy.password,
                )}`,
              ).toString("base64")}\r\n`
            : "";
        rawSocket.write(
          `CONNECT ${target.hostname}:${target.port || "443"} HTTP/1.1\r\n` +
            `Host: ${target.hostname}:${target.port || "443"}\r\n` +
            "Proxy-Connection: Keep-Alive\r\n" +
            authorization +
            "\r\n",
        );

        let response = Buffer.alloc(0);
        const readConnectResponse = (chunk: Buffer) => {
          response = Buffer.concat([response, chunk]);
          const boundary = response.indexOf("\r\n\r\n");
          if (boundary === -1) return;
          rawSocket.off("data", readConnectResponse);
          const header = response.subarray(0, boundary).toString("utf8");
          if (!/^HTTP\/1\.[01] 200\b/.test(header)) {
            this.fail(`Proxy CONNECT rejected: ${header.split("\r\n")[0]}`);
            rawSocket.destroy();
            return;
          }
          proceedToTarget();
        };
        rawSocket.on("data", readConnectResponse);
      },
    );
  }

  close() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }

  sendText(message: string) {
    if (!this.socket || this.socket.destroyed) return;
    const payload = Buffer.from(message, "utf8");
    const mask = randomBytes(4);
    const header =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : payload.length <= 0xffff
          ? Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
          : null;
    if (!header) {
      this.fail("CLOB WebSocket frame is too large");
      return;
    }
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  private awaitUpgrade(socket: tls.TLSSocket) {
    let response = Buffer.alloc(0);
    const onUpgradeData = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      socket.off("data", onUpgradeData);
      const header = response.subarray(0, boundary).toString("utf8");
      if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
        this.fail(`CLOB WebSocket upgrade rejected: ${header.split("\r\n")[0]}`);
        socket.destroy();
        return;
      }
      this.socket = socket;
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      socket.on("data", (data) => this.readFrames(Buffer.from(data)));
      socket.on("close", () => this.fail("CLOB WebSocket closed"));
      socket.on("error", (error) => this.fail(error.message));
      const remainder = response.subarray(boundary + 4);
      if (remainder.length) this.readFrames(remainder);
      this.onOpen();
    };
    socket.on("data", onUpgradeData);
  }

  private readFrames(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        this.fail("CLOB WebSocket frame uses an unsupported length");
        return;
      }
      const masked = Boolean(second & 0x80);
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      let payload = this.buffer.subarray(offset, offset + length);
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }
      this.buffer = this.buffer.subarray(offset + length);
      const opcode = first & 0x0f;
      if (opcode === 0x1) this.onMessage(payload.toString("utf8"));
      if (opcode === 0x9) this.sendFrame(0x8a, payload);
      if (opcode === 0x8) this.close();
    }
  }

  private sendFrame(opcode: number, payload: Buffer) {
    if (!this.socket || payload.length > 125) return;
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([Buffer.from([opcode, 0x80 | payload.length]), mask, masked]));
  }

  private fail(reason: string) {
    if (this.failed) return;
    this.failed = true;
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.onClose(reason);
  }
}

class LiveMarketDataSupervisor {
  private started = false;
  private sequence = 0;
  private binanceSocket: ProxyWebSocket | null = null;
  private binanceConnected = false;
  private clobSocket: ProxyWebSocket | null = null;
  private reconnectBinanceTimer: NodeJS.Timeout | null = null;
  private reconnectClobTimer: NodeJS.Timeout | null = null;
  private spot: number | null = null;
  private spotAt: number | null = null;
  private spotHistory: Array<{ price: number; at: number }> = [];
  private books = new Map<string, Map<number, number>>();
  private clobConnected = false;
  private clobAt: number | null = null;
  private marketError: string | null = null;
  private activeMarket: ActiveMarket = configuredMarket();
  private marketRefreshInFlight = false;
  private wallet = { balancePusd: null as number | null, source: "AUTHENTICATION_NOT_CONFIGURED", at: null as number | null };
  private inventory = { yes: null as number | null, no: null as number | null, atRisk: null as number | null, source: "WALLET_NOT_CONFIGURED", at: null as number | null };
  private execution = new AutomaticPairExecutionSupervisor();
  private opportunityLog = new OpportunityLogStore();

  start() {
    if (this.started) return;
    this.started = true;
    this.connectBinance();
    void this.refreshMarket();
    this.refreshAccount();
    const accountTimer = setInterval(() => this.refreshAccount(), 15_000);
    accountTimer.unref();
    const marketTimer = setInterval(() => void this.refreshMarket(), MARKET_REFRESH_MS);
    marketTimer.unref();
    const executionTimer = setInterval(() => {
      const candidate = this.executionCandidate();
      void this.execution.evaluate(candidate).then(() => {
        this.opportunityLog.observe(candidate, this.execution.snapshot());
      });
    }, 500);
    executionTimer.unref();
  }

  snapshot(): LiveMarketSnapshot {
    this.start();
    const market = this.activeMarket;
    const yes = market.yesTokenId ? this.bestAsk(market.yesTokenId) : null;
    const no = market.noTokenId ? this.bestAsk(market.noTokenId) : null;
    const quotesFresh = Boolean(
      yes &&
        no &&
        isFresh(this.clobAt) &&
        isFresh(this.spotAt),
    );
    const combinedAsk = yes && no ? yes.price + no.price : null;
    const commonDepth = yes && no ? Math.min(yes.size, no.size) : null;
    const edge = combinedAsk === null ? null : 1 - combinedAsk;
    const spotWindow = this.spotHistory.find(
      (point) => point.at >= Date.now() - 60_000,
    );
    const change60sPct =
      this.spot !== null && spotWindow && spotWindow.price > 0
        ? ((this.spot - spotWindow.price) / spotWindow.price) * 100
        : null;
    const balance = this.wallet.balancePusd;
    const compound =
      balance !== null && commonDepth !== null && yes && no && quotesFresh
        ? calculateFinalExecutionStake({
            currentBalancePusd: balance,
            commonDepthShares: commonDepth,
            combinedAskPusd: yes.price + no.price,
          })
        : null;
    const freshLive =
      market.configured &&
      this.clobConnected &&
      quotesFresh &&
      this.spot !== null &&
      isFresh(this.spotAt);
    const message = freshLive
      ? "Binance BTCUSDT and Polymarket CLOB order books are live."
      : this.marketError ??
        (!market.configured
          ? "Live CLOB data requires POLYMARKET_CONDITION_ID, POLYMARKET_YES_TOKEN_ID, and POLYMARKET_NO_TOKEN_ID."
          : "Waiting for fresh Binance and Polymarket market-stream snapshots.");

    return {
      ready: freshLive,
      message,
      sequence: this.sequence,
      serverTime: new Date().toISOString(),
      market: {
        conditionId: market.conditionId,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        endAt: asIso(market.endAt),
        configured: market.configured,
        streamConnected: this.clobConnected,
        lastBookAt: asIso(this.clobAt),
      },
      spot: {
        priceUsd: this.spot,
        change60sPct,
        lastEventAt: asIso(this.spotAt),
        connected: this.binanceConnected,
      },
      quotes: {
        yesBestAsk: yes?.price ?? null,
        yesAskSize: yes?.size ?? null,
        yesAskLevels: market.yesTokenId ? (this.books.get(market.yesTokenId)?.size ?? null) : null,
        noBestAsk: no?.price ?? null,
        noAskSize: no?.size ?? null,
        noAskLevels: market.noTokenId ? (this.books.get(market.noTokenId)?.size ?? null) : null,
        combinedAsk,
        commonDepth,
        edge,
        fresh: quotesFresh,
      },
      wallet: {
        balancePusd: this.wallet.balancePusd,
        source: this.wallet.source,
        lastUpdatedAt: asIso(this.wallet.at),
      },
      inventory: {
        yesShares: this.inventory.yes,
        noShares: this.inventory.no,
        netShares:
          this.inventory.yes !== null && this.inventory.no !== null
            ? this.inventory.yes - this.inventory.no
            : null,
        atRiskPusd: this.inventory.atRisk,
        source: this.inventory.source,
        lastUpdatedAt: asIso(this.inventory.at),
      },
      compound: {
        finalExecutionStakePusd: compound?.finalExecutionStakePusd ?? null,
        walletMaxStakePusd: compound?.walletMaxStakePusd ?? null,
        marketAvailableVolumePusd: compound?.marketAvailableVolumePusd ?? null,
        executable: compound?.executable ?? false,
        reason: compound?.executionReason ?? "AUTHENTICATED_BALANCE_OR_FRESH_BOOK_REQUIRED",
      },
      execution: this.execution.snapshot(),
    };
  }

  async emergencyStopExecution(): Promise<AutomaticPairExecutionStatus> {
    return this.execution.emergencyStop();
  }

  async armExecution(): Promise<AutomaticPairExecutionStatus> {
    return this.execution.arm();
  }

  async pauseExecution(): Promise<AutomaticPairExecutionStatus> {
    return this.execution.pause();
  }

  opportunities(): { thresholdPusd: number; entries: OpportunityLogEntry[] } {
    return { thresholdPusd: OPPORTUNITY_LOG_THRESHOLD_PUSD, entries: this.opportunityLog.list() };
  }

  private executionCandidate(): PairExecutionCandidate {
    const market = this.activeMarket;
    const yes = market.yesTokenId ? this.bestAsk(market.yesTokenId) : null;
    const no = market.noTokenId ? this.bestAsk(market.noTokenId) : null;
    const fresh =
      Boolean(yes && no) &&
      this.clobConnected &&
      isFresh(this.clobAt) &&
      isFresh(this.spotAt);
    return {
      ready: market.configured && fresh,
      market: {
        conditionId: market.conditionId,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        endAt: market.endAt,
      },
      quotes: {
        yesBestAsk: yes?.price ?? null,
        noBestAsk: no?.price ?? null,
        commonDepth: yes && no ? Math.min(yes.size, no.size) : null,
        fresh,
      },
      walletBalancePusd: this.wallet.balancePusd,
    };
  }

  private async refreshMarket() {
    if (this.marketRefreshInFlight) return;
    this.marketRefreshInFlight = true;
    try {
      const windowStart = Math.floor(Date.now() / 300_000) * 300;
      const candidates = [windowStart, windowStart - 300, windowStart + 300];
      let market: ActiveMarket | null = null;
      for (const startSeconds of candidates) {
        const response = await curlJsonThroughProxy(
          `${GAMMA_MARKETS_URL}?slug=${encodeURIComponent(`btc-updown-5m-${startSeconds}`)}`,
        );
        const raw = Array.isArray(response) ? response[0] : response;
        market = activeMarketFromGamma(raw);
        if (market) break;
      }
      if (!market) {
        if (this.activeMarket.endAt !== null && this.activeMarket.endAt <= Date.now()) {
          this.activeMarket = {
            conditionId: null,
            yesTokenId: null,
            noTokenId: null,
            endAt: null,
            configured: false,
          };
          this.books.clear();
          this.clobAt = null;
        }
        this.marketError = "No verified active BTC 5-minute market is available.";
        return;
      }

      const changed = market.conditionId !== this.activeMarket.conditionId;
      this.activeMarket = market;
      this.marketError = null;
      if (changed) {
        this.books.clear();
        this.clobAt = null;
        this.clobConnected = false;
        this.connectClob();
        await this.refreshPositions();
      } else if (!this.clobSocket) {
        this.connectClob();
      }
    } catch {
      this.marketError = "BTC 5-minute market discovery is unavailable through the residential proxy.";
      logger.warn("BTC 5-minute market discovery failed");
    } finally {
      this.marketRefreshInFlight = false;
    }
  }

  private connectBinance() {
    const proxy = proxyUrl();
    if (!proxy) {
      logger.warn("Binance stream is blocked: residential proxy is not configured");
      return;
    }
    this.binanceSocket?.close();
    this.binanceSocket = new ProxyWebSocket(
      BINANCE_WS_URL,
      proxy,
      () => {
        this.binanceConnected = true;
      },
      (message) => {
        try {
          const payload = JSON.parse(message) as Record<string, unknown>;
          const price = numberOrNull(payload.c);
          const eventAt = numberOrNull(payload.E) ?? Date.now();
          if (price === null || price <= 0) return;
          this.spot = price;
          this.spotAt = eventAt;
          this.spotHistory.push({ price, at: eventAt });
          this.spotHistory = this.spotHistory.filter(
            (point) => point.at >= Date.now() - 65_000,
          );
          this.sequence += 1;
        } catch {
          logger.warn("Could not parse Binance ticker message");
        }
      },
      (reason) => {
        this.binanceConnected = false;
        logger.warn({ reason }, "Binance WebSocket closed");
        if (this.reconnectBinanceTimer) clearTimeout(this.reconnectBinanceTimer);
        this.reconnectBinanceTimer = setTimeout(() => this.connectBinance(), 3_000);
        this.reconnectBinanceTimer.unref();
      },
    );
    this.binanceSocket.connect();
  }

  private connectClob() {
    const market = this.activeMarket;
    const proxy = proxyUrl();
    if (!market.configured) {
      this.marketError =
        "Live CLOB data requires market and YES/NO token identifiers.";
      return;
    }
    if (!proxy) {
      this.marketError = "CLOB market stream is blocked: residential proxy is not configured.";
      return;
    }
    this.clobSocket?.close();
    this.clobSocket = new ProxyWebSocket(
      CLOB_WS_URL,
      proxy,
      () => {
        this.clobConnected = true;
        this.marketError = null;
        this.clobSocket?.sendText(
          JSON.stringify({
            assets_ids: [market.yesTokenId, market.noTokenId],
            type: "market",
          }),
        );
      },
      (message) => this.handleClobMessage(message),
      (reason) => {
        this.clobConnected = false;
        this.marketError = `CLOB stream unavailable: ${reason}`;
        if (this.reconnectClobTimer) clearTimeout(this.reconnectClobTimer);
        this.reconnectClobTimer = setTimeout(() => this.connectClob(), 3_000);
        this.reconnectClobTimer.unref();
      },
    );
    this.clobSocket.connect();
  }

  private handleClobMessage(message: string) {
    try {
      const raw = JSON.parse(message) as Record<string, unknown>;
      const payload =
        raw.payload && typeof raw.payload === "object"
          ? (raw.payload as Record<string, unknown>)
          : raw;
      const type = String(raw.type ?? raw.event_type ?? "");
      if (type === "book") {
        const tokenId =
          stringOrNull(payload.tokenId) ?? stringOrNull(payload.asset_id);
        if (!tokenId) return;
        const asks = Array.isArray(payload.asks) ? payload.asks : [];
        const levels = new Map<number, number>();
        for (const item of asks) {
          const level = this.parseLevel(item);
          if (level && level.size > 0) levels.set(level.price, level.size);
        }
        this.books.set(tokenId, levels);
        this.clobAt = Date.now();
        this.sequence += 1;
        void this.execution.evaluate(this.executionCandidate());
        return;
      }
      if (type === "price_change") {
        const changes =
          (Array.isArray(payload.priceChanges) && payload.priceChanges) ||
          (Array.isArray(payload.price_changes) && payload.price_changes) ||
          [];
        for (const change of changes) {
          if (!change || typeof change !== "object") continue;
          const record = change as Record<string, unknown>;
          const side = String(record.side ?? "").toUpperCase();
          if (side !== "SELL" && side !== "ASK") continue;
          const tokenId =
            stringOrNull(record.tokenId) ?? stringOrNull(record.asset_id);
          const level = this.parseLevel(record);
          if (!tokenId || !level) continue;
          const asks = this.books.get(tokenId) ?? new Map<number, number>();
          if (level.size <= 0) asks.delete(level.price);
          else asks.set(level.price, level.size);
          this.books.set(tokenId, asks);
        }
        this.clobAt = Date.now();
        this.sequence += 1;
        void this.execution.evaluate(this.executionCandidate());
      }
    } catch {
      logger.warn("Could not parse CLOB market message");
    }
  }

  private parseLevel(value: unknown): BookLevel | null {
    if (Array.isArray(value)) {
      const price = numberOrNull(value[0]);
      const size = numberOrNull(value[1]);
      return price !== null && size !== null ? { price, size } : null;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const price = numberOrNull(record.price);
      const size = numberOrNull(record.size);
      return price !== null && size !== null ? { price, size } : null;
    }
    return null;
  }

  private bestAsk(tokenId: string): BookLevel | null {
    const asks = this.books.get(tokenId);
    if (!asks || !asks.size) return null;
    let best: BookLevel | null = null;
    for (const [price, size] of asks) {
      if (size > 0 && (best === null || price < best.price)) best = { price, size };
    }
    return best;
  }

  private async refreshAccount() {
    await Promise.all([this.refreshBalance(), this.refreshPositions()]);
  }

  private async refreshBalance() {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY?.trim();
    const funder = process.env.POLYMARKET_FUNDER?.trim();
    if (!privateKey || !funder) {
      this.wallet = {
        balancePusd: null,
        source: "AUTHENTICATION_NOT_CONFIGURED",
        at: null,
      };
      return;
    }
    try {
      const balance = await this.readAuthenticatedClobBalance();
      this.wallet = {
        balancePusd: balance,
        source: "POLYMARKET_CLOB_COLLATERAL_BALANCE",
        at: Date.now(),
      };
    } catch {
      logger.warn("Polymarket CLOB collateral balance refresh failed");
      this.wallet = {
        balancePusd: null,
        source: "AUTHENTICATED_BALANCE_UNAVAILABLE",
        at: Date.now(),
      };
    }
  }

  private async readAuthenticatedClobBalance(): Promise<number> {
    const python = clobBalancePython();
    if (!python || !existsSync(CLOB_BALANCE_HELPER)) {
      throw new Error("Authenticated CLOB balance reader is unavailable");
    }

    const { stdout } = await execFileAsync(python, [CLOB_BALANCE_HELPER], {
      timeout: 12_000,
      maxBuffer: 16 * 1024,
    });
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    const balance = numberOrNull(payload.balancePusd);
    if (payload.ok !== true || balance === null || balance < 0) {
      throw new Error("Authenticated CLOB balance reader returned no balance");
    }
    return balance;
  }

  private async refreshPositions() {
    const market = this.activeMarket;
    const funder = process.env.POLYMARKET_FUNDER?.trim();
    if (!funder || !market.configured) {
      this.inventory = {
        yes: null,
        no: null,
        atRisk: null,
        source: !funder ? "WALLET_NOT_CONFIGURED" : "MARKET_NOT_CONFIGURED",
        at: null,
      };
      return;
    }
    try {
      const query = new URLSearchParams({ user: funder });
      const response = await curlJsonThroughProxy(`${POSITIONS_URL}?${query}`);
      const rows = Array.isArray(response) ? response : [];
      if (!market.yesTokenId || !market.noTokenId) {
        throw new Error("Configured market is missing one or more token identifiers");
      }
      const yes = this.positionForToken(rows, market.yesTokenId);
      const no = this.positionForToken(rows, market.noTokenId);
      this.inventory = {
        yes: yes.size ?? 0,
        no: no.size ?? 0,
        atRisk:
          yes.value !== null && no.value !== null
            ? Math.abs(yes.value) + Math.abs(no.value)
            : null,
        source: "POLYMARKET_PUBLIC_POSITIONS",
        at: Date.now(),
      };
    } catch {
      logger.warn("Polymarket position refresh failed");
      this.inventory = {
        yes: null,
        no: null,
        atRisk: null,
        source: "POSITIONS_UNAVAILABLE",
        at: Date.now(),
      };
    }
  }

  private positionForToken(rows: unknown[], tokenId: string): Position {
    const row = rows.find((item) => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return (
        String(record.asset ?? record.asset_id ?? record.tokenId ?? "") === tokenId
      );
    });
    if (!row || typeof row !== "object") return { size: 0, value: null };
    const record = row as Record<string, unknown>;
    return {
      size: numberOrNull(record.size ?? record.quantity),
      value: numberOrNull(record.currentValue ?? record.current_value ?? record.value),
    };
  }
}

export const liveMarketData = new LiveMarketDataSupervisor();