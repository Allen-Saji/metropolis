import { useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { agentCallsign, DEPLOYMENT } from "./config";
import { useVaultData } from "./hooks/useVaultData";
import { useWallet } from "./hooks/useWallet";
import { useHeroMotion, useSiteMotion } from "./hooks/useSiteMotion";
import { HeroVisual } from "./HeroVisual";
import { backend, type ActivityEvent, type QualificationRun, type VaultState } from "./lib/api";
import { assetAbi, ensureMonad, publicClient, vaultAbi, walletClient, walletProvider, type WalletOption } from "./lib/chain";
import { errorMessage, formatAmount, formatDate, lifecycleLabel, shortAddress } from "./lib/format";

const explorer = "https://testnet.monadscan.com";
const navItems = [
  { label: "How it works", href: "#protocol" },
  { label: "Vault console", href: "#console" },
  { label: "Qualification", href: "#qualification" },
];

function IconArrow({ diagonal = false }: { diagonal?: boolean }) {
  return <svg className="icon-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">{diagonal ? <path d="M3 13 13 3M5 3h8v8" stroke="currentColor" strokeWidth="1.5" /> : <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" />}</svg>;
}

function Brand() {
  return <a className="brand" href="#top" aria-label="Metropolis home">
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path d="M2 25V5h6l7 10L22 5h6v20h-5V12l-8 10L7 12v13H2Z" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M2 2h26M2 28h26" stroke="currentColor" strokeWidth="1"/>
    </svg><span>metropolis<span className="brand-period">.</span></span>
  </a>;
}

function Chip({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "blue" | "alert" }) {
  return <span className={`v-chip ${tone}`}><span className="chip-dot" />{label}</span>;
}

function SectionHeader({ kicker, title, copy, aside }: { kicker: string; title: string; copy?: string; aside?: React.ReactNode }) {
  return <div className="section-header" data-reveal><div><p className="eyebrow">{kicker}</p><h2>{title}</h2>{copy && <p className="section-copy">{copy}</p>}</div>{aside}</div>;
}

function Header({ account, connect, busy, wallets, chooserOpen, closeChooser, selectWallet, walletError }: {
  account: Address | null;
  connect: () => Promise<unknown>;
  busy: boolean;
  wallets: WalletOption[];
  chooserOpen: boolean;
  closeChooser: () => void;
  selectWallet: (wallet: WalletOption) => Promise<unknown>;
  walletError: string | null;
}) {
  const [open, setOpen] = useState(false);
  return <header className="site-header">
    <Brand />
    <nav className="desktop-nav" aria-label="Main navigation">{navItems.map(item => <a key={item.href} href={item.href}>{item.label}</a>)}</nav>
    <div className="header-actions">
      <button className="btn-square header-cta" type="button" onClick={() => { if (!account) void connect().catch(() => {}); else document.getElementById("console")?.scrollIntoView({ behavior: "smooth" }); }} disabled={busy}>
        {account ? shortAddress(account) : "Connect wallet"} <IconArrow diagonal />
      </button>
      <button className="mobile-toggle" type="button" aria-expanded={open} aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen(value => !value)}>{open ? "[ X ]" : "[ = ]"}</button>
    </div>
    {open && <nav className="mobile-nav" aria-label="Mobile navigation">{navItems.map(item => <a href={item.href} key={item.href} onClick={() => setOpen(false)}>{item.label}<IconArrow diagonal /></a>)}<button type="button" className="btn-square" onClick={() => { setOpen(false); if (!account) void connect().catch(() => {}); else document.getElementById("console")?.scrollIntoView({ behavior: "smooth" }); }}>{account ? shortAddress(account) : "Connect wallet"}<IconArrow diagonal /></button></nav>}
    {walletError && <div className="wallet-notice mono" role="alert">{walletError}</div>}
    {chooserOpen && <div className="wallet-dialog-backdrop"><div className="wallet-dialog card" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title"><div className="card-topline"><span className="eyebrow">WALLET CONNECTION</span><button className="wallet-dialog-close mono" type="button" onClick={closeChooser} aria-label="Close wallet chooser">[ X ]</button></div><h2 id="wallet-dialog-title">Choose your wallet.</h2><p>Connect the wallet you want to use on Monad Testnet.</p><div className="wallet-options">{wallets.map(wallet => <button type="button" className="btn-outline" key={wallet.id} onClick={() => void selectWallet(wallet).catch(() => {})} disabled={busy}>{wallet.name}<IconArrow diagonal /></button>)}</div></div></div>}
  </header>;
}

function Hero({ state }: { state: VaultState | null }) {
  const heroRef = useRef<HTMLElement>(null);
  useHeroMotion(heroRef);
  return <section className="hero" id="top" aria-labelledby="hero-title" ref={heroRef}>
    <div className="hero-grid page-width">
      <div className="hero-content">
        <p className="hero-kicker mono">[ AGENT MANDATE / TRADES ONLY ]</p>
        <h1 id="hero-title">The agent can trade.<br /><em>It can't cash out.</em></h1>
        <p className="hero-copy">Depositors fund an AUSD vault that owns the Perpl account. A qualified agent can place BTC and ETH orders within limits enforced by the contracts.</p>
        <a className="btn-square hero-cta" href="#console">Inspect the live vault <IconArrow diagonal /></a>
      </div>
      <HeroVisual />
      <div className="hero-foot mono"><span>AGENT / {state ? agentCallsign(state.activeAgentId) : "SYNCING"}</span><span>CHAIN / MONAD 10143</span><span>STATE / {lifecycleLabel(state?.state).toUpperCase()}</span></div>
    </div>
  </section>;
}

function StatusBoard({ state, qualified, qualificationExpiry, error, refreshing, refresh }: { state: VaultState | null; qualified: boolean | null; qualificationExpiry: bigint | null; error: string | null; refreshing: boolean; refresh: () => Promise<void> }) {
  const agent = state?.activeAgentId && state.activeAgentId !== "0" ? agentCallsign(state.activeAgentId) : "NO ACTIVE AGENT";
  return <div className="status-board card" data-reveal>
    <div className="card-topline"><span className="eyebrow">01 / OPERATING STATE</span><button type="button" className="text-action" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "SYNCING..." : "REFRESH DATA +"}</button></div>
    <div className="status-board-main"><div><span className="micro-label">VAULT STATE</span><h3>{lifecycleLabel(state?.state)}<span className="blue-period">.</span></h3><p>{state?.state === 0 ? "Deposits and redemptions are open while the vault is settled." : state?.state === 1 ? "The agent can execute within the on-chain risk policy." : state?.state === 2 ? "Exposure is being closed before the next settled window." : "Reading the vault from Monad Testnet."}</p></div><div className="status-aside"><div className="big-ascii" aria-hidden="true">{state?.state === 1 ? ">_" : "[_]"}</div><span className="mono muted">BLOCK {state?.blockNumber ?? "--"}</span></div></div>
    {error && <p className="inline-error" role="alert">Live state unavailable: {error}</p>}
    <div className="status-rows mono">
      <div><span>ACTIVE AGENT</span><strong>{agent}</strong><Chip label={!state || state.activeAgentId === "0" ? "NONE" : "BOUND"} tone={!state || state.activeAgentId === "0" ? "neutral" : "blue"} /></div>
      <div><span>QUALIFICATION</span><strong>{qualified === null ? "CHECKING" : qualified ? "VALID" : "EXPIRED / ABSENT"}</strong><Chip label={qualified === null ? "UNKNOWN" : qualified ? "PASS" : "WARN"} tone={qualified ? "good" : "neutral"} /></div>
      <div><span>EXPIRES</span><strong>{formatDate(qualificationExpiry)}</strong><span className="row-end">REGISTRY</span></div>
      <div><span>SAFETY SWITCH</span><strong>{state?.paused ? "PAUSED" : "ENABLED"}</strong><Chip label={state?.paused ? "HALT" : "ACTIVE"} tone={state?.paused ? "alert" : "good"} /></div>
    </div>
    <div className="card-footer mono"><span>CONTRACT / <a href={`${explorer}/address/${DEPLOYMENT.vault}`} target="_blank" rel="noreferrer">{shortAddress(DEPLOYMENT.vault)} <IconArrow diagonal /></a></span><span>ON-CHAIN ID / {state?.activeAgentId ?? "--"}</span></div>
  </div>;
}

function ExposureBoard({ state }: { state: VaultState | null }) {
  const equity = state?.risk?.equity;
  const assets = [
    { name: "BTC-PERP", id: "16", notional: state?.risk?.btcNotional },
    { name: "ETH-PERP", id: "32", notional: state?.risk?.ethNotional },
  ];
  return <div className="exposure-board card" data-reveal><div className="card-topline"><span className="eyebrow">02 / EXPOSURE MONITOR</span><Chip label={state?.state === 0 ? "SETTLED" : state?.riskAvailable ? "RISK READABLE" : "RISK UNAVAILABLE"} tone={state?.riskAvailable ? "good" : "neutral"} /></div>
    <div className="exposure-summary"><span className="micro-label">{state?.state === 0 ? "SETTLED ASSETS" : "ESTIMATED LIVE EQUITY"}</span><div><strong>{formatAmount(state?.state === 0 ? state.settledAssets : equity)}</strong><span className="mono">AUSD</span></div></div>
    <div className="exposure-list mono">{assets.map(asset => {
      const percentage = equity && asset.notional ? Math.min(100, Number(BigInt(asset.notional) * 100n / BigInt(equity))) : 0;
      const open = state?.positions.some(position => String(position.perpId) === asset.id);
      return <div className="exposure-row" key={asset.id}><div><span>{asset.name}</span><span>{open ? formatAmount(asset.notional) + " AUSD" : "NO POSITION"}</span></div><div className="exposure-track"><span style={{ width: `${percentage}%` }} /></div><small>{open ? `${percentage}% OF EQUITY` : "IDLE"}</small></div>;
    })}</div><p className="card-note mono">{state?.state === 0 ? "No live exposure in settled mode." : !state?.riskAvailable ? "Risk snapshot is unavailable. New exposure should remain blocked by the contract." : "Notional is marked against current risk equity."}</p>
  </div>;
}

function EventStream({ activity, indexedBlock, headBlock }: { activity: ActivityEvent[]; indexedBlock?: string; headBlock?: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const selectedEvent = activity.find(event => `${event.tx_hash}:${event.log_index}` === selected) ?? activity[0];
  const recent = activity.slice(0, 12);
  const minBlock = activity.length ? Math.min(...activity.map(item => Number(item.block_number))) : 0;
  const maxBlock = activity.length ? Math.max(...activity.map(item => Number(item.block_number))) : 0;
  const backfilling = !!indexedBlock && !!headBlock && BigInt(indexedBlock) < BigInt(headBlock) - 100n;
  const label = (event: ActivityEvent) => event.name.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
  return <section className="section page-width"><SectionHeader kicker="TRANSACTION LOG" title="Vault transactions on-chain." copy="Select an event to read its data and open the transaction in Monadscan." aside={<span className="mono muted header-meta">INDEXED TO BLOCK {indexedBlock ?? "--"}</span>} />
    <div className="stream-shell card" data-reveal><div className="stream-toolbar mono"><span>VAULT EVENTS</span><span>CONTRACT {shortAddress(DEPLOYMENT.vault)}</span><Chip label={backfilling ? "BACKFILLING" : "ON-CHAIN"} tone="blue" /></div>
      {backfilling && <div className="stream-backfill mono">INDEXER CURSOR #{indexedBlock} / HEAD #{headBlock}. NEWER EVENTS APPEAR AS THE CURSOR ADVANCES.</div>}
      <div className="stream-grid"><aside className="stream-sidebar"><div className="sidebar-title mono">EVENT INDEX</div>{recent.length ? recent.map((event, index) => <button className={`event-selector ${selectedEvent === event ? "active" : ""}`} key={`${event.tx_hash}:${event.log_index}`} type="button" onClick={() => setSelected(`${event.tx_hash}:${event.log_index}`)}><span className="selector-dot" /><span><strong>{label(event)}</strong><small>EVT-{String(index + 1).padStart(3, "0")} / {shortAddress(event.tx_hash)}</small></span></button>) : <p className="empty-sidebar mono">NO EVENTS INDEXED YET</p>}</aside>
        <div className="stream-main"><div className="stream-head mono"><span>EVENT</span><span>BLOCK POSITION</span><span>TX HASH</span></div>{recent.length ? recent.map((event) => {
          const offset = maxBlock === minBlock ? 50 : ((Number(event.block_number) - minBlock) / (maxBlock - minBlock)) * 88 + 4;
          const active = selectedEvent === event;
          return <button className={`stream-row ${active ? "active" : ""}`} key={`${event.tx_hash}:${event.log_index}`} onClick={() => setSelected(`${event.tx_hash}:${event.log_index}`)} type="button"><span>{label(event)}<small>LOG {event.log_index}</small></span><span className="block-visual"><span className="block-track"><span className="block-mark" style={{ left: `${offset}%` }} /></span><small>#{event.block_number}</small></span><span>{shortAddress(event.tx_hash)} <IconArrow diagonal /></span></button>;
        }) : <div className="stream-empty mono">[ NO EVENTS YET ]<br />The indexer will populate this stream as vault transactions occur.</div>}
          {selectedEvent && <div className="event-detail mono" key={`${selectedEvent.tx_hash}:${selectedEvent.log_index}`}><div><span>SELECTED / {label(selectedEvent)}</span><a href={`${explorer}/tx/${selectedEvent.tx_hash}`} target="_blank" rel="noreferrer">VIEW TRANSACTION <IconArrow diagonal /></a></div><code>{JSON.stringify(selectedEvent.data, null, 2)}</code></div>}
        </div></div></div>
  </section>;
}

function OperatingModel() {
  return <section className="section page-width protocol" id="protocol">
    <SectionHeader kicker="01 / OPERATING MODEL" title="A trading mandate with an exit." copy="The agent gets a route to Perpl orders. Depositors retain a route back to their AUSD after settlement." />
    <div className="bento-grid">
      <article className="bento-card card" data-reveal>
        <div className="card-topline"><span className="eyebrow">CUSTODY</span><span className="mono muted">AUSD / SHARES</span></div>
        <h3>Capital stays in the vault.</h3>
        <p>Depositors receive shares. The vault owns the Perpl account; the trading operator cannot withdraw or transfer its collateral.</p>
        <div className="model-line mono"><span>DEPOSIT AUSD</span><span>-&gt;</span><span>RECEIVE SHARES</span></div>
      </article>
      <article className="bento-card card" data-reveal>
        <div className="card-topline"><span className="eyebrow">EXECUTION</span><span className="mono muted">ORDERS ONLY</span></div>
        <h3>Every order meets the gate.</h3>
        <p>The operator must be qualified. Market, order size, leverage, price freshness and drawdown are checked by the contracts before execution.</p>
        <div className="model-line mono"><span>SIGNED ORDER</span><span>-&gt;</span><span>RISK CHECK</span></div>
      </article>
      <article className="bento-card card" data-reveal>
        <div className="card-topline"><span className="eyebrow">SETTLEMENT</span><span className="mono muted">SHAREHOLDER RIGHT</span></div>
        <h3>Shareholders can call time.</h3>
        <p>A shareholder can request settlement. The keeper closes positions and returns collateral before the vault reopens redemptions.</p>
        <div className="model-line mono"><span>CLOSE POSITIONS</span><span>-&gt;</span><span>REDEEM SHARES</span></div>
      </article>
    </div>
  </section>;
}

function WalletPanel({ state, account, snapshot, walletBusy, walletError, connect, readWallet, refresh }: {
  state: VaultState | null; account: Address | null; snapshot: ReturnType<typeof useWallet>["snapshot"];
  walletBusy: boolean; walletError: string | null; connect: () => Promise<unknown>; readWallet: () => Promise<void>; refresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"deposit" | "redeem">("deposit");
  const [amount, setAmount] = useState("");
  const [tradeAmount, setTradeAmount] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fault, setFault] = useState<string | null>(null);
  const manager = !!account && snapshot?.manager.toLowerCase() === account.toLowerCase();
  const canOperate = !!account && !!snapshot && state?.state === 0 && !state.paused;
  const canStartTrading = state?.state === 0 && !state.paused && !!snapshot?.qualified && BigInt(state?.totalShares ?? 0) > 0n && Number(state?.settledUntil ?? 0) <= Date.now() / 1000;
  const shares = snapshot?.shares ?? 0n;
  const isDepositing = tab === "deposit";

  async function transaction(label: string, fn: (account: Address) => Promise<Hex>) {
    if (!account) return;
    setPending(label); setNotice(null); setFault(null);
    try {
      await ensureMonad(walletProvider());
      const hash = await fn(account);
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("The transaction reverted on-chain.");
      setNotice(`${label} confirmed. TX ${shortAddress(hash)}`);
      await Promise.all([readWallet(), refresh()]);
      setAmount("");
    } catch (cause) { setFault(errorMessage(cause)); }
    finally { setPending(null); }
  }

  async function submitDeposit() {
    if (!account || !snapshot) return;
    let assets: bigint;
    try { assets = parseUnits(amount, 6); } catch { setFault("Enter a valid AUSD amount with up to 6 decimals."); return; }
    if (assets <= 0n || assets > snapshot.ausd) { setFault("Amount must be positive and within your AUSD balance."); return; }
    setPending("Deposit"); setFault(null); setNotice(null);
    try {
      await ensureMonad(walletProvider());
      if (snapshot.allowance < assets) {
        setPending("Approve AUSD");
        const approve = await walletClient(account).writeContract({ address: DEPLOYMENT.asset, abi: assetAbi, functionName: "approve", args: [DEPLOYMENT.vault, assets] });
        const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approve, timeout: 120_000 });
        if (approvalReceipt.status !== "success") throw new Error("AUSD approval reverted.");
      }
      setPending("Deposit");
      const quote = await publicClient.readContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "previewDeposit", args: [assets] });
      const minShares = quote * 995n / 1000n;
      const hash = await walletClient(account).writeContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "deposit", args: [assets, account, minShares] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error("The deposit reverted on-chain.");
      setNotice(`Deposit confirmed. TX ${shortAddress(hash)}`);
      setAmount("");
      await Promise.all([readWallet(), refresh()]);
    } catch (cause) { setFault(errorMessage(cause)); }
    finally { setPending(null); }
  }

  async function submitRedeem() {
    if (!account || !snapshot) return;
    let quantity: bigint;
    try { quantity = parseUnits(amount, 12); } catch { setFault("Enter a valid share amount with up to 12 decimals."); return; }
    if (quantity <= 0n || quantity > snapshot.shares) { setFault("Amount must be positive and within your share balance."); return; }
    await transaction("Redeem", async target => {
      const quote = await publicClient.readContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "previewRedeem", args: [quantity] });
      const minAssets = quote * 995n / 1000n;
      return walletClient(target).writeContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "redeem", args: [quantity, target, minAssets] });
    });
  }

  async function startTrading() {
    let assets: bigint;
    try { assets = parseUnits(tradeAmount, 6); } catch { setFault("Enter a valid AUSD amount to allocate."); return; }
    if (assets <= 0n || assets > BigInt(state?.settledAssets ?? 0)) { setFault("Allocation must be positive and within settled assets."); return; }
    await transaction("Start trading", target => walletClient(target).writeContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "startTrading", args: [assets] }));
  }

  return <section className="wallet-section section page-width" id="console"><SectionHeader kicker="02 / INTERACTIVE CONSOLE" title="Your capital. Your controls." copy="Connect an EVM wallet on Monad Testnet to deposit AUSD, redeem shares, or request settlement." aside={<Chip label="TESTNET ONLY" tone="blue" />} />
    <div className="console-grid"><div className="wallet-card card" data-reveal><div className="card-topline"><span className="eyebrow">VAULT ACCESS</span><span className="mono muted">01 / 02</span></div><div className="wallet-tabs" role="tablist" aria-label="Vault action"><button type="button" role="tab" aria-selected={isDepositing} className={isDepositing ? "active" : ""} onClick={() => { setTab("deposit"); setAmount(""); setFault(null); }}>DEPOSIT</button><button type="button" role="tab" aria-selected={!isDepositing} className={!isDepositing ? "active" : ""} onClick={() => { setTab("redeem"); setAmount(""); setFault(null); }}>REDEEM</button></div>
      {account && <div className="wallet-balance mono" key={tab}><span>{isDepositing ? "AVAILABLE AUSD" : "YOUR VAULT SHARES"}</span><strong>{formatAmount(isDepositing ? snapshot?.ausd : snapshot?.shares, isDepositing ? 6 : 12)} <small>{isDepositing ? "AUSD" : "SHR"}</small></strong></div>}
      <label className="input-label mono" htmlFor="wallet-amount">{isDepositing ? "AMOUNT TO DEPOSIT" : "SHARES TO REDEEM"}</label><div className="amount-field"><input id="wallet-amount" type="text" inputMode="decimal" placeholder="0.00" value={amount} onChange={event => setAmount(event.target.value)} disabled={!canOperate || !!pending} /><span className="mono">{isDepositing ? "AUSD" : "SHR"}</span></div>
      <div className="amount-helper mono"><span>{state?.state === 0 ? "SETTLED WINDOW / OPEN" : "AVAILABLE WHEN SETTLED"}</span><button type="button" onClick={() => setAmount(snapshot ? formatUnits(isDepositing ? snapshot.ausd : snapshot.shares, isDepositing ? 6 : 12) : "")} disabled={!snapshot || !canOperate}>MAX</button></div>
      {!account ? <button className="btn-square full-width" type="button" onClick={() => void connect().catch(() => {})} disabled={walletBusy}>Connect wallet <IconArrow diagonal /></button> : <button className="btn-square full-width" type="button" onClick={() => void (isDepositing ? submitDeposit() : submitRedeem())} disabled={!canOperate || !!pending || !amount}>{pending ?? (isDepositing ? "Deposit AUSD" : "Redeem shares")} <IconArrow diagonal /></button>}
      <p className="form-disclaimer mono">{isDepositing ? "An AUSD approval may be requested before deposit. Minimum shares are quoted with 0.5% tolerance." : "Redemptions are available in settled state with 0.5% quote tolerance."}</p>
      {(fault || walletError) && <p className="inline-error" role="alert">{fault || walletError}</p>}{notice && <p className="inline-success" role="status">{notice}</p>}
    </div>
    <div className="controls-card card" data-reveal><div className="card-topline"><span className="eyebrow">ACCOUNT & GOVERNANCE</span><span className="mono muted">02 / 02</span></div><div className="account-banner"><div><span className="micro-label">CONNECTED ACCOUNT</span><strong className="mono">{account ? shortAddress(account) : "NOT CONNECTED"}</strong></div><Chip label={manager ? "VAULT MANAGER" : account ? "PARTICIPANT" : "READ ONLY"} tone={manager ? "blue" : "neutral"} /></div>
      {account && <div className="control-rows mono"><div><span>SHARES HELD</span><strong>{formatAmount(shares, 12)} SHR</strong></div><div><span>VAULT OPERATOR</span><strong>{shortAddress(state?.operator)}</strong></div><div><span>SAFETY STATE</span><strong>{state ? (state.paused ? "PAUSED" : "RUNNING") : "--"}</strong></div></div>}
      <div className="control-actions"><p className="micro-label">SETTLEMENT</p><p className="muted">A share holder or manager can request settlement while trading. The keeper closes positions and returns the vault to its settled window.</p><button type="button" className="btn-outline" onClick={() => void transaction("Request settlement", target => walletClient(target).writeContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "requestSettlement" }))} disabled={!account || state?.state !== 1 || (!manager && shares === 0n) || !!pending}>Request settlement <IconArrow diagonal /></button></div>
      {manager && <div className="manager-actions"><p className="micro-label">MANAGER CONTROLS</p><button type="button" className="btn-outline" onClick={() => void transaction("Activate agent", target => walletClient(target).writeContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "activateAgent", args: [DEPLOYMENT.agentId, DEPLOYMENT.operator] }))} disabled={state?.state !== 0 || !snapshot?.qualified || state.activeAgentId === DEPLOYMENT.agentId.toString() || !!pending}>Activate {agentCallsign(DEPLOYMENT.agentId)} <IconArrow diagonal /></button><div className="manager-allocation"><label className="input-label mono" htmlFor="trade-allocation">AUSD ALLOCATION</label><div className="amount-field"><input id="trade-allocation" type="text" inputMode="decimal" placeholder="0.00" value={tradeAmount} onChange={event => setTradeAmount(event.target.value)} disabled={state?.state !== 0 || !!pending} /><span className="mono">AUSD</span></div></div><button type="button" className="btn-outline" onClick={() => void startTrading()} disabled={!canStartTrading || !tradeAmount || !!pending}>Start trading <IconArrow diagonal /></button>{state?.state === 0 && Number(state.settledUntil) > Date.now() / 1000 && <p className="form-disclaimer mono">TRADING WINDOW OPENS {formatDate(state.settledUntil)}</p>}<button type="button" className="btn-outline" onClick={() => void transaction(state?.paused ? "Resume vault" : "Pause vault", target => walletClient(target).writeContract({ address: DEPLOYMENT.vault, abi: vaultAbi, functionName: "setPaused", args: [!state?.paused] }))} disabled={!state || !!pending}>{state?.paused ? "Resume vault" : "Pause vault"} <IconArrow diagonal /></button></div>}
    </div></div>
  </section>;
}

function QualificationPanel({ account, snapshot, authenticate, readWallet, refresh }: {
  account: Address | null; snapshot: ReturnType<typeof useWallet>["snapshot"];
  authenticate: (account: Address) => Promise<string>; readWallet: () => Promise<void>; refresh: () => Promise<void>;
}) {
  const [runId, setRunId] = useState(() => sessionStorage.getItem("metropolis-run-id") ?? "");
  const [run, setRun] = useState<QualificationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const isOwner = !!account && snapshot?.identityOwner.toLowerCase() === account.toLowerCase();
  const isOperator = !!account && account.toLowerCase() === DEPLOYMENT.operator.toLowerCase();

  async function runTask(fn: (token: string) => Promise<QualificationRun>) {
    if (!account) return;
    setBusy(true); setError(null);
    try {
      const token = await authenticate(account);
      const result = await fn(token);
      setRun(result); setRunId(result.id); sessionStorage.setItem("metropolis-run-id", result.id);
      await Promise.all([readWallet(), refresh()]);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); setProgress(""); }
  }

  async function advanceReference() {
    if (!account || !runId) return;
    setBusy(true); setError(null);
    try {
      const token = await authenticate(account);
      let current = run ?? await backend.run(runId, token);
      for (let i = 0; i < 40 && current.observation.status === "active"; i++) {
        setProgress(`EXERCISING POLICY / STEP ${current.observation.step + 1}`);
        const action = current.observation.tick === 0 ? { kind: "target" as const, targetBps: 1000 } : { kind: "hold" as const };
        current = await backend.act(current.id, current.observation.step, action, token);
        setRun(current);
      }
      await Promise.all([readWallet(), refresh()]);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); setProgress(""); }
  }

  return <section className="section page-width qualification-section" id="qualification"><SectionHeader kicker="03 / AGENT QUALIFICATION" title="Qualify before trading." copy="The identity owner starts a policy exercise. The designated operator submits decisions. A passing result is published on-chain." />
    <div className="qualification-card card" data-reveal><div className="qualification-intro"><div><p className="micro-label">REGISTERED AGENT</p><h3>{agentCallsign(DEPLOYMENT.agentId)}<span className="blue-period">.</span></h3><p className="muted">A deterministic risk exercise checks drawdown, order sizing, and activity across three market scenarios.</p></div><div className="qualification-seal mono"><span>AGENT ID</span><strong>{DEPLOYMENT.agentId.toString()}</strong><small>ON-CHAIN IDENTITY</small></div></div>
    <div className="qualification-grid"><div className="qualification-step"><span className="step-number mono">01 / OWNER</span><h4>Start a run</h4><p>The identity owner connects and creates a 15-minute qualification run for the assigned operator.</p><button type="button" className="btn-outline" disabled={!isOwner || busy} onClick={() => void runTask(token => backend.startRun(DEPLOYMENT.operator, token))}>Start qualification <IconArrow diagonal /></button></div><div className="qualification-step"><span className="step-number mono">02 / OPERATOR</span><h4>Exercise policy</h4><p>The operator signs in and submits the reference risk policy. Progress is visible after each step.</p><div className="run-input"><label htmlFor="run-id" className="sr-only">Qualification run ID</label><input id="run-id" value={runId} onChange={event => setRunId(event.target.value)} placeholder="Paste run ID" /><button type="button" className="text-action" disabled={!account || busy || !runId} onClick={() => void runTask(token => backend.run(runId, token))}>LOAD</button></div><button type="button" className="btn-outline" disabled={!isOperator || busy || !runId || run?.observation.status === "passed"} onClick={() => void advanceReference()}>{progress || "Run reference policy"} <IconArrow diagonal /></button></div><div className="qualification-step"><span className="step-number mono">03 / REGISTRY</span><h4>Verify on-chain</h4><p>A passing exercise queues the result for publication. The vault checks that qualification before activation and trading.</p><div className="qual-result mono"><span>RUN STATUS</span><Chip label={run?.observation.status?.toUpperCase() ?? "NOT STARTED"} tone={run?.observation.status === "passed" ? "good" : "neutral"} /></div><div className="qual-result mono"><span>PUBLICATION</span><strong>{run?.publication?.status?.toUpperCase() ?? "--"}</strong></div></div></div>
    {run && <div className="qualification-footer mono"><span>RUN / {run.id}</span><span>SCENARIO / {run.observation.scenario ?? "COMPLETE"}</span><span>STEP / {run.observation.step}</span><span>DEADLINE / {new Date(run.deadline).toLocaleTimeString()}</span></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
  </section>;
}

function Footer() {
  return <footer className="site-footer"><div className="page-width"><div className="footer-main" data-reveal><div><Brand /><p>Agents place orders. The vault holds collateral.</p></div><a className="btn-square" href={`${explorer}/address/${DEPLOYMENT.vault}`} target="_blank" rel="noreferrer">View on Monadscan <IconArrow diagonal /></a></div><div className="footer-bottom mono"><span>METROPOLIS / MONAD TESTNET</span><span>TESTNET ASSETS HAVE NO CASH VALUE</span><a href="#top">BACK TO TOP ^</a></div></div></footer>;
}

export default function App() {
  useSiteMotion();
  const vault = useVaultData();
  const wallet = useWallet(vault.suite?.suiteHash);
  const currentAgent = vault.state?.activeAgentId;
  const qualification = useMemo(() => currentAgent && currentAgent !== "0" && BigInt(currentAgent) === DEPLOYMENT.agentId ? vault.qualification?.qualified ?? null : null, [currentAgent, vault.qualification]);
  return <>
    <div className="scroll-progress" aria-hidden="true" />
    <Header account={wallet.account} connect={wallet.connect} busy={wallet.busy} wallets={wallet.wallets} chooserOpen={wallet.chooserOpen} closeChooser={() => wallet.setChooserOpen(false)} selectWallet={wallet.selectWallet} walletError={wallet.error} />
    <main>
      <Hero state={vault.state} />
      <OperatingModel />
      <WalletPanel state={vault.state} account={wallet.account} snapshot={wallet.snapshot} walletBusy={wallet.busy} walletError={wallet.error} connect={wallet.connect} readWallet={() => wallet.read()} refresh={vault.refresh} />
      <QualificationPanel account={wallet.account} snapshot={wallet.snapshot} authenticate={wallet.authenticate} readWallet={() => wallet.read()} refresh={vault.refresh} />
      <section className="section page-width inspect-section" id="activity">
        <details className="inspect-details">
          <summary><span className="eyebrow">04 / ON-CHAIN INSPECTION</span><strong>Live vault state and transaction log</strong><span className="mono inspect-action">OPEN +</span></summary>
          <div className="inspect-body">
            <div className="overview-grid"><StatusBoard state={vault.state} qualified={qualification} qualificationExpiry={vault.qualification?.expiresAt ?? null} error={vault.error} refreshing={vault.refreshing} refresh={vault.refresh} /><ExposureBoard state={vault.state} /></div>
            <EventStream activity={vault.activity} indexedBlock={vault.keeper?.indexedThrough?.block_number} headBlock={vault.state?.blockNumber} />
          </div>
        </details>
      </section>
    </main>
    <Footer />
  </>;
}
