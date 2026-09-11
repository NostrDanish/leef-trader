import { useSeoMeta } from '@unhead/react';
import { TerminalApp } from '@/components/terminal/app';

const Index = () => {
  useSeoMeta({
    title: 'LEEF Trader — AI Auto Trading Bot for WAX / Alcor',
    description:
      'AI signal engines, five trading strategies and atomic cross-pool arbitrage on the WAX blockchain. Import a session key, set your goals, hit start — keys never leave your tab.',
  });

  return <TerminalApp />;
};

export default Index;
