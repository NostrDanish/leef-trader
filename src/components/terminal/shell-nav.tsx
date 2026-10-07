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
      className="hidden gap-1 overflow-x-auto border-b border-border/70 [scrollbar-width:none] md:flex [&::-webkit-scrollbar]:hidden"
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
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border/70 bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
        aria-label="Primary"
      >
        <div className="grid grid-cols-5 px-2 py-1.5">
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
                  "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition-colors",
                  active ? "text-leef" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "grid size-8 place-items-center rounded-full transition-colors",
                    active && "bg-leef/15 ring-1 ring-leef/30",
                  )}
                >
                  <Icon className="size-4" />
                </span>
                {t.short}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition-colors",
              more.some((t) => t.id === tab) ? "text-leef" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "grid size-8 place-items-center rounded-full transition-colors",
                more.some((t) => t.id === tab) && "bg-leef/15 ring-1 ring-leef/30",
              )}
            >
              <Menu className="size-4" />
            </span>
            More
          </button>
        </div>
      </nav>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="rounded-t-3xl border-border/70 bg-surface">
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
                  className={cn("h-12 justify-start rounded-xl", active && "ring-1 ring-leef/30")}
                  onClick={() => {
                    setTab(t.id);
                    setOpen(false);
                  }}
                >
                  <Icon className="size-4" />
                  {t.label}
                  {t.id === "pools" && (
                    <span className="ml-auto font-mono text-xs text-leef">{poolCount}</span>
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
        "relative flex h-12 shrink-0 items-center gap-2 whitespace-nowrap px-3.5 text-[13px] font-medium transition-colors",
        active ? "text-fg" : "text-muted-foreground hover:text-fg",
      )}
    >
      <Icon className={cn("size-4", active && "text-leef")} />
      {tab.label}
      {tab.id === "pools" && (
        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-leef ring-1 ring-border">
          {poolCount}
        </span>
      )}
      <span
        className={cn(
          "absolute inset-x-3 bottom-0 h-0.5 rounded-full transition-all",
          active ? "bg-leef opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}
