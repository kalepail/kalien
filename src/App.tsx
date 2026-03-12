import { lazy, Suspense } from "react";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { useLocation } from "./hooks/useLocation";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { WalletProvider } from "./contexts/WalletContext";

const LazyLeaderboardPage = lazy(() =>
  import("./components/leaderboard/LeaderboardPage").then((mod) => ({
    default: mod.LeaderboardPage,
  })),
);

const LazyProofsPage = lazy(() =>
  import("./components/proofs/ProofsPage").then((mod) => ({
    default: mod.ProofsPage,
  })),
);

const LazyPublicProofsPage = lazy(() =>
  import("./components/proofs/PublicProofsPage").then((mod) => ({
    default: mod.PublicProofsPage,
  })),
);

const LazyWalletPage = lazy(() =>
  import("./components/wallet/WalletPage").then((mod) => ({
    default: mod.WalletPage,
  })),
);

const LazyGamePage = lazy(() =>
  import("./components/game/GamePageWrapper").then((mod) => ({
    default: mod.GamePageWrapper,
  })),
);

const routeFallback = (
  <div className="flex min-h-[200px] items-center justify-center">
    <Loader2 className="size-6 animate-spin text-muted-foreground" />
  </div>
);

function App() {
  const pathname = useLocation();
  const RoutePage = pathname.startsWith("/leaderboard")
    ? LazyLeaderboardPage
    : pathname === "/proofs"
      ? LazyProofsPage
      : pathname.startsWith("/proofs/")
        ? LazyPublicProofsPage
        : pathname === "/wallet"
          ? LazyWalletPage
          : LazyGamePage;

  return (
    <WalletProvider>
      <SiteHeader />
      <ErrorBoundary key={pathname}>
        <Suspense fallback={routeFallback}>
          <RoutePage />
        </Suspense>
      </ErrorBoundary>
      <SiteFooter />
    </WalletProvider>
  );
}

export default App;
