import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress, type Address, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { backend } from "../lib/api";
import { DEPLOYMENT } from "../config";
import {
  ensureMonad,
  getWalletOptions,
  readWalletSnapshot,
  requestWalletProviders,
  selectWalletProvider,
  subscribeWallets,
  walletClient,
  walletProvider,
  type InjectedProvider,
  type WalletOption,
  type WalletSnapshot,
} from "../lib/chain";
import { errorMessage } from "../lib/format";

type Session = { account: Address; token: string; expiresAt: number };

export function useWallet(suiteHash: Hex | undefined) {
  const [account, setAccount] = useState<Address | null>(null);
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [provider, setProvider] = useState<InjectedProvider | null>(null);
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

  useEffect(() => subscribeWallets(setWallets), []);

  useEffect(() => {
    if (wallets.length === 1 && !provider) {
      selectWalletProvider(wallets[0]!.provider);
      setProvider(wallets[0]!.provider);
    }
  }, [wallets, provider]);

  useEffect(() => {
    if (!provider) return;
    let alive = true;
    const sync = async () => {
      try {
        const accounts = await provider.request({ method: "eth_accounts" });
        if (!alive) return;
        const next = Array.isArray(accounts) && isAddress(accounts[0]) ? accounts[0] : null;
        if (next?.toLowerCase() === accountRef.current?.toLowerCase()) return;
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
    provider.on?.("accountsChanged", onAccounts);
    return () => {
      alive = false;
      provider.removeListener?.("accountsChanged", onAccounts);
    };
  }, [provider]);

  useEffect(() => { void read(); }, [read]);

  const connectWith = useCallback(async (selected: InjectedProvider) => {
    setBusy(true);
    setError(null);
    try {
      selectWalletProvider(selected);
      setProvider(selected);
      const accounts = await selected.request({ method: "eth_requestAccounts" });
      const next = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof next !== "string" || !isAddress(next)) throw new Error("The wallet did not return an account.");
      await ensureMonad(selected);
      ++readSequence.current;
      accountRef.current = next;
      setSnapshot(null);
      session.current = null;
      setAccount(next);
      setChooserOpen(false);
      return next as Address;
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = useCallback(async () => {
    let available = wallets;
    if (!available.length) {
      requestWalletProviders();
      await new Promise(resolve => setTimeout(resolve, 500));
      available = getWalletOptions();
    }
    if (available.length > 1) { setChooserOpen(true); return; }
    if (available.length === 1) return connectWith(available[0]!.provider);
    setError("No EVM wallet was detected in this browser profile.");
  }, [wallets, connectWith]);

  const selectWallet = useCallback((wallet: WalletOption) => connectWith(wallet.provider), [connectWith]);

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

  return { account, snapshot, error, busy, wallets, chooserOpen, setChooserOpen, connect, selectWallet, read, authenticate };
}
