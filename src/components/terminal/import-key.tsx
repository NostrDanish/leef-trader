import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { accountsForKeys } from "@/lib/wallet/chain";
import { describeKey, importSecret, parsePrivateKey } from "@/lib/wallet/secret";
import { isAccountName } from "@/lib/wallet/tokens";
import { useWallet } from "@/store/wallet";
import { toast } from "@/hooks/useToast";

export function ImportKeyDialog() {
  const open = useWallet((s) => s.importOpen);
  const setOpen = useWallet((s) => s.setImportOpen);
  const setLive = useWallet((s) => s.setLiveSession);
  const hint = useWallet((s) => s.liveAccountHint);
  const [wif, setWif] = useState("");
  const [account, setAccount] = useState(hint ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onImport() {
    setError(null);
    setBusy(true);
    try {
      const parsed = parsePrivateKey(wif);
      const pub = describeKey(parsed);
      let name = account.trim().toLowerCase();
      const found = await accountsForKeys([pub.publicKey, pub.legacy]);
      if (!name && found[0]) name = found[0];
      if (name && !isAccountName(name)) {
        throw new Error("Account names are 1–12 characters: a–z, 1–5, dots");
      }
      if (!name) {
        throw new Error("No account found for that key. Type the WAX account name.");
      }
      if (found.length > 0 && !found.includes(name)) {
        throw new Error(`That key is not on ${name}. Found ${found.join(", ")}`);
      }
      importSecret(wif);
      setWif("");
      setLive({ account: name, publicKey: pub.publicKey });
      setOpen(false);
      toast({ title: `Session key for ${name} — stays in this tab only` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Import private key</DialogTitle>
        <DialogDescription>
          The key is held in this browser tab’s memory. It is never written to
          disk and never sent to our servers. Refreshing the page forgets it.
        </DialogDescription>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">WIF or PVT_K1_</span>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              name="wax-session-key"
              placeholder="5K… or PVT_K1_…"
              value={wif}
              onChange={(e) => setWif(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">
              WAX account {hint ? `(last ${hint})` : ""}
            </span>
            <Input
              autoComplete="off"
              placeholder="youraccount"
              value={account}
              onChange={(e) => setAccount(e.target.value.toLowerCase())}
            />
          </label>
          {error && <p className="text-xs text-sell">{error}</p>}
          <p className="text-xs text-subtle">
            Prefer a key that only has <span className="font-mono">active</span>{" "}
            permission on a trading account — not your owner key.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void onImport()} disabled={busy || wif.length < 16}>
              {busy ? "Looking up…" : "Hold in this tab"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
