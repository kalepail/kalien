import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Send from "lucide-react/dist/esm/icons/send";
import ArrowDownUp from "lucide-react/dist/esm/icons/arrow-down-up";
import Coins from "lucide-react/dist/esm/icons/coins";
import Check from "lucide-react/dist/esm/icons/check";
import Copy from "lucide-react/dist/esm/icons/copy";
import { useBalanceState, useWalletState } from "@/contexts/WalletContext";
import { PageShell } from "@/components/shared/PageShell";
import { PageHero } from "@/components/shared/PageHero";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ErrorMessage } from "@/components/shared/ErrorMessage";
import { Link } from "@/components/shared/Link";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { abbreviateAddress, KALIEN_SCALE, formatWholeNumber } from "@/lib/format";
import { getSmartAccountKit } from "@/wallet/smartAccount";
import { readTokenBalance } from "@/chain/token";
import { getSwapConfig, getSwapQuote, executeSwap, type SwapQuote } from "@/chain/swap";

const KALE_SCALE = 10_000_000n;

function formatKaleAmount(raw: bigint): string {
  const whole = raw / KALE_SCALE;
  const frac = raw % KALE_SCALE;
  if (frac === 0n) return formatWholeNumber(whole);
  const fracStr = (frac < 0n ? -frac : frac).toString().padStart(7, "0").replace(/0+$/, "");
  return `${formatWholeNumber(whole)}.${fracStr}`;
}

export function WalletPage() {
  useDocumentTitle("Wallet", {
    description: "Transfer and swap KALIEN tokens.",
    path: "/wallet",
  });

  const wallet = useWalletState();
  const balance = useBalanceState();

  // ── Transfer state ──
  const [transferToken, setTransferToken] = useState<"KALIEN" | "KALE">("KALIEN");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [transferSuccess, setTransferSuccess] = useState(false);
  const [copied, setCopied] = useState(false);

  // ── Swap config (null when network/token not ready) ──
  const swapCfg = useMemo(() => getSwapConfig(balance.tokenContractId), [balance.tokenContractId]);

  // ── KALE balance (only when swap config is available) ──
  const [kaleBalance, setKaleBalance] = useState<bigint | null>(null);
  const kaleBalanceRequestId = useRef(0);

  const refreshKaleBalance = useCallback(async () => {
    const requestId = ++kaleBalanceRequestId.current;
    if (!swapCfg || !wallet.address) {
      setKaleBalance(null);
      return;
    }
    try {
      const result = await readTokenBalance({
        walletAddress: wallet.address,
        tokenContractId: swapCfg.kaleSac,
      });
      if (requestId === kaleBalanceRequestId.current) {
        setKaleBalance(result.balance);
      }
    } catch {
      if (requestId === kaleBalanceRequestId.current) {
        setKaleBalance(null);
      }
    }
  }, [swapCfg, wallet.address]);

  useEffect(() => {
    void refreshKaleBalance();
  }, [refreshKaleBalance]);

  // ── Swap state ──
  const [swapAmount, setSwapAmount] = useState("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [swapSuccess, setSwapSuccess] = useState(false);
  const quoteRequestId = useRef(0);

  // ── Debounced quote fetch ──
  const fetchQuote = useCallback(
    (rawAmount: string) => {
      const requestId = ++quoteRequestId.current;
      setQuote(null);
      setQuoteError(null);

      if (!swapCfg) {
        setQuoteLoading(false);
        return;
      }

      const parsed = Number(rawAmount);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setQuoteLoading(false);
        return;
      }

      const amountIn = BigInt(Math.floor(parsed * Number(KALIEN_SCALE)));
      if (amountIn <= 0n) {
        setQuoteLoading(false);
        return;
      }

      setQuoteLoading(true);

      const cfg = swapCfg;
      void (async () => {
        try {
          const result = await getSwapQuote(cfg, amountIn);
          if (requestId !== quoteRequestId.current) return;
          setQuote(result);
          setQuoteError(null);
        } catch (err) {
          if (requestId !== quoteRequestId.current) return;
          setQuoteError(err instanceof Error ? err.message : "Failed to get quote");
        } finally {
          if (requestId === quoteRequestId.current) {
            setQuoteLoading(false);
          }
        }
      })();
    },
    [swapCfg],
  );

  const debounceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!swapAmount.trim()) {
      quoteRequestId.current += 1;
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }
    setQuoteLoading(true);
    debounceRef.current = window.setTimeout(() => fetchQuote(swapAmount), 600);
    return () => clearTimeout(debounceRef.current);
  }, [swapAmount, fetchQuote]);

  // ── Transfer handler ──
  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet.session) return;

    const isKale = transferToken === "KALE";
    const tokenId = isKale ? swapCfg?.kaleSac : balance.tokenContractId;
    if (!tokenId) return;

    const trimmedRecipient = recipient.trim();
    if (!trimmedRecipient) {
      setTransferError("Enter a recipient address");
      return;
    }
    if (!trimmedRecipient.startsWith("G") && !trimmedRecipient.startsWith("C")) {
      setTransferError("Address must start with G (account) or C (contract)");
      return;
    }
    if (trimmedRecipient.length !== 56) {
      setTransferError("Address must be 56 characters");
      return;
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setTransferError("Enter a valid amount");
      return;
    }

    const currentBalance = isKale ? kaleBalance : balance.balance;
    if (
      currentBalance !== null &&
      BigInt(Math.floor(parsedAmount * Number(KALE_SCALE))) > currentBalance
    ) {
      setTransferError(`Insufficient ${transferToken} balance`);
      return;
    }

    setTransferring(true);
    setTransferError(null);
    setTransferSuccess(false);

    try {
      const kit = getSmartAccountKit();

      const result = await kit.transfer(tokenId, trimmedRecipient, parsedAmount, {
        credentialId: wallet.session.credentialId,
        forceMethod: "relayer",
      });

      if (!result.success) {
        throw new Error(result.error ?? "Transfer failed");
      }

      setTransferSuccess(true);
      setAmount("");
      setRecipient("");
      void balance.refresh();
      void refreshKaleBalance();
    } catch (err) {
      setTransferError(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setTransferring(false);
    }
  }

  // ── Swap handler ──
  async function handleSwap(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet.session || !quote) return;

    const parsedAmount = Number(swapAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setSwapError("Enter a valid amount");
      return;
    }

    if (
      balance.balance !== null &&
      BigInt(Math.floor(parsedAmount * Number(KALIEN_SCALE))) > balance.balance
    ) {
      setSwapError("Insufficient KALIEN balance");
      return;
    }

    setSwapping(true);
    setSwapError(null);
    setSwapSuccess(false);

    try {
      const activeSwapCfg = swapCfg;
      if (!activeSwapCfg) {
        throw new Error("Swap is not configured");
      }

      await executeSwap(
        activeSwapCfg,
        quote.amountIn,
        quote.minAmountOut,
        wallet.address,
        wallet.session.credentialId,
      );

      setSwapSuccess(true);
      setSwapAmount("");
      setQuote(null);
      void balance.refresh();
      void refreshKaleBalance();
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : "Swap failed");
    } finally {
      setSwapping(false);
    }
  }

  function copyAddress() {
    void navigator.clipboard.writeText(wallet.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return undefined;
    });
  }

  return (
    <PageShell glow className="content-start">
      <PageHero title="Wallet" subtitle="Manage and swap your KALIEN tokens." />

      {/* Not connected */}
      {!wallet.isConnected && !wallet.isBusy && (
        <Card className="animate-rise">
          <div className="grid justify-items-center gap-3 py-8 text-center">
            <p className="m-0 text-text-soft">Connect your wallet to manage your tokens.</p>
            <Button variant="active" asChild>
              <Link href="/" className="no-underline">
                Go Play
              </Link>
            </Button>
          </div>
        </Card>
      )}

      {/* Restoring */}
      {wallet.isBusy && (
        <Card className="animate-rise">
          <p className="m-0 text-center text-muted-foreground">Restoring wallet session…</p>
        </Card>
      )}

      {/* Connected */}
      {wallet.isConnected && (
        <div className="grid gap-4">
          {/* Account overview */}
          <Card className="animate-rise">
            <div className="grid gap-3 p-4">
              <div>
                <p className="m-0 font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
                  Account
                </p>
                <button
                  onClick={copyAddress}
                  className="mt-0.5 flex w-full cursor-pointer items-center gap-1.5 rounded bg-transparent p-0 text-left transition-colors hover:text-primary"
                  title="Copy address"
                >
                  <span className="min-w-0 flex-1 font-mono text-sm text-card-foreground break-all">
                    {abbreviateAddress(wallet.address)}
                  </span>
                  {copied ? (
                    <Check className="size-3.5 shrink-0 text-secondary" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                </button>
              </div>
              <div className="grid gap-2">
                <p className="m-0 font-display text-[0.65rem] uppercase tracking-[0.06em] text-muted-foreground">
                  Balances
                </p>
                <p className="m-0 flex items-center gap-1.5 text-lg font-display tracking-wide text-card-foreground">
                  <Coins className="size-4 text-secondary" aria-hidden="true" />
                  {balance.formattedBalance}
                </p>
                {swapCfg && (
                  <p className="m-0 flex items-center gap-1.5 text-lg font-display tracking-wide text-card-foreground">
                    <Coins className="size-4 text-primary" aria-hidden="true" />
                    {kaleBalance === null ? "—" : `${formatKaleAmount(kaleBalance)} KALE`}
                  </p>
                )}
              </div>
            </div>
          </Card>

          {/* Swap + Transfer side-by-side on large screens */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Swap form (only when swap config is available) */}
            {swapCfg && (
              <Card className="animate-rise">
                <form onSubmit={handleSwap} className="grid gap-4 p-4">
                  <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase text-[rgba(176,219,255,0.95)]">
                    Swap KALIEN → KALE
                  </h2>

                  <div className="grid gap-1.5">
                    <label
                      htmlFor="swap-amount"
                      className="font-display text-[0.7rem] uppercase tracking-[0.06em] text-muted-foreground"
                    >
                      KALIEN to swap
                    </label>
                    <Input
                      id="swap-amount"
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      value={swapAmount}
                      onChange={(e) => {
                        setSwapAmount(e.target.value);
                        setSwapError(null);
                        setSwapSuccess(false);
                      }}
                      disabled={swapping}
                    />
                  </div>

                  {/* Quote display */}
                  {quoteLoading && (
                    <p className="m-0 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                      Getting quote…
                    </p>
                  )}

                  {quote && !quoteLoading && (
                    <div className="rounded-md border border-border/30 bg-[rgba(13,22,40,0.4)] px-3 py-2.5 text-sm">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-muted-foreground">You receive</span>
                        <span className="font-display tracking-wide text-card-foreground">
                          ~{formatKaleAmount(quote.amountOut)} KALE
                        </span>
                      </div>
                      <div className="mt-1 flex items-baseline justify-between gap-2 text-xs">
                        <span className="text-muted-foreground">Minimum (3% slippage)</span>
                        <span className="text-muted-foreground">
                          {formatKaleAmount(quote.minAmountOut)} KALE
                        </span>
                      </div>
                    </div>
                  )}

                  <ErrorMessage message={quoteError} />
                  <ErrorMessage message={swapError} />

                  {swapSuccess && <p className="m-0 text-sm text-secondary">Swap successful!</p>}

                  <Button
                    type="submit"
                    variant="active"
                    disabled={swapping || !quote || quoteLoading}
                  >
                    {swapping ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        Swapping...
                      </>
                    ) : (
                      <>
                        <ArrowDownUp className="size-3.5" aria-hidden="true" />
                        Swap
                      </>
                    )}
                  </Button>
                </form>
              </Card>
            )}

            {/* Transfer form */}
            <Card className="animate-rise">
              <form onSubmit={handleTransfer} className="grid gap-4 p-4">
                <h2 className="m-0 font-display text-sm tracking-[0.08em] uppercase text-[rgba(176,219,255,0.95)]">
                  Transfer
                </h2>

                {/* Token selector */}
                <div className="grid gap-1.5">
                  <label
                    htmlFor="transfer-token"
                    className="font-display text-[0.7rem] uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    Token
                  </label>
                  <select
                    id="transfer-token"
                    value={transferToken}
                    onChange={(e) => {
                      setTransferToken(e.target.value as "KALIEN" | "KALE");
                      setTransferError(null);
                      setTransferSuccess(false);
                    }}
                    disabled={transferring}
                    className="h-10 rounded-md border border-border/40 bg-surface-dim px-3 font-display text-sm tracking-wide text-card-foreground transition-colors focus:border-primary/60 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="KALIEN">KALIEN</option>
                    {swapCfg && <option value="KALE">KALE</option>}
                  </select>
                </div>

                <div className="grid gap-1.5">
                  <label
                    htmlFor="recipient"
                    className="font-display text-[0.7rem] uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    Recipient Address
                  </label>
                  <Input
                    id="recipient"
                    type="text"
                    placeholder="G... or C..."
                    value={recipient}
                    onChange={(e) => {
                      setRecipient(e.target.value);
                      setTransferError(null);
                      setTransferSuccess(false);
                    }}
                    disabled={transferring}
                    className="font-mono text-xs"
                  />
                </div>

                <div className="grid gap-1.5">
                  <label
                    htmlFor="transfer-amount"
                    className="font-display text-[0.7rem] uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    Amount
                  </label>
                  <Input
                    id="transfer-amount"
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setTransferError(null);
                      setTransferSuccess(false);
                    }}
                    disabled={transferring}
                  />
                </div>

                <ErrorMessage message={transferError} />

                {transferSuccess && (
                  <p className="m-0 text-sm text-secondary">Transfer successful!</p>
                )}

                <Button
                  type="submit"
                  variant="active"
                  disabled={
                    transferring ||
                    (transferToken === "KALIEN" ? !balance.tokenContractId : !swapCfg?.kaleSac)
                  }
                >
                  {transferring ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send className="size-3.5" aria-hidden="true" />
                      Send {transferToken}
                    </>
                  )}
                </Button>
              </form>
            </Card>
          </div>
        </div>
      )}
    </PageShell>
  );
}
