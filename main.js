const { Plugin, ItemView, PluginSettingTab, Setting, debounce } = require('obsidian');

const VIEW_TYPE = 'black-hole-graph-view';
const DEFAULTS = { mode: 0, autoRotate: true, showLinks: true, orbitSpeed: 1, particles: 1 };
const MODES = ['Gargantua', 'Quasar', 'Interstellar', 'Polarized', 'Maelstrom', 'Galaxy', 'Eclipse', 'Binary'];
const GOLDEN = 2.39996323;
const RH = 54; // event horizon radius in world units
const NB = 16; // radial colour buckets for disc particles (+1 for the dark gap)

// Per-mode look. Numeric fields in EASE_KEYS glide toward these targets every frame, the same lag-filter the
// camera already uses, so switching modes cross-fades instead of snapping. camPitch/coreHue/domeHue/singleJet
// are read straight off the current mode with no easing — a brief pop on switch, never on a held mode.
// tilt+camPitch together set how edge-on vs face-on the disc reads: tilt alone tips the (otherwise flat) disc
// away from horizontal, camPitch is how far above it the camera sits — small tilt + camPitch near π/2 looks
// straight down at a near-circular ring (Polarized, Maelstrom); small tilt + small camPitch is edge-on (Gargantua).
const EASE_KEYS = ['tilt', 'hole', 'jet', 'dome', 'crescent', 'mael', 'gal', 'discBlue', 'core', 'mono', 'debris', 'bg', 'twin', 'surface', 'wisp'];
const MODE_CFG = [
  { tilt: 0.05, hole: 1, jet: 0, dome: 0, crescent: 0, mael: 0, gal: 0, discBlue: 0, core: 0, mono: 0, debris: 0, bg: 0, twin: 0, surface: 0, wisp: 0, singleJet: false, coreHue: 0, domeHue: 32, bgHue: 0, camPitch: 0.16, zoom: 1 },
  { tilt: 0.45, hole: 0, jet: 1, dome: 0, crescent: 0, mael: 0, gal: 0, discBlue: 1, core: 1, mono: 0, debris: 0, bg: 0, twin: 0, surface: 0, wisp: 0, singleJet: false, coreHue: 215, domeHue: 0, bgHue: 0, camPitch: 0.85, zoom: 1 },
  { tilt: 0.14, hole: 1, jet: 0.65, dome: 1, crescent: 0, mael: 0, gal: 0, discBlue: 0.04, core: 0, mono: 0, debris: 0, bg: 0, twin: 0, surface: 0, wisp: 0, singleJet: true, coreHue: 0, domeHue: 30, bgHue: 0, camPitch: 0.22, zoom: 1 },
  { tilt: 0.16, hole: 1, jet: 0, dome: 0.5, crescent: 1, mael: 0, gal: 0, discBlue: 0.02, core: 0, mono: 0, debris: 0, bg: 0, twin: 0, surface: 0, wisp: 0, singleJet: false, coreHue: 0, domeHue: 26, bgHue: 0, camPitch: 1.46, zoom: 1 },
  { tilt: 0.22, hole: 1, jet: 0, dome: 0.3, crescent: 0, mael: 1, gal: 0, discBlue: 0.9, core: 0, mono: 0, debris: 0, bg: 0, twin: 0, surface: 0, wisp: 0, singleJet: false, coreHue: 0, domeHue: 255, bgHue: 0, camPitch: 1.3, zoom: 1 },
  { tilt: 0.12, hole: 0, jet: 0, dome: 0, crescent: 0, mael: 0, gal: 1, discBlue: 0.5, core: 0.6, mono: 0, debris: 0, bg: 0, twin: 0, surface: 0, wisp: 0, singleJet: false, coreHue: 42, domeHue: 0, bgHue: 0, camPitch: 1.05, zoom: 1 },
  { tilt: 0.07, hole: 1, jet: 0, dome: 1, crescent: 0, mael: 0, gal: 0, discBlue: 0.5, core: 0, mono: 1, debris: 1, bg: 0.6, twin: 0, surface: 1, wisp: 0, singleJet: false, coreHue: 0, domeHue: 200, bgHue: 210, camPitch: 0.2, zoom: 0.6 },
  { tilt: 0.25, hole: 1, jet: 0, dome: 0, crescent: 0, mael: 0, gal: 0, discBlue: 0.12, core: 0.6, mono: 0, debris: 0.4, bg: 0.75, twin: 1, surface: 0, wisp: 1, singleJet: false, coreHue: 38, domeHue: 0, bgHue: 280, camPitch: 0.55, zoom: 0.85 },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gargantua-style black hole: a glowing accretion disc seen at an angle, light-bent halo arcs and a black event horizon.
// P.proj(x, y, z) -> [screenX, screenY, depth] | null. Drawn in order: far half of the disc, the hole, near half of the disc.
// P.drawFar / P.drawNear are called after each half so the caller can put particles and stars behind or in front of the hole.
function drawBlackHole(ctx, P) {
  const { proj, cx, cy, cz, Rh, tilt, dim, focal, w, h } = P;
  const c0 = proj(cx, cy, cz);
  if (!c0) return;
  const [px, py, d0] = c0;
  const s = focal / d0, rhp = Rh * s;
  const reach = Rh * 6 * s;
  if (rhp < 2 || px < -reach || px > w + reach || py < -reach || py > h + reach) {
    if (P.drawFar) P.drawFar(d0);
    if (P.drawNear) P.drawNear(d0);
    return;
  }

  const N = 14, M = 56, Rin = Rh * 1.35, Rout = Rh * 4.4, Ro = Rout * s;
  const rings = [];
  for (let j = 0; j < N; j++) {
    const t = j / (N - 1), r = Rin + (Rout - Rin) * t;
    const far = new Path2D(), near = new Path2D();
    let prev = null, side = null;
    for (let i = 0; i <= M; i++) {
      const th = (i / M) * 6.2832, x = Math.cos(th) * r, z = Math.sin(th) * r;
      const y1 = -tilt.stx * z, z1 = tilt.ctx * z;
      const q = proj(cx + tilt.ctz * x - tilt.stz * y1, cy + tilt.stz * x + tilt.ctz * y1, cz + z1);
      if (prev && q) {
        const sd = (q[2] + prev[2]) / 2 > d0;
        const path = sd ? far : near;
        if (sd !== side) path.moveTo(prev[0], prev[1]);
        path.lineTo(q[0], q[1]);
        side = sd;
      } else side = null;
      prev = q;
    }
    rings.push({ t, far, near });
  }

  const strokeRings = (which) => {
    ctx.lineCap = 'butt';
    ctx.lineWidth = clamp(((Rout - Rin) / N) * s * 1.6, 0.8, 16);
    for (const ring of rings) {
      const t = ring.t, hue = 42 - 26 * t, light = 88 - 43 * Math.pow(t, 0.8), a = (0.8 - 0.52 * t) * dim;
      // one side of the disc is brighter, like relativistic beaming
      const g = ctx.createLinearGradient(px - Ro, 0, px + Ro, 0);
      g.addColorStop(0, `hsla(${hue}, 95%, ${light + 6}%, ${Math.min(1, a * 1.3)})`);
      g.addColorStop(0.5, `hsla(${hue}, 95%, ${light}%, ${a * 0.8})`);
      g.addColorStop(1, `hsla(${hue}, 90%, ${light - 8}%, ${a * 0.35})`);
      ctx.strokeStyle = g;
      ctx.stroke(ring[which]);
    }
  };

  // which way is "up" for the disc on screen, and how edge-on it is (1 = edge-on, 0 = face-on)
  const nx = -tilt.stz * tilt.ctx, ny = tilt.ctz * tilt.ctx, nz = tilt.stx;
  const q = proj(cx + nx * Rh * 3, cy + ny * Rh * 3, cz + nz * Rh * 3);
  let dx = q ? q[0] - px : 0, dy = q ? q[1] - py : -1;
  if (dy > 0) { dx = -dx; dy = -dy; }
  const E = clamp(Math.hypot(dx, dy) / (Rh * 3 * s), 0, 1);
  const aUp = Math.atan2(dy, dx);
  const span = Math.PI * (0.5 + 0.5 * (1 - E));

  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.18 * dim;
  ctx.drawImage(P.sprite(26, 58), px - Ro * 1.7, py - Ro * 1.7, Ro * 3.4, Ro * 3.4);

  // lensed image of the far side of the disc, bent over the top and (fainter) under the bottom
  ctx.globalAlpha = 1;
  ctx.lineCap = 'round';
  for (let k = 0; k < 10; k++) {
    const rr = rhp * (1.08 + k * 0.11), f = 1 - k / 10;
    ctx.strokeStyle = `hsla(${40 - k * 2}, 95%, ${85 - k * 3}%, ${0.55 * Math.pow(f, 1.2) * dim})`;
    ctx.lineWidth = clamp(rhp * 0.09, 1, 6);
    ctx.beginPath();
    ctx.arc(px, py, rr, aUp - span * (1 - k * 0.04), aUp + span * (1 - k * 0.04));
    ctx.stroke();
  }
  if (E > 0.25) {
    for (let k = 0; k < 6; k++) {
      const rr = rhp * (1.05 + k * 0.09), sb = Math.PI * 0.42 * E * (1 - k * 0.08);
      ctx.strokeStyle = `hsla(${34 - k * 2}, 90%, ${75 - k * 3}%, ${0.3 * (1 - k / 6) * dim})`;
      ctx.lineWidth = clamp(rhp * 0.06, 1, 4);
      ctx.beginPath();
      ctx.arc(px, py, rr, aUp + Math.PI - sb, aUp + Math.PI + sb);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  strokeRings('far');
  if (P.drawFar) { ctx.globalAlpha = 1; P.drawFar(d0); ctx.globalCompositeOperation = 'lighter'; }

  // event horizon
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = P.holeAlpha == null ? 1 : P.holeAlpha;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(px, py, rhp, 0, 6.2832);
  ctx.fill();

  // a soft dome-lit crescent, so the sphere reads as a lit ball rather than a flat silhouette. aUp is where the
  // halo bends over the FAR side of the disc, so the bright NEAR disc passes in front along the opposite side —
  // that is where the light comes from, and the crescent is placed there so it stays correct at any camera angle.
  if (P.domeAmt > 0.02) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, rhp, 0, 6.2832);
    ctx.clip();
    const lightA = aUp + Math.PI;
    const gx = px + Math.cos(lightA) * rhp * 0.62, gy = py + Math.sin(lightA) * rhp * 0.62;
    const dg = ctx.createRadialGradient(gx, gy, 0, gx, gy, rhp * 1.15);
    dg.addColorStop(0, `hsla(${P.domeHue}, 90%, 48%, ${0.6 * P.domeAmt * dim})`);
    dg.addColorStop(0.5, `hsla(${P.domeHue}, 85%, 22%, ${0.32 * P.domeAmt * dim})`);
    dg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = dg;
    ctx.fillRect(px - rhp, py - rhp, rhp * 2, rhp * 2);
    ctx.restore();
  }

  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 1;
  ctx.strokeStyle = `rgba(255, 225, 180, ${0.85 * dim})`;
  ctx.lineWidth = Math.max(1, rhp * 0.05);
  ctx.beginPath();
  ctx.arc(px, py, rhp * 1.02, 0, 6.2832);
  ctx.stroke();

  strokeRings('near');
  if (P.drawNear) { ctx.globalAlpha = 1; P.drawNear(d0); }
  ctx.globalAlpha = 1;
}

class BlackHoleView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.nodes = [];
    this.bodies = [];
    this.edges = [];
    this.systems = [];
    this.focus = null;
    this.hover = null;
    this.time = 0;
    this.mode = plugin.settings.mode;
    this.p = { ...MODE_CFG[this.mode] };
    this.cam = { yaw: 0.3, pitch: MODE_CFG[this.mode].camPitch, dist: 1800, tx: 0, ty: 0, tz: 0 };
    this.goal = { ...this.cam };
    this.sprites = new Map();
    this.pointers = new Map();
    this.pt3 = [0, 0, 0];
    this.stars = [];
    for (let i = 0; i < 520; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      this.stars.push({ x: r * Math.cos(a), y: u, z: r * Math.sin(a), b: 0.25 + Math.random() * 0.75, p: Math.random() * 6.28 });
    }
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Black hole graph'; }
  getIcon() { return 'aperture'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('black-hole-root');
    root.style.padding = '0';

    this.canvas = root.createEl('canvas');
    this.ctx = this.canvas.getContext('2d');

    const bar = root.createDiv({ cls: 'black-hole-toolbar' });
    this.modeBtns = MODES.map((label, i) => {
      const b = bar.createEl('button', { text: label });
      b.toggleClass('is-on', i === this.mode);
      b.onclick = () => this.setMode(i);
      return b;
    });
    bar.createDiv({ cls: 'black-hole-sep' });
    const mk = (label, fn, on) => {
      const b = bar.createEl('button', { text: label });
      if (on) b.addClass('is-on');
      b.onclick = () => fn(b);
      return b;
    };
    mk('Rotate', (b) => {
      this.plugin.settings.autoRotate = !this.plugin.settings.autoRotate;
      b.toggleClass('is-on', this.plugin.settings.autoRotate);
      this.plugin.saveSettings();
    }, this.plugin.settings.autoRotate);
    mk('Links', (b) => {
      this.plugin.settings.showLinks = !this.plugin.settings.showLinks;
      b.toggleClass('is-on', this.plugin.settings.showLinks);
      this.plugin.saveSettings();
    }, this.plugin.settings.showLinks);
    mk('Overview', () => { this.setFocus(null); this.resetCamera(); });

    this.legend = root.createDiv({ cls: 'black-hole-legend' });
    this.statsEl = root.createDiv({ cls: 'black-hole-stats' });

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(root);
    this.bindPointer();

    this.registerEvent(this.app.metadataCache.on('resolved', this.plugin.rebuildAll));
    this.registerEvent(this.app.vault.on('create', this.plugin.rebuildAll));
    this.registerEvent(this.app.vault.on('delete', this.plugin.rebuildAll));
    this.registerEvent(this.app.vault.on('rename', this.plugin.rebuildAll));

    this.resize();
    this.build();
    this.resetCamera(true);
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  async onClose() {
    cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.resizeObs) this.resizeObs.disconnect();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.contentEl.clientWidth, h = this.contentEl.clientHeight;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.floor(w * dpr));
    this.canvas.height = Math.max(1, Math.floor(h * dpr));
    this.focal = Math.min(w, h) * 1.05;
  }

  // ---------- data ----------

  build() {
    const app = this.app;
    const files = app.vault.getMarkdownFiles();
    const resolved = app.metadataCache.resolvedLinks;
    const nodes = [];
    const byPath = new Map();
    const sysMap = new Map();

    for (const f of files) {
      const parts = f.path.split('/');
      const sys = parts.length > 1 ? parts[0] : '(vault)';
      const ring = parts.length > 2 ? parts[1] : '';
      const n = { file: f, name: f.basename, sys, ring, deg: 0, nb: [], sx: 0, sy: 0, sd: -1 };
      nodes.push(n);
      byPath.set(f.path, n);
      if (!sysMap.has(sys)) sysMap.set(sys, { key: sys, nodes: [] });
      sysMap.get(sys).nodes.push(n);
    }

    const edges = [];
    const seen = new Set();
    for (const src in resolved) {
      const a = byPath.get(src);
      if (!a) continue;
      for (const dst in resolved[src]) {
        const b = byPath.get(dst);
        if (!b || a === b) continue;
        const key = src < dst ? src + '\n' + dst : dst + '\n' + src;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([a, b]);
        a.deg++; b.deg++;
        a.nb.push(b); b.nb.push(a);
      }
    }

    // every top-level folder is an orbital band around the black hole, every subfolder a track inside it
    const systems = [...sysMap.values()].sort((a, b) => b.nodes.length - a.nodes.length);
    let cursor = RH * 1.9;
    systems.forEach((s, i) => {
      s.index = i;
      s.hue = (i * 137.5 + 30) % 360;
      s.dim = 1;
      s.r0 = cursor;
      const groups = new Map();
      for (const n of s.nodes) {
        if (!groups.has(n.ring)) groups.set(n.ring, []);
        groups.get(n.ring).push(n);
      }
      const keys = [...groups.keys()].sort();
      for (const k of keys) {
        const list = groups.get(k).sort((a, b) => b.deg - a.deg || a.name.localeCompare(b.name));
        const cnt = list.length;
        const width = 12 + 5 * Math.sqrt(cnt);
        const r = rng(s.key + k);
        const phase = r() * 6.2832;
        list.forEach((n, ki) => {
          n.r = cursor + width * Math.sqrt((ki + 0.5) / cnt);
          n.th0 = phase + ki * GOLDEN;
          n.om = 120 / Math.pow(n.r, 1.5);
          n.y = (r() - 0.5) * n.r * 0.03;
          n.size = 1.5 + Math.sqrt(n.deg) * 0.6;
          n.system = s;
          n.idx = i;
        });
        cursor += width + 6;
      }
      s.r1 = cursor;
      s.label = { th: rng(s.key + 'label')() * 6.2832, r: (s.r0 + s.r1) / 2 };
      cursor += 14;
    });
    this.discOuter = cursor;

    // a few extra bright stars scattered along the outer tracks
    const gr = rng('gems');
    const gems = [];
    for (let i = 0; i < 170; i++) {
      const r = RH * 2.2 + gr() * (cursor - RH * 2.2) * (0.5 + 0.5 * gr());
      gems.push({ file: null, r, th0: gr() * 6.2832, om: 120 / Math.pow(r, 1.5), y: (gr() - 0.5) * r * 0.03, size: 1.6 + gr() * 2.4, idx: i, sd: -1, sx: 0, sy: 0, system: { dim: 1 } });
    }

    // dark asteroid chunks scattered through the disc, for Eclipse and Binary. They ride the same orbits as the
    // gems above (same far/near depth handling, for free) but render as dark rock silhouettes instead of stars.
    const dr = rng('debris');
    const debrisArr = [];
    for (let i = 0; i < 240; i++) {
      const r = RH * 1.6 + dr() * (cursor - RH * 1.6);
      debrisArr.push({ file: null, debris: true, r, th0: dr() * 6.2832, om: 120 / Math.pow(r, 1.5), y: (dr() - 0.5) * r * 0.05, size: 1 + dr() * 3, tone: dr(), squash: 0.6 + dr() * 0.6, sd: -1, sx: 0, sy: 0, system: { dim: 1 } });
    }

    // disc particles laid out on thin concentric rings, so the disc looks like tree rings when tilted
    const N = Math.round(9000 * this.plugin.settings.particles);
    const Rin = RH * 1.4, Rout = cursor * 1.08, gr2 = rng('disc');
    const tmp = [];
    for (let i = 0; i < N; i++) {
      const t = Math.pow(gr2(), 1.7);
      let r = Rin + t * (Rout - Rin);
      r = Rin + Math.round((r - Rin) / 3.4) * 3.4 + (gr2() - 0.5) * 0.5;
      const tt = (r - Rin) / (Rout - Rin);
      const b = tt > 0.5 && tt < 0.58 ? NB : Math.min(NB - 1, Math.floor(tt * NB));
      tmp.push({ r, th: gr2() * 6.2832, y: (gr2() - 0.5) * r * 0.012, b });
    }
    tmp.sort((a, b) => a.b - b.b);
    this.pn = N;
    this.pR = new Float32Array(N); this.pT = new Float32Array(N); this.pY = new Float32Array(N); this.pO = new Float32Array(N);
    this.psx = new Float32Array(N); this.psy = new Float32Array(N); this.psd = new Float32Array(N); this.pTh = new Float32Array(N);
    this.bstart = new Array(NB + 2).fill(N);
    tmp.forEach((p, i) => {
      this.pR[i] = p.r; this.pT[i] = p.th; this.pY[i] = p.y; this.pO[i] = 120 / Math.pow(p.r, 1.5);
      if (this.bstart[p.b] === N && (i === 0 || tmp[i - 1].b !== p.b)) this.bstart[p.b] = i;
    });
    // fill gaps for empty buckets so ranges stay valid
    this.bstart[NB + 1] = N;
    for (let b = NB; b >= 0; b--) if (this.bstart[b] > this.bstart[b + 1]) this.bstart[b] = this.bstart[b + 1];
    this.discRin = Rin; this.discRout = Rout;

    this.nodes = nodes;
    this.gems = gems;
    this.debrisArr = debrisArr;
    this.bodies = nodes.concat(gems).concat(debrisArr);
    this.edges = edges;
    this.systems = systems;
    if (this.focus && !systems.find((s) => s.key === this.focus)) this.focus = null;
    this.buildLegend();
    this.statsEl.setText(`${nodes.length} notes · ${edges.length} links · ${systems.length} orbits`);
  }

  buildLegend() {
    this.legend.empty();
    this.chips = [];
    for (const s of this.systems) {
      const chip = this.legend.createEl('button', { cls: 'black-hole-chip' });
      const dot = chip.createSpan({ cls: 'black-hole-dot' });
      dot.style.background = `hsl(${s.hue}, 80%, 72%)`;
      dot.style.boxShadow = `0 0 8px hsl(${s.hue}, 90%, 65%)`;
      chip.createSpan({ text: s.key === '(vault)' ? 'Vault' : s.key });
      chip.onclick = () => this.setFocus(this.focus === s.key ? null : s.key);
      chip.toggleClass('is-active', this.focus === s.key);
      this.chips.push({ chip, key: s.key });
    }
  }

  // ---------- camera ----------

  fitDist() { return Math.max(1300, this.discOuter * 2.5) * MODE_CFG[this.mode].zoom; }

  resetCamera(instant) {
    this.goal.tx = 0; this.goal.ty = 0; this.goal.tz = 0;
    this.goal.dist = this.fitDist() * (this.focus ? 0.75 : 1);
    this.goal.pitch = MODE_CFG[this.mode].camPitch;
    if (instant) Object.assign(this.cam, this.goal);
  }

  setMode(i) {
    this.mode = i;
    this.plugin.settings.mode = i;
    this.plugin.saveSettings();
    this.modeBtns.forEach((b, j) => b.toggleClass('is-on', j === i));
    this.resetCamera();
  }

  setFocus(key) {
    this.focus = key;
    if (this.chips) for (const c of this.chips) c.chip.toggleClass('is-active', c.key === key);
    this.goal.dist = this.fitDist() * (key ? 0.75 : 1);
  }

  // camera-only projection of a world point; writes [sx, sy, depth] into o and returns false when unusable
  cam3(x, y, z, o) {
    const c = this.cam, cc = this.cc;
    x -= c.tx; y -= c.ty; z -= c.tz;
    const x1 = cc.cy * x + cc.sy * z, z1 = -cc.sy * x + cc.cy * z;
    const y2 = cc.cp * y - cc.sp * z1, z2 = cc.sp * y + cc.cp * z1;
    const cz = z2 + c.dist;
    if (cz < 30) return false;
    const s = this.focal / cz;
    o[0] = this.w / 2 + x1 * s; o[1] = this.h / 2 + y2 * s; o[2] = cz;
    return true;
  }

  // disc-plane point (x, y, z) -> tilt the whole disc -> camera
  disc3(x, y, z, o) {
    return this.cam3(this.tc * x - this.ts * y, this.ts * x + this.tc * y, z, o);
  }

  setCamTrig() {
    const c = this.cam;
    this.cc = { cy: Math.cos(c.yaw), sy: Math.sin(c.yaw), cp: Math.cos(c.pitch), sp: Math.sin(c.pitch) };
  }

  // ---------- input ----------

  bindPointer() {
    const cv = this.canvas;
    let downAt = null, moved = 0, pinch = 0;

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      downAt = { pan: e.button === 2 || e.shiftKey || e.ctrlKey };
      moved = 0;
      this.dragging = true;
      cv.addClass('is-dragging');
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });

    cv.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) { this.updateHover(e); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this.goal.dist = clamp(this.goal.dist * (pinch / d), 150, 9000);
        pinch = d;
        return;
      }
      if (downAt && downAt.pan) this.pan(dx, dy);
      else {
        this.cam.yaw += dx * 0.005; this.goal.yaw = this.cam.yaw;
        this.cam.pitch = clamp(this.cam.pitch + dy * 0.005, -1.5, 1.5); this.goal.pitch = this.cam.pitch;
      }
    });

    const up = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) {
        this.dragging = false;
        cv.removeClass('is-dragging');
        if (moved < 5 && downAt) this.onClick(e);
        downAt = null; pinch = 0;
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (!this.dragging) this.hover = null; });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.goal.dist = clamp(this.goal.dist * Math.exp(e.deltaY * 0.0012), 150, 9000);
    }, { passive: false });
    cv.addEventListener('dblclick', () => { if (!this.hover) { this.setFocus(null); this.resetCamera(); } });
  }

  pan(dx, dy) {
    const c = this.cam, k = c.dist / this.focal;
    const vx = -dx * k, vy = -dy * k;
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    const y1 = cp * vy, z1 = -sp * vy;
    const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
    const wx = cy * vx - sy * z1, wz = sy * vx + cy * z1;
    for (const o of [this.cam, this.goal]) { o.tx += wx; o.ty += y1; o.tz += wz; }
  }

  updateHover(e) {
    const r = this.canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = 1e9;
    for (const n of this.nodes) {
      if (n.sd < 0 || n.system.dim < 0.5) continue;
      const d = Math.hypot(n.sx - mx, n.sy - my);
      if (d < 12 && d < bd) { bd = d; best = n; }
    }
    this.hover = best;
    this.canvas.toggleClass('is-hovering', !!best);
  }

  onClick(e) {
    this.updateHover(e);
    if (this.hover) this.plugin.openNote(this.hover.file, e.ctrlKey || e.metaKey);
  }

  // ---------- rendering ----------

  sprite(hue, light) {
    const key = Math.round(hue / 6) + '|' + Math.round(light / 6);
    let c = this.sprites.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `hsla(${hue}, 60%, 98%, 1)`);
    grad.addColorStop(0.12, `hsla(${hue}, 85%, ${light}%, 0.95)`);
    grad.addColorStop(0.4, `hsla(${hue}, 90%, ${light - 12}%, 0.28)`);
    grad.addColorStop(1, `hsla(${hue}, 90%, 50%, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.sprites.set(key, c);
    return c;
  }

  frame(now) {
    if (!this.raf) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.w || !this.contentEl.isShown()) return;
    this.time += dt * this.plugin.settings.orbitSpeed;
    this.update(dt);
    this.draw();
  }

  update(dt) {
    const c = this.cam, g = this.goal, k = 1 - Math.pow(0.001, dt);
    if (this.plugin.settings.autoRotate && !this.dragging) { c.yaw += dt * 0.03; g.yaw = c.yaw; }
    for (const key of ['yaw', 'pitch', 'dist', 'tx', 'ty', 'tz']) c[key] += (g[key] - c[key]) * k;
    const target = MODE_CFG[this.mode];
    for (const key of EASE_KEYS) this.p[key] += (target[key] - this.p[key]) * k;
    this.setCamTrig();

    // every mode tilts the whole disc by its own amount, so switching modes eases the tilt too
    const tz = this.p.tilt;
    this.tc = Math.cos(tz); this.ts = Math.sin(tz);
    this.tz = tz;

    for (const s of this.systems) {
      const target = !this.focus || this.focus === s.key ? 1 : 0.14;
      s.dim += (target - s.dim) * k;
    }

    const o = this.pt3, t = this.time, W = this.w, H = this.h;
    const zc = this.cam3(0, 0, 0, o) ? o[2] : 1e9;
    this.d0 = zc;

    const { pR, pT, pY, pO, psx, psy, psd, pTh } = this;
    for (let i = 0; i < this.pn; i++) {
      const th = pT[i] + pO[i] * t;
      pTh[i] = th;
      if (this.disc3(Math.cos(th) * pR[i], pY[i], Math.sin(th) * pR[i], o) && o[0] > -10 && o[0] < W + 10 && o[1] > -10 && o[1] < H + 10) {
        psx[i] = o[0]; psy[i] = o[1]; psd[i] = o[2];
      } else psd[i] = -1;
    }

    for (const n of this.bodies) {
      const th = n.th0 + n.om * t;
      if (this.disc3(Math.cos(th) * n.r, n.y, Math.sin(th) * n.r, o) && o[0] > -30 && o[0] < W + 30 && o[1] > -30 && o[1] < H + 30) {
        n.sx = o[0]; n.sy = o[1]; n.sd = o[2];
      } else n.sd = -1;
    }
  }

  // Disc particles and stars. far === true: only what is behind the hole; false: only what is in front; null: everything.
  // Colour blends continuously between the warm Gargantua palette and the cool Quasar/Maelstrom one via discBlue, so
  // switching modes cross-fades the disc instead of snapping. Three shape effects, all driven by the particle's own
  // radius/angle so they need no extra data: Galaxy bends the rings into four arms with dust lanes; Maelstrom bends
  // them into a tighter two-armed whirlpool; Polarized biases brightness by angle into one bright crescent, the way
  // relativistic beaming does in the real EHT photo of M87, instead of the ring glowing evenly all the way round.
  drawBodies(far) {
    const { ctx } = this, d0 = this.d0, bl = this.p.discBlue, gal = this.p.gal, mael = this.p.mael, cres = this.p.crescent, mono = this.p.mono;
    const psz = clamp((2.1 * this.focal) / d0, 1, 2.4) * (1 + cres * 0.4);
    const { psx, psy, psd, pR, pTh } = this;
    const crescentA = 2.4; // fixed angle in the disc's own frame, so the bright side turns with the disc, not the camera

    for (let b = 0; b <= NB; b++) {
      const a0 = this.bstart[b], a1 = this.bstart[b + 1];
      if (a0 >= a1) continue;
      const t = b === NB ? 0.54 : (b + 0.5) / NB;
      const hueW = 44 - 30 * t, lightW = 90 - 44 * Math.pow(t, 0.8), alphaW = 0.6 - 0.32 * t;
      const hueB = 226 + 20 * t, lightB = 96 - 36 * t, alphaB = (0.62 - 0.26 * t) * (b === NB ? 0.12 : 1);
      const hue0 = hueW + (hueB - hueW) * bl, light = lightW + (lightB - lightW) * bl, alpha0 = alphaW + (alphaB - alphaW) * bl;
      // gold near the centre, blue-white further out, like a real spiral galaxy's core and arms
      const hueG = t < 0.15 ? 40 : 208 + t * 34, lightG = t < 0.15 ? 92 : 58 + t * 22;
      const hue1 = hue0 + (hueG - hue0) * gal, lg1 = light + (lightG - light) * gal;
      // Eclipse: desaturate and pale toward a steel-blue monochrome, like the silvery reference picture
      const hue = hue1 + (206 - hue1) * mono, lg = lg1 + (80 - lg1) * mono, sat = 95 - 55 * mono;
      ctx.fillStyle = `hsl(${hue}, ${sat}%, ${lg}%)`;
      for (let i = a0; i < a1; i++) {
        const d = psd[i];
        if (d < 0) continue;
        if (far !== null && (d > d0) !== far) continue;
        let alpha = alpha0;
        if (gal > 0.02) {
          const arm = 0.5 + 0.5 * Math.cos(4 * (pTh[i] - Math.log(pR[i] + 8) * 2.2));
          const dust = 0.5 + 0.5 * Math.cos(4 * (pTh[i] - Math.log(pR[i] + 8) * 2.2) - 1.15);
          alpha *= (1 + (Math.pow(arm, 1.6) * 1.6 - 1) * gal) * (1 - 0.4 * gal * Math.pow(dust, 4));
        }
        if (mael > 0.02) {
          const arm = 0.5 + 0.5 * Math.cos(2 * (pTh[i] - Math.log(pR[i] + 10) * 3.4));
          alpha *= 1 + (Math.pow(arm, 1.3) * 1.7 - 1) * mael;
        }
        if (cres > 0.02) alpha *= 1 - cres * (1 - Math.pow(0.5 + 0.5 * Math.cos(pTh[i] - crescentA), 1.5));
        ctx.globalAlpha = alpha;
        ctx.fillRect(psx[i], psy[i], psz, psz);
      }
    }

    // notes and extra stars: always fully visible, regardless of arm gaps, so your vault stays easy to read
    const debrisAmt = this.p.debris;
    const hv = this.hover, hi = hv ? new Set([hv, ...hv.nb]) : null;
    for (const n of this.bodies) {
      if (n.sd < 0) continue;
      if (far !== null && (n.sd > d0) !== far) continue;
      const s = this.focal / n.sd;
      if (n.debris) {
        if (debrisAmt < 0.02) continue;
        // small dark irregular rock, not a glowing sprite: a squashed dark fill with a thin lit edge on one side
        const rr = clamp(n.size * s * 2.2, 0.8, 16);
        ctx.globalAlpha = debrisAmt * n.system.dim * 0.9;
        ctx.fillStyle = `hsl(${28 + n.tone * 20}, ${18 + n.tone * 10}%, ${8 + n.tone * 10}%)`;
        ctx.beginPath();
        ctx.ellipse(n.sx, n.sy, rr, rr * n.squash, n.tone * 6.28, 0, 6.2832);
        ctx.fill();
        ctx.globalAlpha = debrisAmt * n.system.dim * 0.5;
        ctx.strokeStyle = 'rgba(220,225,235,0.6)';
        ctx.lineWidth = Math.max(0.5, rr * 0.16);
        ctx.beginPath();
        ctx.arc(n.sx - rr * 0.3, n.sy - rr * 0.3, rr * 0.7, 0, 6.2832);
        ctx.stroke();
        continue;
      }
      const gem = !n.file;
      const boosted = hi && hi.has(n);
      const hueWn = 36 + ((n.idx % 7) - 3) * 5, hueBn = 228 + ((n.idx % 7) - 3) * 8, hue = hueWn + (hueBn - hueWn) * bl;
      let r = clamp(n.size * s * (gem ? 3.2 : 2.6), 2, 46);
      if (boosted) r *= 1.7;
      ctx.globalAlpha = (gem ? 0.75 : 0.9) * n.system.dim * (hi && !boosted ? 0.55 : 1);
      ctx.drawImage(this.sprite(hue, gem ? 84 + bl * 8 : 84), n.sx - r, n.sy - r, r * 2, r * 2);
      ctx.globalAlpha = n.system.dim;
      ctx.fillStyle = '#fff';
      const cs = clamp(n.size * s * 0.7, 1.2, 4) * (boosted ? 1.5 : 1);
      ctx.fillRect(n.sx - cs / 2, n.sy - cs / 2, cs, cs);
    }
    ctx.globalAlpha = 1;
  }

  // Jets and a glowing core, shared by Quasar (two straight jets, blue-white core), Interstellar (one wispy jet,
  // no core) and Galaxy (no jets, a soft gold-white core). Amounts and colour come from the eased mode params.
  drawJetsCore() {
    const { ctx } = this, jet = this.p.jet, core = this.p.core, cfg = MODE_CFG[this.mode], o = this.pt3;
    if (jet < 0.02 && core < 0.02) return;
    if (!this.cam3(0, 0, 0, o)) return;
    const px = o[0], py = o[1], s = this.focal / o[2];
    ctx.globalCompositeOperation = 'lighter';

    if (jet > 0.02) {
      // faint concentric rings around the base, and a soft haze over the whole disc
      const rings = new Path2D();
      const r0 = this.discRin * 1.15, r1 = this.discRout, steps = 44;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        if (t > 0.5 && t < 0.58) continue;
        const r = r0 + (r1 - r0) * t;
        let first = true;
        for (let i = 0; i <= 72; i++) {
          const th = (i / 72) * 6.2832;
          if (!this.disc3(Math.cos(th) * r, 0, Math.sin(th) * r, o)) { first = true; continue; }
          if (first) { rings.moveTo(o[0], o[1]); first = false; } else rings.lineTo(o[0], o[1]);
        }
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = `hsla(232, 75%, 78%, ${0.13 * jet})`;
      ctx.stroke(rings);
      const rh = this.discOuter * s * 1.1;
      ctx.globalAlpha = 0.09 * jet;
      ctx.drawImage(this.sprite(232, 55), px - rh, py - rh, rh * 2, rh * 2);

      // jets, along the disc's normal; the base is a cone that narrows into a hair-thin beam.
      // Interstellar braids three thin wispy strands that drift apart and fray into a soft cloud at the tip,
      // instead of one laser-straight beam, closer to the frayed brush-stroke jet in the reference pictures.
      const nx = -this.ts, ny = this.tc, L = this.discOuter * 2.8;
      const strands = cfg.singleJet ? [-0.6, 0, 0.7] : [0];
      const dirs = cfg.singleJet ? [1] : [1, -1];
      for (const dir of dirs) {
        for (const strandPh of strands) {
          const pts = [];
          for (let i = 0; i < 22; i++) {
            const u = i / 21, tt = L * Math.pow(u, 1.5) * dir;
            const wob = cfg.singleJet ? Math.sin(u * 4.5 + this.time * 0.55 + strandPh * 3) * L * (0.045 + 0.03 * strandPh) * u : 0;
            if (!this.cam3(nx * tt + this.ts * wob, ny * tt, this.tc * wob, o)) break;
            pts.push([o[0], o[1]]);
          }
          if (pts.length < 3) continue;
          const end = pts[pts.length - 1];
          const path = new Path2D();
          path.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
          const cool = !cfg.singleJet, strandJet = jet * (cfg.singleJet ? 0.7 : 1);
          const grad = (a) => {
            const g = ctx.createLinearGradient(px, py, end[0], end[1]);
            g.addColorStop(0, `rgba(235, 240, 255, ${a})`);
            g.addColorStop(0.35, cool ? `rgba(170, 190, 255, ${a * 0.55})` : `rgba(200, 220, 255, ${a * 0.5})`);
            g.addColorStop(1, cool ? 'rgba(120, 140, 255, 0)' : 'rgba(160, 190, 255, 0)');
            return g;
          };
          ctx.globalAlpha = 1;
          ctx.lineCap = 'round';
          ctx.lineWidth = clamp(RH * s * (cfg.singleJet ? 0.1 : 0.28), 1, 12);
          ctx.strokeStyle = grad(0.1 * strandJet);
          ctx.stroke(path);
          ctx.lineWidth = clamp(RH * s * (cfg.singleJet ? 0.032 : 0.06), 0.6, 2.4);
          ctx.strokeStyle = grad(0.95 * strandJet);
          ctx.stroke(path);
          for (let i = 1; i < 8; i++) {
            const q = pts[Math.min(pts.length - 1, i)];
            const r = RH * s * (2.6 * (1 - i / 8) + 0.5) * (cfg.singleJet ? 0.6 : 1);
            ctx.globalAlpha = 0.16 * strandJet;
            ctx.drawImage(this.sprite(225, 88), q[0] - r, q[1] - r, r * 2, r * 2);
          }
          if (cfg.singleJet && end) {
            const r = RH * s * 2.4;
            ctx.globalAlpha = 0.22 * strandJet;
            ctx.drawImage(this.sprite(220, 85), end[0] - r, end[1] - r, r * 2, r * 2);
          }
        }
      }
    }

    if (core > 0.02) {
      const hh = cfg.coreHue, layers = [[RH * 9 * s, 0.18, hh, 70], [RH * 3.8 * s, 0.5, hh + 4, 88], [RH * 1.5 * s, 1, hh + 9, 97]];
      // Galaxy's core is an elongated bulge, not a round point; squash it along the disc's projected axis
      const galAmt = this.p.gal, galSquash = clamp(Math.cos(this.cam.pitch), 0.2, 1), stretch = 1 + (1 / galSquash - 1) * galAmt;
      if (galAmt > 0.05) { ctx.save(); ctx.translate(px, py); ctx.rotate(Math.atan2(this.ts, this.tc)); ctx.scale(stretch, 1); ctx.translate(-px, -py); }
      for (const [r, a, h, l] of layers) {
        ctx.globalAlpha = a * core;
        ctx.drawImage(this.sprite(h, l), px - r, py - r, r * 2, r * 2);
      }
      if (galAmt > 0.05) ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // Polarized mode: the EHT-photo look is soft and blurred, not made of crisp little squares like the other modes'
  // discs. This layers big, very soft glow sprites over the ring — the crescent bias already lives in drawBodies —
  // so the whole thing reads as an out-of-focus glowing torus instead of a sharp mechanical disc.
  drawGlow() {
    const { ctx } = this, amt = this.p.crescent, o = this.pt3;
    if (amt < 0.02) return;
    if (!this.cam3(0, 0, 0, o)) return;
    const s0 = this.focal / o[2];
    ctx.globalCompositeOperation = 'lighter';
    const layers = [[this.discOuter * 1.15, 0.16], [this.discOuter * 0.7, 0.16], [this.discOuter * 0.42, 0.14]];
    for (const [r, a] of layers) {
      const rr = r * s0;
      ctx.globalAlpha = a * amt;
      ctx.drawImage(this.sprite(32, 60), o[0] - rr, o[1] - rr, rr * 2, rr * 2);
    }
    ctx.globalAlpha = 1;
  }

  // Maelstrom mode: a broad field of colourful star-dust with a few comet streaks, spread well past the disc itself
  // so it reads as a wide nebula the disc is embedded in, not a ring with sparkles stuck to it.
  drawMaelstrom() {
    const { ctx } = this, amt = this.p.mael, o = this.pt3;
    if (amt < 0.02) return;
    ctx.globalCompositeOperation = 'lighter';
    const r = rng('maelstrom-fixed');
    const hues = [255, 205, 285, 190, 320];
    for (let i = 0; i < 240; i++) {
      const u = Math.pow(r(), 0.5), rad = this.discRin * 1.2 + u * this.discOuter * 2.1;
      const th = r() * 6.2832 + Math.log(rad + 20) * -1.9 + this.time * (22 / rad);
      const y = (r() - 0.5) * rad * (0.02 + 0.3 * u);
      if (!this.disc3(Math.cos(th) * rad, y, Math.sin(th) * rad, o)) continue;
      const hue = hues[i % hues.length] + r() * 18, s0 = this.focal / (o[2] || 1);
      if (i % 3 === 0) {
        const th2 = th - 0.1;
        const p2 = this.disc3(Math.cos(th2) * rad, y, Math.sin(th2) * rad, o) ? [o[0], o[1]] : null;
        if (p2) {
          ctx.beginPath(); ctx.moveTo(p2[0], p2[1]); ctx.lineTo(o[0], o[1]);
          ctx.lineWidth = clamp(1.1 * s0, 0.5, 2.2);
          ctx.strokeStyle = `hsla(${hue}, 90%, 78%, ${0.3 * amt})`;
          ctx.stroke();
        }
      }
      const rr = clamp((1 + r() * 1.8) * s0, 0.6, 6);
      ctx.globalAlpha = (0.35 + 0.4 * (1 - u)) * amt;
      ctx.drawImage(this.sprite(hue, 82), o[0] - rr, o[1] - rr, rr * 2, rr * 2);
    }
    ctx.globalAlpha = 1;
  }

  // A soft background nebula haze, a couple of big blurred blobs in fixed screen positions with a little parallax,
  // plus (in Eclipse) one bright companion star — the pale point of light near the top of that reference picture.
  drawBackground() {
    const { ctx, w, h } = this, hue = MODE_CFG[this.mode].bgHue, amt = this.p.bg, mono = this.p.mono;
    if (amt < 0.02) return;
    const par = -this.cam.yaw * w * 0.08;
    ctx.globalCompositeOperation = 'lighter';
    const blobs = [[0.78, 0.22, 0.5], [0.16, 0.72, 0.4], [0.5, 0.85, 0.32]];
    for (const [bx, by, br] of blobs) {
      const x = ((bx * w + par) % (w * 1.3) + w * 1.3) % (w * 1.3) - w * 0.15, y = by * h;
      const r = br * Math.max(w, h);
      ctx.globalAlpha = 0.16 * amt;
      ctx.drawImage(this.sprite(hue, 55, 40), x - r, y - r, r * 2, r * 2);
    }
    if (mono > 0.3) {
      const x = w * 0.42 + par * 1.3, y = h * 0.14, r = Math.min(w, h) * 0.05;
      ctx.globalAlpha = mono * amt;
      ctx.drawImage(this.sprite(48, 30, 92), x - r * 4, y - r * 4, r * 8, r * 8);
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = mono * amt;
      ctx.beginPath(); ctx.arc(x, y, r * 0.3, 0, 6.2832); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Eclipse: a broad, soft lit sheet along the whole disc footprint, drawn before the hole and the particle rings
  // so it sits underneath them — this is what makes the disc read as a wide solid surface with a sheen on it,
  // like the reference picture, rather than only a scatter of separate dust points.
  drawSurface() {
    const { ctx } = this, amt = this.p.surface, o = this.pt3;
    if (amt < 0.02) return;
    if (!this.cam3(0, 0, 0, o)) return;
    const s0 = this.focal / o[2], px = o[0], py = o[1];
    const ang = Math.atan2(this.ts, this.tc), squash = clamp(0.16 + 0.5 * Math.sin(this.cam.pitch), 0.1, 0.6);
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.scale(1, squash);
    const r = this.discOuter * 1.05 * s0;
    ctx.globalAlpha = 0.4 * amt;
    ctx.drawImage(this.sprite(200, 62), -r, -r, r * 2, r * 2);
    ctx.globalAlpha = 0.22 * amt;
    ctx.drawImage(this.sprite(210, 45), -r * 1.4, -r * 1.4, r * 2.8, r * 2.8);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // Binary: a few long, curling wisps sweeping out from the ring into the background, like the smoky tendrils in
  // the reference picture. Built in screen space rather than tied to 3D disc geometry, since they only need to
  // fray outward convincingly, not stay geometrically exact as the camera moves.
  drawTendrils() {
    const { ctx } = this, amt = this.p.wisp, o = this.pt3;
    if (amt < 0.02) return;
    if (!this.cam3(0, 0, 0, o)) return;
    const px = o[0], py = o[1], s0 = this.focal / o[2];
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    const n = 9;
    for (let k = 0; k < n; k++) {
      const baseA = (k / n) * 6.2832 + this.time * 0.04;
      if (!this.disc3(Math.cos(baseA) * this.discOuter * 0.92, 0, Math.sin(baseA) * this.discOuter * 0.92, o)) continue;
      const bx = o[0], by = o[1], outA = Math.atan2(by - py, bx - px);
      const len = (55 + (k % 3) * 35) * s0 * 3.5;
      const bend = Math.sin(this.time * 0.5 + k * 1.7) * len * 0.4;
      const ex = bx + Math.cos(outA) * len, ey = by + Math.sin(outA) * len;
      const mx = bx + Math.cos(outA) * len * 0.5 - Math.sin(outA) * bend, my = by + Math.sin(outA) * len * 0.5 + Math.cos(outA) * bend;
      const path = new Path2D();
      path.moveTo(bx, by);
      path.quadraticCurveTo(mx, my, ex, ey);
      const hue = 26 + (k % 4) * 10;
      ctx.lineWidth = clamp(s0 * 7, 1.6, 9);
      ctx.strokeStyle = `hsla(${hue}, 85%, 75%, ${0.06 * amt})`;
      ctx.stroke(path);
      ctx.lineWidth = clamp(s0 * 2.2, 0.7, 3.2);
      ctx.strokeStyle = `hsla(${hue + 12}, 90%, 86%, ${0.35 * amt})`;
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  // Two spheres close enough to touch, a small very bright point exactly where they meet, and a pair of short
  // beams that fan apart going up — all sized and spaced to match the reference picture rather than the wider,
  // longer versions a single-hole mode would use.
  drawTwinHoles() {
    const { ctx } = this, amt = this.p.twin, o = this.pt3;
    if (amt < 0.02) return;
    if (!this.cam3(0, 0, 0, o)) return;
    const cfg = MODE_CFG[this.mode], sep = RH * 0.56, holeR = RH * 0.62, ang = this.time * 0.5, s0 = this.focal / o[2];
    const holes = [ang, ang + Math.PI].map((a) => (this.disc3(Math.cos(a) * sep, 0, Math.sin(a) * sep, o) ? [o[0], o[1], o[2]] : null));

    ctx.globalCompositeOperation = 'source-over';
    for (const p of holes) {
      if (!p) continue;
      ctx.globalAlpha = amt;
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(p[0], p[1], holeR * s0, 0, 6.2832); ctx.fill();
    }
    ctx.globalCompositeOperation = 'lighter';
    for (const p of holes) {
      if (!p) continue;
      ctx.globalAlpha = 0.85 * amt;
      ctx.strokeStyle = `hsla(${cfg.coreHue}, 90%, 82%, 1)`;
      ctx.lineWidth = Math.max(1, RH * s0 * 0.045);
      ctx.beginPath(); ctx.arc(p[0], p[1], holeR * s0 * 1.03, 0, 6.2832); ctx.stroke();
    }

    // one small, very bright point exactly at the contact seam between the two spheres
    const px = o[0], py = o[1];
    for (const [r, a] of [[holeR * s0 * 2.6, 0.3], [holeR * s0 * 1.1, 0.6], [holeR * s0 * 0.35, 1]]) {
      ctx.globalAlpha = a * amt;
      ctx.drawImage(this.sprite(46, 96), px - r, py - r, r * 2, r * 2);
    }

    // twin beams: short, close together, fanning apart as they rise, not long parallel jets
    const nx = -this.ts, ny = this.tc, L = RH * 9;
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i < 14; i++) {
        const u = i / 13, tt = L * Math.pow(u, 1.2);
        const lateral = side * RH * (0.1 + 0.7 * u * u);
        if (!this.cam3(nx * tt + this.tc * lateral, ny * tt, this.ts * lateral, o)) break;
        pts.push([o[0], o[1]]);
      }
      if (pts.length < 3) continue;
      const end = pts[pts.length - 1];
      const path = new Path2D();
      path.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
      const g = ctx.createLinearGradient(px, py, end[0], end[1]);
      g.addColorStop(0, `rgba(255, 245, 230, ${0.95 * amt})`);
      g.addColorStop(0.4, `rgba(255, 220, 190, ${0.5 * amt})`);
      g.addColorStop(1, 'rgba(255, 210, 180, 0)');
      ctx.lineCap = 'round';
      ctx.lineWidth = clamp(RH * s0 * 0.055, 0.8, 2.6);
      ctx.strokeStyle = g;
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  draw() {
    const { ctx, w, h, dpr } = this;
    const c = this.cam, cc = this.cc, bl = this.p.discBlue;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    // distant stars; the sky turns with the camera
    ctx.fillStyle = '#cdd6ff';
    for (const st of this.stars) {
      const x1 = cc.cy * st.x + cc.sy * st.z, z1 = -cc.sy * st.x + cc.cy * st.z;
      const y2 = cc.cp * st.y - cc.sp * z1, z2 = cc.sp * st.y + cc.cp * z1;
      if (z2 < 0.1) continue;
      const px = w / 2 + (x1 / z2) * this.focal * 0.8, py = h / 2 + (y2 / z2) * this.focal * 0.8;
      if (px < 0 || px > w || py < 0 || py > h) continue;
      ctx.globalAlpha = st.b * (0.6 + 0.4 * Math.sin(this.time * 1.5 + st.p)) * 0.85;
      const big = st.b > 0.9;
      ctx.fillRect(px, py, big ? 2.2 : 1.2, big ? 2.2 : 1.2);
    }
    this.drawBackground();
    this.drawSurface();

    // links between notes
    const o = this.pt3;
    if (this.plugin.settings.showLinks) {
      const path = new Path2D();
      for (const [a, b] of this.edges) {
        if (a.sd < 0 || b.sd < 0) continue;
        path.moveTo(a.sx, a.sy);
        path.lineTo(b.sx, b.sy);
      }
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = `hsla(${36 + (226 - 36) * bl}, 90%, 78%, ${0.07 + 0.01 * bl})`;
      ctx.stroke(path);
    }
    const hv = this.hover;
    if (hv) {
      ctx.beginPath();
      for (const n of hv.nb) if (n.sd >= 0) { ctx.moveTo(hv.sx, hv.sy); ctx.lineTo(n.sx, n.sy); }
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.1;
      ctx.globalAlpha = 1;
      ctx.stroke();
    }

    // the disc, the hole (Gargantua/Interstellar/Polarized/Maelstrom) and everything orbiting it
    if (this.p.hole > 0.02) {
      const tilt = { stx: 0, ctx: 1, stz: this.ts, ctz: this.tc };
      const proj = (x, y, z) => (this.cam3(x, y, z, o) ? [o[0], o[1], o[2]] : null);
      drawBlackHole(ctx, {
        proj, sprite: (hh, l) => this.sprite(hh, l), focal: this.focal, w, h,
        cx: 0, cy: 0, cz: 0, Rh: RH, tilt, dim: this.p.hole, holeAlpha: this.p.hole * (1 - this.p.twin),
        domeAmt: this.p.dome, domeHue: MODE_CFG[this.mode].domeHue,
        drawFar: () => this.drawBodies(true),
        drawNear: () => this.drawBodies(false),
      });
    } else {
      this.drawBodies(null);
    }
    this.drawJetsCore();
    this.drawGlow();
    this.drawMaelstrom();
    this.drawTendrils();
    this.drawTwinHoles();

    // labels
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '600 10px var(--font-interface, sans-serif)';
    for (const s of this.systems) {
      const th = s.label.th; // labels stay put on the disc
      if (!this.disc3(Math.cos(th) * s.label.r, 0, Math.sin(th) * s.label.r, o)) continue;
      if (o[0] < 0 || o[0] > w || o[1] < 0 || o[1] > h) continue;
      ctx.globalAlpha = (0.35 + 0.65 * s.dim) * clamp(this.focal / o[2] * 1.6 + 0.3, 0.4, 1);
      ctx.fillStyle = `hsl(${38 + (226 - 38) * bl}, 75%, 88%)`;
      ctx.shadowColor = `hsl(${30 + (230 - 30) * bl}, 95%, 60%)`;
      ctx.shadowBlur = 8;
      ctx.fillText((s.key === '(vault)' ? 'VAULT' : s.key).toUpperCase(), o[0], o[1]);
    }
    ctx.shadowBlur = 0;

    if (hv) {
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = '#e8e8ff';
      ctx.font = '12px var(--font-interface, sans-serif)';
      for (const n of hv.nb) if (n.sd >= 0) ctx.fillText(n.name, n.sx, n.sy + 12);
      ctx.globalAlpha = 1;
      ctx.font = '600 13px var(--font-interface, sans-serif)';
      const tw = ctx.measureText(hv.name).width + 16;
      const bx = clamp(hv.sx - tw / 2, 4, w - tw - 4), by = hv.sy - 34;
      ctx.fillStyle = 'rgba(8,6,18,0.88)';
      ctx.strokeStyle = `hsl(${36 + (228 - 36) * bl}, 90%, 74%)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, tw, 22, 11);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(hv.name, bx + tw / 2, by + 11.5);
    }
    ctx.globalAlpha = 1;
  }
}

class BlackHoleSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl;
    el.empty();
    const s = this.plugin.settings;
    new Setting(el)
      .setName('Look')
      .setDesc('Gargantua: edge-on orange disc, lensed halo, black event horizon. Quasar: blue-white core with two jets. Interstellar: dome-lit sphere with a frayed single jet. Polarized: near face-on, soft blurred ring, brighter on one side, like the real M87 photo. Maelstrom: a two-armed blue-purple whirlpool in a wide star-dust field. Galaxy: no event horizon, four spiral arms with dust lanes around an elongated core. Eclipse: silvery monochrome, full top-and-bottom halo, asteroid debris and a companion star. Binary: two event horizons orbiting each other in one shared disc, with twin beams.')
      .addDropdown((d) => {
        MODES.forEach((label, i) => d.addOption(String(i), label));
        d.setValue(String(s.mode)).onChange(async (v) => {
          s.mode = Number(v);
          await this.plugin.saveSettings();
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view.setMode) leaf.view.setMode(s.mode);
        });
      });
    new Setting(el).setName('Auto rotate').addToggle((t) => t.setValue(s.autoRotate).onChange(async (v) => { s.autoRotate = v; await this.plugin.saveSettings(); }));
    new Setting(el).setName('Show links').addToggle((t) => t.setValue(s.showLinks).onChange(async (v) => { s.showLinks = v; await this.plugin.saveSettings(); }));
    new Setting(el).setName('Orbit speed').addSlider((sl) => sl.setLimits(0, 4, 0.1).setValue(s.orbitSpeed).setDynamicTooltip().onChange(async (v) => { s.orbitSpeed = v; await this.plugin.saveSettings(); }));
    new Setting(el)
      .setName('Disc particles')
      .setDesc('More particles give a denser, brighter disc but cost performance.')
      .addSlider((sl) => sl.setLimits(0.3, 2, 0.1).setValue(s.particles).setDynamicTooltip().onChange(async (v) => {
        s.particles = v;
        await this.plugin.saveSettings();
        this.plugin.rebuildAll();
      }));
  }
}

module.exports = class BlackHoleGraphPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.rebuildAll = debounce(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) if (leaf.view.canvas) leaf.view.build();
    }, 800, true);

    this.registerView(VIEW_TYPE, (leaf) => new BlackHoleView(leaf, this));
    this.addRibbonIcon('aperture', 'Open black hole graph', () => this.activate());
    this.addCommand({ id: 'open-black-hole-graph', name: 'Open black hole graph', callback: () => this.activate() });
    this.addSettingTab(new BlackHoleSettings(this.app, this));
  }

  async saveSettings() { await this.saveData(this.settings); }

  async activate() {
    const ws = this.app.workspace;
    const existing = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) { ws.revealLeaf(existing); return; }
    const leaf = ws.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    ws.revealLeaf(leaf);
  }

  openNote(file, newTab) {
    const ws = this.app.workspace;
    let leaf = this.targetLeaf;
    if (newTab || !leaf || !ws.getLeavesOfType('markdown').includes(leaf)) {
      const existing = ws.getLeavesOfType('markdown')[0];
      leaf = newTab ? ws.getLeaf('tab') : existing || ws.getLeaf('split', 'vertical');
    }
    this.targetLeaf = leaf;
    leaf.openFile(file);
  }
};
