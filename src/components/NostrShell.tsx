import type { ReactNode } from 'react';
import NostrProvider from '@/components/NostrProvider';
import { NostrSync } from '@/components/NostrSync';
import { NostrLoginProvider } from '@nostrify/react/login';

/**
 * NostrShell - the Nostr provider stack.
 *
 * Code-split out of the initial bundle: it is lazy-loaded by the AppRouter
 * only for routes that need Nostr (NIP-19 pages). The trading terminal does
 * not use Nostr, so it never pays the download/parse cost of the relay pool.
 */
export default function NostrShell({ children }: { children: ReactNode }) {
  return (
    <NostrLoginProvider storageKey='nostr:login'>
      <NostrProvider>
        <NostrSync />
        {children}
      </NostrProvider>
    </NostrLoginProvider>
  );
}
