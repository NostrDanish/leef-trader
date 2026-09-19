import NostrShell from '@/components/NostrShell';
import { LoginArea } from './LoginArea';

/**
 * LoginArea wrapped in the Nostr provider stack. Kept in its own chunk
 * (loaded via LazyLoginArea) so the Nostr dependencies stay out of the
 * initial bundle.
 */
export default function LoginAreaShell({ className }: { className?: string }) {
  return (
    <NostrShell>
      <LoginArea className={className} />
    </NostrShell>
  );
}
