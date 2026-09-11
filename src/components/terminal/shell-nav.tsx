import { Menu } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { type TabId, useTerminal } from "@/store/terminal";
import { TABS, type TabDef } from "./tabs";

export function DesktopNav({ poolCount }: { poolCount: number }) {
  const tab = useTerminal((s) => s.tab);
  const setTab = useTerminal((s) => s.setTab);
  return (
    <nav
      className="hidden gap-1 overflow-x-auto pb-3 [scrollbar-width:none] md:flex [&::-webkit-scrollbar]:hidden"
      aria-label="Sections"
    >
      {TABS.map((t) => (
        <NavChip
          key={t.id}
          tab={t}
          active={tab === t.id}
          poolCount={poolCount}
          onClick={() => setTab(t.id)}
        />
      ))}
    </nav>
  );
}

export function MobileNav({ poolCount }: { poolCount: number }) {
  const tab = useTerminal((s) => s.tab);
  const setTab = useTerminal((s) => s.setTab);
  const [open, setOpen] = useState(false);
  const primary: TabId[] = ["tick", "bot", "quotes", "wallet"];
  const more = TABS.filter((t) => !primary.includes(t.id));

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
        aria-label="Primary"
      >
        <div className="grid grid-cols-5">
          {primary.map((id) => {
            const t = TABS.find((x) => x.id === id)!;
            const Icon = t.icon;
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium",
                  active ? "text-accent" : "text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
                {t.short}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium",
              more.some((t) => t.id === tab) ? "text-accent" : "text-muted-foreground",
            )}
          >
            <Menu className="size-4" />
            More
          </button>
        </div>
      </nav>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl bg-surface">
          <SheetHeader>
            <SheetTitle>Desks</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-2 p-4 pt-0">
            {more.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <Button
                  key={t.id}
                  variant={active ? "secondary" : "outline"}
                  className="h-12 justify-start"
                  onClick={() => {
                    setTab(t.id);
                    setOpen(false);
                  }}
                >
                  <Icon className="size-4" />
                  {t.label}
                  {t.id === "pools" && (
                    <span className="ml-auto font-mono text-xs text-accent">{poolCount}</span>
                  )}
                </Button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function NavChip({
  tab,
  active,
  poolCount,
  onClick,
}: {
  tab: TabDef;
  active: boolean;
  poolCount: number;
  onClick: () => void;
}) {
  const Icon = tab.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors",
        active
          ? "border border-accent/30 bg-accent/10 text-accent"
          : "border border-transparent text-muted-foreground hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon className="size-3.5" />
      {tab.label}
      {tab.id === "pools" && (
        <span className="rounded-full bg-surface-3 px-1.5 font-mono text-accent">{poolCount}</span>
      )}
    </button>
  );
}
