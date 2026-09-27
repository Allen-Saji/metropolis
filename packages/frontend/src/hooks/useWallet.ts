import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress, type Address, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { backend } from "../lib/api";
import { DEPLOYMENT } from "../config";
import { ensureMonad, readWalletSnapshot, walletClient, walletProvider, type WalletSnapshot } from "../lib/chain";
import { errorMessage } from "../lib/format";

type Session = { account: Address; token: string; expiresAt: number };

export function useWallet(suiteHash: Hex | undefined) {
  const [account, setAccount] = useState<Address | null>(null);
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const session = useRef<Session | null>(null);
  const readSequence = useRef(0);
  const accountRef = useRef<Address | null>(null);

  const read = useCallback(async (target: Address | null = account) => {
    if (!target || !suiteHash) return;
    if (accountRef.current?.toLowerCase() !== target.toLowerCase()) return;
    const sequence = ++readSequence.current;
    try {
      const data = await readWalletSnapshot(target, suiteHash);
      if (sequence !== readSequence.current || accountRef.current?.toLowerCase() !== target.toLowerCase()) return;
      setSnapshot(data);
      setError(null);
    } catch (cause) {
      if (sequence !== readSequence.current || accountRef.current?.toLowerCase() !== target.toLowerCase()) return;
      setError(errorMessage(cause));
    }
  }, [account, suiteHash]);

  useEffect(() => {
    if (!window.ethereum) return;
    let alive = true;
    const sync = async () => {
      try {
        const accounts = await walletProvider().request({ method: "eth_accounts" });
        if (!alive) return;
        const next = Array.isArray(accounts) && isAddress(accounts[0]) ? accounts[0] : null;
        ++readSequence.current;
        accountRef.current = next;
        setAccount(next);
        setSnapshot(null);
        session.current = null;
      } catch {
        // A wallet may decline silent account access.
      }
    };
    const onAccounts = () => void sync();
    void sync();
    window.ethereum.on?.("accountsChanged", onAccounts);
    return () => {
      alive = false;
      window.ethereum?.removeListener?.("accountsChanged", onAccounts);
    };
  }, []);

  useEffect(() => { void read(); }, [read]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const provider = walletProvider();
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const next = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof next !== "string" || !isAddress(next)) throw new Error("The wallet did not return an account.");
      await ensureMonad(provider);
      ++readSequence.current;
      accountRef.current = next;
      setSnapshot(null);
      session.current = null;
      setAccount(next);
      return next as Address;
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }, []);

  const authenticate = useCallback(async (target: Address) => {
    if (accountRef.current?.toLowerCase() !== target.toLowerCase()) throw new Error("Reconnect the selected wallet account.");
    const cached = session.current;
    if (cached && cached.account.toLowerCase() === target.toLowerCase() && cached.expiresAt > Date.now() + 30_000) {
      return cached.token;
    }
    await ensureMonad(walletProvider());
    const challenge = await backend.challenge(target);
    const parsed = parseSiweMessage(challenge.message);
    if (
      parsed.address?.toLowerCase() !== target.toLowerCase() ||
      parsed.chainId !== DEPLOYMENT.chainId ||
      parsed.domain !== window.location.host ||
      parsed.uri !== window.location.origin ||
      parsed.nonce !== challenge.nonce
    ) throw new Error("The sign-in challenge did not match this site or wallet.");
    const signature = await walletClient(target).signMessage({ message: challenge.message });
    const verified = await backend.verify(challenge.nonce, signature);
    if (accountRef.current?.toLowerCase() !== target.toLowerCase()) throw new Error("The wallet account changed during sign-in.");
    if (verified.address.toLowerCase() !== target.toLowerCase()) throw new Error("The server authenticated a different account.");
    session.current = { account: target, token: verified.token, expiresAt: Date.parse(verified.expiresAt) };
    return verified.token;
  }, []);

  return { account, snapshot, error, busy, connect, read, authenticate };
}
