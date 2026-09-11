import { useState } from "react";
import { KeyRound, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { accountsForKeys, permissionForKey } from "@/lib/wallet/chain";
import { describeKey, importSecret, parsePrivateKey } from "@/lib/wallet/secret";
import { loginWallet, type WalletKind } from "@/lib/wallet/session";
import { isAccountName } from "@/lib/wallet/tokens";
import { useWallet } from "@/store/wallet";
import { toast } from "@/hooks/useToast";

export function ImportKeyDialog() {
  const open = useWallet((s) => s.importOpen);
  const setOpen = useWallet((s) => s.setImportOpen);
  const setLive = useWallet((s) => s.setLiveSession);
  const setWalletSession = useWallet((s) => s.setWalletSession);
  const hint = useWallet((s) => s.liveAccountHint);
  const [wif, setWif] = useState("");
  const [account, setAccount] = useState(hint ?? "");
  const [busy, setBusy] = useState<WalletKind | "key" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  async function onWallet(kind: WalletKind) {
    setError(null);
    setBusy(kind);
    try {
      const id = await loginWallet(kind);
      setWalletSession(id);
      setOpen(false);
      toast({
        title: `Connected ${id.account}@${id.permission} via ${
          kind === "wcw" ? "Cloud Wallet" : "Anchor"
        }`,
        description: "The wallet will ask you to sign each trade.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Wallet login failed";
      if (!/cancel|closed/i.test(msg)) setError(msg);
    } finally {
      setBusy(null);
    }
  }

  async function onImport() {
    setError(null);
    setBusy("key");
    try {
      const parsed = parsePrivateKey(wif);
      const pub = describeKey(parsed);
      let name = account.trim().toLowerCase();
      const found = await accountsForKeys([pub.publicKey, pub.legacy]);
      if (!name && found[0]) name = found[0].name;
      if (name && !isAccountName(name)) {
        throw new Error("Account names are 1–12 characters: a–z, 1–5, dots");
      }
      if (!name) {
        throw new Error("No account found for that key. Type the WAX account name.");
      }
      if (found.length > 0 && !found.some((f) => f.name === name)) {
        throw new Error(
          `That key is not on ${name}. Found ${found.map((f) => f.name).join(", ")}`,
        );
      }
      const permission =
        found.find((f) => f.name === name)?.permission ??
        (await permissionForKey(name, [pub.publicKey, pub.legacy]));
      importSecret(wif);
      setWif("");
      setLive({ account: name, publicKey: pub.publicKey, permission });
      setOpen(false);
      toast({
        title: `Session key for ${name}@${permission} — stays in this tab only`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Connect a WAX wallet</DialogTitle>
        <DialogDescription>
          Trades sign through your wallet — it asks for approval on each one
          (Cloud Wallet can whitelist the swap actions for hands-free trading).
        </DialogDescription>
        <div className="mt-4 space-y-3">
          <Button
            variant="leef"
            className="h-12 w-full justify-start px-4 text-sm"
            disabled={busy !== null}
            onClick={() => void onWallet("wcw")}
          >
            <Wallet className="size-4" />
            {busy === "wcw" ? "Opening Cloud Wallet…" : "WAX Cloud Wallet"}
            <span className="ml-auto text-xs font-normal opacity-80">
              mycloudwallet.com
            </span>
          </Button>
          <Button
            variant="outline"
            className="h-12 w-full justify-start px-4 text-sm"
            disabled={busy !== null}
            onClick={() => void onWallet("anchor")}
          >
            <Wallet className="size-4" />
            {busy === "anchor" ? "Opening Anchor…" : "Anchor"}
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              desktop / mobile app
            </span>
          </Button>

          <div className="rounded-lg border border-border bg-background p-3">
            <button
              type="button"
              className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowKey((v) => !v)}
              aria-expanded={showKey}
            >
              <span className="flex items-center gap-2">
                <KeyRound className="size-3.5" />
                Advanced: in-tab session key (fully automatic signing)
              </span>
              <span>{showKey ? "Hide" : "Show"}</span>
            </button>

            {showKey && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-subtle">
                  A WIF/PVT_K1 key is held in this tab's memory only — never
                  written to disk, never sent anywhere. Refreshing forgets it.
                  Use an <span className="font-mono">active</span>-permission
                  key, never the owner key.
                </p>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">
                    WIF or PVT_K1_
                  </span>
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
                <div className="flex justify-end">
                  <Button
                    onClick={() => void onImport()}
                    disabled={busy !== null || wif.length < 16}
                    size="sm"
                  >
                    {busy === "key" ? "Looking up…" : "Hold in this tab"}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-sell">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
