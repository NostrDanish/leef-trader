import {
  Activity,
  Bot,
  Calculator,
  FlaskConical,
  GitCompare,
  Layers,
  LayoutDashboard,
  LineChart,
  PieChart,
  Radio,
  ServerCog,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { TabId } from "@/store/terminal";

export type TabDef = { id: TabId; label: string; short: string; icon: LucideIcon };

export const TABS: TabDef[] = [
  { id: "tick", label: "Live tick", short: "Tick", icon: Radio },
  { id: "bot", label: "AI Bot", short: "Bot", icon: Bot },
  { id: "portfolio", label: "Portfolio", short: "Book", icon: PieChart },
  { id: "quotes", label: "Quotes", short: "Swap", icon: GitCompare },
  { id: "wallet", label: "Wallet", short: "Wallet", icon: Wallet },
  { id: "overview", label: "Overview", short: "Home", icon: LayoutDashboard },
  { id: "pools", label: "Pools", short: "Pools", icon: Layers },
  { id: "pool", label: "Pool desk", short: "LP", icon: LineChart },
  { id: "il", label: "IL calc", short: "IL", icon: Calculator },
  { id: "tape", label: "Tape", short: "Tape", icon: Activity },
  { id: "evidence", label: "Evidence", short: "Proof", icon: FlaskConical },
  { id: "infra", label: "Infrastructure", short: "Infra", icon: ServerCog },
];
