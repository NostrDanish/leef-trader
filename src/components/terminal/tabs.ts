import {
  Activity,
  Bot,
  Brain,
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
  { id: "overview", label: "Overview", short: "Home", icon: LayoutDashboard },
  { id: "tick", label: "Live tick", short: "Tick", icon: Radio },
  { id: "quotes", label: "Swap", short: "Swap", icon: GitCompare },
  { id: "pools", label: "Pools", short: "Pools", icon: Layers },
  { id: "pool", label: "Pool desk", short: "LP", icon: LineChart },
  { id: "portfolio", label: "Portfolio", short: "Book", icon: PieChart },
  { id: "bot", label: "AI Bot", short: "Bot", icon: Bot },
  { id: "wallet", label: "Wallet", short: "Wallet", icon: Wallet },
  { id: "tape", label: "Tape", short: "Tape", icon: Activity },
  { id: "il", label: "IL calc", short: "IL", icon: Calculator },
  { id: "ai", label: "AI analyst", short: "AI", icon: Brain },
  { id: "evidence", label: "Evidence", short: "Proof", icon: FlaskConical },
  { id: "infra", label: "Infrastructure", short: "Infra", icon: ServerCog },
];
