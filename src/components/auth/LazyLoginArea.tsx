import { lazy, Suspense } from 'react';

/**
 * The Nostr login area, code-split together with its provider stack
 * (NostrShell) so the terminal's first paint never downloads the
 * Nostr relay stack. Mounts as soon as its chunk arrives.
 */
const LoginAreaShell = lazy(() => import('./LoginAreaShell'));

export function LazyLoginArea({ className }: { className?: string }) {
  return (
    <Suspense fallback={<div className={className} aria-hidden="true" />}>
      <LoginAreaShell className={className} />
    </Suspense>
  );
}
