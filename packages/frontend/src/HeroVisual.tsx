export function HeroVisual() {
  return <svg className="hero-art" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="orb-halo" cx="67%" cy="43%" r="42%">
        <stop offset="0" stopColor="#52a8ff" stopOpacity=".23" />
        <stop offset=".52" stopColor="#52a8ff" stopOpacity=".065" />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="orb-core" cx="38%" cy="32%" r="70%">
        <stop offset="0" stopColor="#ededed" stopOpacity=".6" />
        <stop offset=".16" stopColor="#52a8ff" stopOpacity=".43" />
        <stop offset=".58" stopColor="#07101c" />
        <stop offset="1" stopColor="#000" />
      </radialGradient>
      <linearGradient id="orb-belt" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#52a8ff" stopOpacity=".08" />
        <stop offset=".52" stopColor="#52a8ff" stopOpacity=".9" />
        <stop offset="1" stopColor="#ededed" stopOpacity=".12" />
      </linearGradient>
      <filter id="orb-blur"><feGaussianBlur stdDeviation="35" /></filter>
      <pattern id="orb-grid" width="40" height="40" patternUnits="userSpaceOnUse">
        <path d="M40 0H0V40" stroke="#ededed" strokeOpacity=".07" />
      </pattern>
      <clipPath id="orb-sphere-clip"><circle r="242" /></clipPath>
    </defs>
    <rect width="1600" height="900" fill="#000" />
    <rect width="1600" height="900" fill="url(#orb-grid)" />
    <rect width="1600" height="900" fill="url(#orb-halo)" />
    <g transform="translate(1050 405)">
      <circle r="340" fill="#52a8ff" opacity=".11" filter="url(#orb-blur)" />
      <circle className="orb-guide" r="335" stroke="#ededed" strokeOpacity=".1" strokeDasharray="2 10" />
      <circle r="242" fill="url(#orb-core)" stroke="#ededed" strokeOpacity=".16" />
      <g clipPath="url(#orb-sphere-clip)">
        <g className="orb-surface">
          <ellipse rx="182" ry="248" stroke="#52a8ff" strokeOpacity=".24" />
          <ellipse rx="112" ry="248" stroke="#ededed" strokeOpacity=".13" />
          <ellipse rx="37" ry="248" stroke="#52a8ff" strokeOpacity=".18" />
          <path d="M-242-118Q0-45 242-118M-242 118Q0 45 242 118M-242 0H242" stroke="#ededed" strokeOpacity=".12" />
          <path d="M-242-170Q0-210 242-170M-242 170Q0 210 242 170" stroke="#52a8ff" strokeOpacity=".12" />
        </g>
      </g>
      <circle r="217" stroke="#ededed" strokeOpacity=".13" strokeDasharray="1 8" />
      <circle r="170" stroke="#52a8ff" strokeOpacity=".3" />
      <circle r="121" stroke="#ededed" strokeOpacity=".16" strokeDasharray="4 10" />
      <g className="orb-belt-assembly">
        <ellipse rx="360" ry="92" transform="rotate(-27)" stroke="url(#orb-belt)" strokeWidth="2" />
        <ellipse className="orb-belt-signal" rx="360" ry="92" transform="rotate(-27)" stroke="#52a8ff" strokeOpacity=".65" strokeWidth="2" strokeDasharray="3 28 100 600" />
        <circle cx="300" cy="-198" r="5" fill="#52a8ff" />
        <circle cx="300" cy="-198" r="13" stroke="#52a8ff" strokeOpacity=".32" />
      </g>
      <g className="orb-outer-ring"><ellipse rx="295" ry="310" transform="rotate(33)" stroke="#ededed" strokeOpacity=".16" strokeDasharray="4 8" /></g>
      <circle className="orb-center-glow" r="69" fill="#52a8ff" fillOpacity=".07" />
      <circle r="66" fill="#000" stroke="#52a8ff" strokeOpacity=".58" />
      <path d="M-34 0h68M0-34v68" stroke="#52a8ff" strokeOpacity=".8" />
      <circle r="18" fill="#52a8ff" opacity=".2" />
      <path d="M-340 0h-95M340 0h95M0-340v-65M0 340v65" stroke="#ededed" strokeOpacity=".25" />
      <g fill="#52a8ff"><circle cx="-315" cy="150" r="4" /><circle cx="119" cy="-227" r="3" /></g>
      <g fill="#999" fontFamily="monospace" fontSize="10" letterSpacing="2">
        <text x="-470" y="-18">SYS.01 / RISK GATE</text>
        <text x="320" y="-225">AGENT ONLINE</text>
        <text x="155" y="320">MONAD TESTNET // 10143</text>
      </g>
    </g>
    <g stroke="#ededed" strokeOpacity=".12"><path d="M0 745H1600M0 665H1600M80 0V900M1520 0V900" /></g>
    <g fill="#999" fontFamily="monospace" fontSize="11" letterSpacing="3"><text x="80" y="700">CAPITAL / POLICY / EXECUTION</text><text x="80" y="780">[ TRUST IS A STATE, NOT A PROMISE ]</text></g>
  </svg>;
}
