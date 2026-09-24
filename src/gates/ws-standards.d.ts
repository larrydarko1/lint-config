/** WebSocket / real-time architecture gate — one server, one client, the order of the handshake. See ws-standards.js. */

export interface WsProblem {
    file: string | null;
    what: string;
    why: string;
}

/**
 * The Redis adapter is the one rule that inverts between repos: mandatory where
 * a pod holds only its own sockets, a regression where every pod already
 * subscribes to every bucket. `'forbidden'` also requires the argument to stay
 * in the gateway header, because a departure nobody can find the reason for is
 * one the next person "fixes" back.
 */
export type RedisAdapterRule =
    | { mode: 'required' }
    | {
          mode: 'forbidden';
          /** What the header must still say, matched case-insensitively. */
          headerPhrase: string;
          /** The argument itself, reported when an adapter reappears. */
          why: string;
      };

/** How this gateway addresses its clients. */
export type RoomRule = { join: 'personal'; prefix: string } | { join: 'helpers' };

export interface WsStandardsInput {
    /** Repository root. Defaults to the nearest ancestor holding a package.json. */
    root?: string;
    /** The gateway module that constructs the Socket.IO server. */
    gateway: string;
    /** The directory that owns the socket. Nothing outside it may import socket.io. */
    gatewayDir: string;
    /** Server directories swept for stray imports and stray emits. */
    serverDirs: string | string[];
    /** The one frontend socket client module. */
    client: string;
    /** Frontend directories swept for second connections and leaked listeners. */
    clientDirs: string | string[];
    /** Where the handshake verify really happens, when it is not inline. */
    authModule?: { file: string; fn: string };
    /** Required here, forbidden there. Defaults to required. */
    redisAdapter?: RedisAdapterRule;
    /** Require an `allowRequest` origin check on the upgrade. Defaults to false. */
    upgradeOrigin?: boolean;
    /** How rooms are addressed. */
    rooms: RoomRule;
    /** Require exported `emitX` helpers that nothing awaits. Defaults to false. */
    emitHelpers?: boolean;
    /** The connection bucket key prefix. Defaults to `rl:ws:conn:`. */
    connectionKey?: string;
    /** The prefix every socket bucket key shares. Defaults to `rl:ws:`. */
    messageKeyPrefix?: string;
    /** The function the client reads the access token through. Defaults to `findAccessToken`. */
    tokenAccessor?: string;
    /** The client's teardown function. Defaults to `disconnectSocket`. */
    teardownFn?: string;
    /** The session hook the teardown registers with. Absent means "called from the sign-out path". */
    sessionTeardown?: string;
}

export interface WsStandardsInspection {
    problems: WsProblem[];
    counts: { outbound: number; inbound: number; documented: number };
}

export interface WsStandardsOptions extends Omit<WsStandardsInput, 'root'> {
    root?: string;
    /** The instructions file to point at on failure. */
    standard?: string;
}

/** Every real-time relationship this repo can be asked about, as a list of problems. */
export declare function inspectWsStandards(input: WsStandardsInput): WsStandardsInspection;

/** Run the gate and print. */
export declare function checkWsStandards(options: WsStandardsOptions): void;

export default checkWsStandards;
