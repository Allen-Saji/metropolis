export function HeroVisual() {
  return <div className="hero-object" aria-hidden="true">
    <div className="permit-backplate" />
    <div className="permit-card">
      <div className="permit-top mono"><span>METROPOLIS</span><span>EXECUTION MANDATE</span></div>
      <div className="permit-body">
        <div className="permit-person mono"><span>ASSIGNED AGENT</span><strong>VOID<br />JACKAL</strong><span>PERPL / BTC + ETH</span></div>
        <svg className="permit-mark" viewBox="0 0 30 30" fill="none" focusable="false">
          <path d="M2 25V5h6l7 10L22 5h6v20h-5V12l-8 10L7 12v13H2Z" stroke="currentColor" strokeWidth="1.25" />
          <path d="M2 2h26M2 28h26" stroke="currentColor" strokeWidth=".9" />
        </svg>
      </div>
      <div className="permit-scope mono"><span>AUTHORIZED SCOPE</span><strong>SIGNED IOC ORDERS</strong><span className="permit-arrow">-&gt;</span></div>
      <div className="permit-restriction mono"><span>WITHDRAWAL / TRANSFER</span><strong>NO ACCESS</strong><span className="permit-cross">X</span></div>
      <div className="permit-bottom mono"><span>VAULT HOLDS CUSTODY</span><span className="permit-bars" /></div>
    </div>
    <div className="permit-caption mono"><span>TRADE RIGHTS</span><span className="permit-caption-line" /><span>NO CUSTODY RIGHTS</span></div>
  </div>;
}
