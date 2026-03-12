import { GamePageWrapper } from "./components/game/GamePageWrapper";
import { LeaderboardPage } from "./components/leaderboard/LeaderboardPage";
import { ProofsPage } from "./components/proofs/ProofsPage";
import { PublicProofsPage } from "./components/proofs/PublicProofsPage";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { useLocation } from "./hooks/useLocation";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";
import { WalletPage } from "./components/wallet/WalletPage";
import { WalletProvider } from "./contexts/WalletContext";

function App() {
  const pathname = useLocation();

  return (
    <WalletProvider>
      <SiteHeader />
      {pathname.startsWith("/leaderboard") ? (
        <ErrorBoundary key={pathname}>
          <LeaderboardPage />
        </ErrorBoundary>
      ) : pathname === "/proofs" ? (
        <ErrorBoundary key={pathname}>
          <ProofsPage />
        </ErrorBoundary>
      ) : pathname.startsWith("/proofs/") ? (
        <ErrorBoundary key={pathname}>
          <PublicProofsPage />
        </ErrorBoundary>
      ) : pathname === "/wallet" ? (
        <ErrorBoundary key={pathname}>
          <WalletPage />
        </ErrorBoundary>
      ) : pathname.startsWith("/replay/") ? (
        <ErrorBoundary key={pathname}>
          <GamePageWrapper />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary key={pathname}>
          <GamePageWrapper />
        </ErrorBoundary>
      )}
      <SiteFooter />
    </WalletProvider>
  );
}

export default App;
