import { Keyboard } from "lucide-react";
import { cn } from "@/lib/utils";

export function ControlsHint({ className }: { className?: string }) {
  return (
    <div
      data-slot="controls-hint"
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border border-border/40 bg-surface-dim px-4 py-2",
        className,
      )}
    >
      <Keyboard className="hidden size-4 text-muted-foreground sm:block" aria-hidden="true" />

      {/* Desktop: full key listing */}
      <p className="m-0 hidden text-xs tracking-wide text-muted-foreground sm:block">
        <Kbd>Arrows</Kbd> move
        <Sep />
        <Kbd>Space</Kbd> fire
        <Sep />
        <Kbd>P</Kbd> pause
        <Sep />
        <Kbd>R</Kbd> restart
        <Sep />
        <Kbd>M</Kbd> mute
        <Sep />
        <Kbd>D</Kbd> save tape
        <Sep />
        <Kbd>Esc</Kbd> menu
        <Sep />
        Xbox: LS/D-pad turn, LT/LB thrust, A/RT fire, Start pause, View menu
      </p>

      {/* Mobile: simplified hint */}
      <p className="m-0 text-xs tracking-wide text-muted-foreground sm:hidden">
        Tap to start. Use the Autopilot button to play.
      </p>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border/50 bg-[rgba(20,40,65,0.5)] px-1.5 py-0.5 font-display text-[0.7rem] text-card-foreground">
      {children}
    </kbd>
  );
}

function Sep() {
  return (
    <span className="mx-1.5 inline-block text-border" aria-hidden="true">
      |
    </span>
  );
}
