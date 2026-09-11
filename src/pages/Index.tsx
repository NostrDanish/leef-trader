import { useSeoMeta } from '@unhead/react';
import { TerminalApp } from '@/components/terminal/app';

const Index = () => {
  useSeoMeta({
    title: 'LEEF Trader — WAX Auto Trader for Alcor',
    description:
      'Live LEEF order books, routed quotes and an autoswap engine on the WAX blockchain. Keys stay in your tab; swaps settle on swap.alcor.',
  });

  return <TerminalApp />;
};

export default Index;
