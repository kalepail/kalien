import { useCallback, useEffect, useState } from "react";
import type { SmartAccountConfig, SmartWalletSession } from "../wallet/smartAccount";
import { TESTNET_NETWORK_PASSPHRASE } from "../consts";

export type WalletAction = "idle" | "restoring" | "connecting" | "creating" | "disconnecting";

export interface UseWalletReturn {
  session: SmartWalletSession | null;
  isConnected: boolean;
  isBusy: boolean;
  action: WalletAction;
  error: string | null;
  address: string;
  networkPassphrase: string;
  userName: string;
  setUserName: (name: string) => void;
  connect: () => Promise<void>;
  create: () => Promise<void>;
  disconnect: () => Promise<void>;
  clearError: () => void;
}

interface CachedWalletState {
  networkPassphrase: string;
  session: SmartWalletSession | null;
}

type SmartWalletModule = typeof import("../wallet/smartAccount");

let cachedWalletState: CachedWalletState | null = null;
let restoreWalletStatePromise: Promise<CachedWalletState> | null = null;
let smartWalletModulePromise: Promise<SmartWalletModule> | null = null;

function loadSmartWalletModule(): Promise<SmartWalletModule> {
  if (!smartWalletModulePromise) {
    smartWalletModulePromise = import("../wallet/smartAccount");
  }

  return smartWalletModulePromise;
}

function setCachedWalletState(nextState: CachedWalletState): void {
  cachedWalletState = nextState;
  restoreWalletStatePromise = Promise.resolve(nextState);
}

async function restoreWalletState(): Promise<CachedWalletState> {
  if (cachedWalletState) {
    return cachedWalletState;
  }

  if (!restoreWalletStatePromise) {
    restoreWalletStatePromise = (async () => {
      const walletModule = await loadSmartWalletModule();
      const nextConfig = walletModule.getSmartAccountConfig();
      const session = await walletModule.restoreSmartWalletSession();
      const restoredState = {
        networkPassphrase: nextConfig.networkPassphrase,
        session,
      };
      cachedWalletState = restoredState;
      return restoredState;
    })().catch((error) => {
      restoreWalletStatePromise = null;
      throw error;
    });
  }

  return restoreWalletStatePromise;
}

export function useWallet(): UseWalletReturn {
  const [session, setSession] = useState<SmartWalletSession | null>(null);
  const [action, setAction] = useState<WalletAction>("idle");
  const [userName, setUserName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<Pick<SmartAccountConfig, "networkPassphrase">>({
    networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  });

  const address = session?.contractId ?? "";
  const isConnected = address.trim().length > 0;
  const isBusy = action !== "idle";

  const withWalletAction = useCallback(
    async (
      actionName: Exclude<WalletAction, "idle" | "restoring">,
      fallbackMsg: string,
      perform: (walletModule: SmartWalletModule) => Promise<void>,
    ) => {
      setAction(actionName);
      setError(null);

      try {
        const walletModule = await loadSmartWalletModule();
        const nextConfig = walletModule.getSmartAccountConfig();
        setConfig({ networkPassphrase: nextConfig.networkPassphrase });
        await perform(walletModule);
      } catch (err) {
        const detail = err instanceof Error ? err.message : fallbackMsg;
        setError(detail);
      } finally {
        setAction("idle");
      }
    },
    [],
  );

  const connect = useCallback(
    () =>
      withWalletAction("connecting", "failed to connect wallet", async (walletModule) => {
        const nextSession = await walletModule.connectSmartWallet();
        const nextConfig = walletModule.getSmartAccountConfig();
        setCachedWalletState({
          networkPassphrase: nextConfig.networkPassphrase,
          session: nextSession,
        });
        setSession(nextSession);
      }),
    [withWalletAction],
  );

  const create = useCallback(
    () =>
      withWalletAction("creating", "failed to create wallet", async (walletModule) => {
        const nextSession = await walletModule.createSmartWallet(userName);
        const nextConfig = walletModule.getSmartAccountConfig();
        setCachedWalletState({
          networkPassphrase: nextConfig.networkPassphrase,
          session: nextSession,
        });
        setSession(nextSession);
      }),
    [withWalletAction, userName],
  );

  const disconnect = useCallback(
    () =>
      withWalletAction("disconnecting", "failed to disconnect wallet", async (walletModule) => {
        await walletModule.disconnectSmartWallet();
        const nextConfig = walletModule.getSmartAccountConfig();
        setCachedWalletState({
          networkPassphrase: nextConfig.networkPassphrase,
          session: null,
        });
        setSession(null);
      }),
    [withWalletAction],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Restore session on mount
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      setAction("restoring");
      setError(null);

      try {
        const restoredState = await restoreWalletState();
        if (cancelled) {
          return;
        }
        setConfig({ networkPassphrase: restoredState.networkPassphrase });
        setSession(restoredState.session);
      } catch (err) {
        if (cancelled) {
          return;
        }
        const detail = err instanceof Error ? err.message : "failed to restore wallet session";
        setError(detail);
      } finally {
        if (!cancelled) {
          setAction("idle");
        }
      }
    };

    void restore();

    return () => {
      cancelled = true;
    };
  }, []);

  return {
    session,
    isConnected,
    isBusy,
    action,
    error,
    address,
    networkPassphrase: config.networkPassphrase,
    userName,
    setUserName,
    connect,
    create,
    disconnect,
    clearError,
  };
}
