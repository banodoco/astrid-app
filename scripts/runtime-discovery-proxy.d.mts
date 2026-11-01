export const CONNECT_TIMEOUT_MS: number;
export const IDLE_TIMEOUT_MS: number;
export function currentRuntime(discoveryPath: string | undefined, options?: { credentialFile?: string }): { endpoint: URL; token: string };
export function createRuntimeProxyServer(options?: { discoveryPath?: string; allowedOrigin?: string; expectedHost?: string; connectTimeoutMs?: number; idleTimeoutMs?: number }): import('node:http').Server;
export const OPERATION_PREFIX: string;
export function readWorkspaceRuntimeConfig(discoveryPath: string | undefined): { schemaVersion: number; endpoint: string; actorId: string; realmId: string; runtimeInstanceId: string };
export function operationRequestAllowed(incoming: import('node:http').IncomingMessage, allowedOrigin: string | undefined, expectedHost: string | undefined): boolean;
export function operationTarget(url: string | undefined): { control: true; path?: never } | { path: string; control?: never } | null;
export function operationFailure(status: number, code: string): { status: number; body: string };
type RuntimeOperationEntry = {
  readonly handle: string;
  readonly identity: Readonly<{ actorId: string; realmId: string; runtimeInstanceId: string }>;
  readonly connection: Readonly<{ hostname: string; port: number; token: string; dispatch: typeof import('node:http').request }>;
};
export function createRuntimeOperationRegistry(options?: { discoveryPath?: string; idleTimeoutMs?: number }): {
  acquire(predecessor?: string): RuntimeOperationEntry;
  get(handle: string): RuntimeOperationEntry | undefined;
  isActive(entry: RuntimeOperationEntry): boolean;
  retire(handle: string): void;
  track(entry: RuntimeOperationEntry, cancel: () => void): (() => void) | null;
  dispose(): void;
};
