'use strict';

// Renders every icon from the SVG sources below: `npm run icons`.
// The SVGs are the design; the PNGs in build/ and assets/ are generated.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HONEY = '#f0a92e';
const PROPOLIS = '#1d1814';
const INK = '#15110e';

// A pointy-top hexagon centred in a box of `size`, with the brand's two stripes.
function hexagon(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i += 1) {
    const a = (Math.PI / 180) * (60 * i - 90);
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

// The corners are rounded with a same-colour stroke; the stripes reach the
// stroke's outer edge so they still run the full width of the cell.
function cell({ cx, cy, r, fill, stripe, stripeWidth, round = 0.16 }) {
  const corner = r * round;
  const inner = r - corner / 2;
  const halfW = inner * Math.cos(Math.PI / 6) + corner / 2;
  const gap = r * 0.3;
  return `<polygon points="${hexagon(cx, cy, inner)}" fill="${fill}" stroke="${fill}" stroke-width="${corner}" stroke-linejoin="round"/>
    <path d="M${cx - halfW} ${cy - gap / 2 - stripeWidth / 2}h${halfW * 2}M${cx - halfW} ${cy + gap / 2 + stripeWidth / 2}h${halfW * 2}" stroke="${stripe}" stroke-width="${stripeWidth}"/>`;
}

// The app icon. `inset` leaves macOS's standard margin round the tile.
function appIcon(size, inset) {
  const tile = size - inset * 2;
  const radius = tile * 0.225;
  const c = size / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2a221c"/><stop offset="1" stop-color="${PROPOLIS}"/>
      </linearGradient>
    </defs>
    <rect x="${inset}" y="${inset}" width="${tile}" height="${tile}" rx="${radius}" fill="url(#g)"/>
    <rect x="${inset + 1.5}" y="${inset + 1.5}" width="${tile - 3}" height="${tile - 3}" rx="${radius - 1.5}" fill="none" stroke="rgba(242,235,227,0.08)" stroke-width="3"/>
    ${cell({ cx: c, cy: c, r: tile * 0.33, fill: HONEY, stripe: PROPOLIS, stripeWidth: tile * 0.065 })}
  </svg>`;
}

// Tray icons: the honey cell, plus a corner dot that says what is going on.
function trayIcon(size, state) {
  const c = size / 2;
  const r = size * 0.47;
  const dot = state === 'working' ? '#8fb3d9' : state === 'needs' ? '#ec6c50' : null;
  const d = size * 0.19;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${cell({ cx: c, cy: c, r, fill: HONEY, stripe: INK, stripeWidth: size * 0.12 })}
    ${dot ? `<circle cx="${size - d - 0.5}" cy="${state === 'needs' ? d + 0.5 : size - d - 0.5}" r="${d}" fill="${dot}" stroke="${INK}" stroke-width="${size * 0.06}"/>` : ''}
  </svg>`;
}

// macOS menu bar: black-and-transparent, recoloured by the system.
function trayTemplate(size) {
  const c = size / 2;
  const r = size * 0.47;
  const halfW = r * Math.cos(Math.PI / 6);
  const sw = size * 0.12;
  const gap = r * 0.3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><mask id="m"><rect width="${size}" height="${size}" fill="white"/>
      <path d="M${c - halfW} ${c - gap / 2 - sw / 2}h${halfW * 2}M${c - halfW} ${c + gap / 2 + sw / 2}h${halfW * 2}" stroke="black" stroke-width="${sw}"/></mask></defs>
    <polygon points="${hexagon(c, c, r)}" fill="black" mask="url(#m)"/>
  </svg>`;
}

async function render(svg, size, out) {
  const win = new BrowserWindow({
    width: size, height: size, show: false, frame: false, transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true }
  });
  win.webContents.setFrameRate(10);
  let latest = null;
  win.webContents.on('paint', (_event, _dirty, image) => { latest = image; });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  const page = path.join(app.getPath('temp'), `honeybee-icon-${process.pid}.html`);
  fs.writeFileSync(page, html);
  await win.loadFile(page);
  // Offscreen windows hand over their frames through paint events.
  for (let i = 0; i < 40 && !latest; i += 1) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 200));
  if (!latest) throw new Error(`no frame for ${out}`);
  const image = latest;
  const { width } = image.getSize();
  const png = (width === size ? image : image.resize({ width: size, height: size, quality: 'best' })).toPNG();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, png);
  win.destroy();
  console.log(`  ${path.relative(ROOT, out)}  ${size}px  ${png.length} bytes`);
}

// Each render closes its window; that must not end the run.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  // macOS: padded tile. Windows and Linux: the tile fills the canvas.
  await render(appIcon(1024, 100), 1024, path.join(ROOT, 'build', 'icon.png'));
  await render(appIcon(1024, 24), 1024, path.join(ROOT, 'build', 'icon-full.png'));
  for (const s of [16, 32, 48, 64, 128, 256, 512]) {
    await render(appIcon(s, Math.round(s * 0.03)), s, path.join(ROOT, 'build', 'icons', `${s}x${s}.png`));
  }
  await render(appIcon(512, 16), 512, path.join(ROOT, 'assets', 'icon.png'));
  for (const state of ['idle', 'working', 'needs']) {
    await render(trayIcon(16, state), 16, path.join(ROOT, 'assets', 'tray', `tray-${state}.png`));
    await render(trayIcon(32, state), 32, path.join(ROOT, 'assets', 'tray', `tray-${state}@2x.png`));
  }
  await render(trayTemplate(16), 16, path.join(ROOT, 'assets', 'tray', 'trayTemplate.png'));
  await render(trayTemplate(32), 32, path.join(ROOT, 'assets', 'tray', 'trayTemplate@2x.png'));
  // The SVG sources, kept for anyone who wants to edit the design.
  fs.mkdirSync(path.join(ROOT, 'assets', 'source'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'assets', 'source', 'icon.svg'), appIcon(1024, 100));
  fs.writeFileSync(path.join(ROOT, 'assets', 'source', 'tray.svg'), trayIcon(32, 'idle'));
  app.quit();
});
