'use strict';

// Renders the promo video from promo/stage.html: one frame at a time in an
// offscreen window, piped straight to ffmpeg (on the PATH, or set FFMPEG).
//
//   electron promo/render.js                    docs/honeybee.webp (the README's loop) and
//                                               promo/out/honeybee.mp4 (for sharing)
//   electron promo/render.js --stills 0,4.5     promo/out/stills/*.png, single moments

const { app, BrowserWindow, nativeTheme, protocol } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'out');
const WIDTH = 1920;
const HEIGHT = 1080;
const ZOOM = 1.5; // the stage is laid out at 1280×720 CSS pixels
const FPS = 60;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

// The real window, with the video's script slipped in ahead of app.js. Its
// own Content-Security-Policy allows both, as they come from the same origin.
function widgetPage(html) {
  const script = '<script src="app.js"></script>';
  const styles = '<link rel="stylesheet" href="styles.css">';
  if (!html.includes(script) || !html.includes(styles)) {
    throw new Error('src/renderer/index.html no longer loads styles.css and app.js the way promo/render.js expects');
  }
  return html
    .replace(styles, `${styles}\n  <link rel="stylesheet" href="/promo/widget.css">`)
    .replace(script, `<script src="/promo/widget-shim.js"></script>\n  ${script}`);
}

// The same pixels on any machine: plain sRGB, and greyscale text smoothing
// (subpixel smoothing comes and goes as layers change, and leaves coloured
// fringes once the video is compressed).
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-lcd-text');

// stage://honeybee/<path> serves <repo>/<path>, so the stage and the window
// share an origin and the stage can drive the window directly.
protocol.registerSchemesAsPrivileged([
  { scheme: 'stage', privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);

function serve(request) {
  const { pathname } = new URL(request.url);
  const file = path.join(ROOT, decodeURIComponent(pathname));
  if (!file.startsWith(ROOT + path.sep)) return new Response(null, { status: 403 });
  let body;
  try {
    body = fs.readFileSync(file);
  } catch (_) {
    return new Response(null, { status: 404 });
  }
  if (pathname === '/src/renderer/index.html') body = widgetPage(body.toString('utf8'));
  return new Response(body, { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
}

// One frame: the stage moves everything to t, waits until that is painted,
// and the window's pixels are copied.
async function frameAt(win, t) {
  await win.webContents.executeJavaScript(`stage.seek(${t})`);
  let image = await win.webContents.capturePage();
  const size = image.getSize();
  if (size.width !== WIDTH || size.height !== HEIGHT) image = image.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
  return image;
}

function write(stream, buffer) {
  return new Promise((resolve) => {
    if (stream.write(buffer)) resolve();
    else stream.once('drain', resolve);
  });
}

async function stills(win, times) {
  const dir = path.join(OUT, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of times) {
    const image = await frameAt(win, t);
    fs.writeFileSync(path.join(dir, `t${t.toFixed(2).padStart(5, '0')}.png`), image.toPNG());
  }
  console.log(`${times.length} stills in ${dir}`);
}

async function video(win, duration) {
  fs.mkdirSync(OUT, { recursive: true });
  const mp4 = path.join(OUT, 'honeybee.mp4');
  const webp = path.join(ROOT, 'docs', 'honeybee.webp');
  // Two files from one pass: the full video for sharing, and the README's
  // loop, which plays by itself on GitHub where a video can't.
  const ffmpeg = spawn(process.env.FFMPEG || 'ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${WIDTH}x${HEIGHT}`, '-r', String(FPS), '-i', 'pipe:0',
    '-map', '0:v', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', mp4,
    '-map', '0:v', '-vf', 'fps=30,scale=1280:720:flags=lanczos',
    '-c:v', 'libwebp_anim', '-quality', '90', '-compression_level', '6', '-loop', '0', webp
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const finished = new Promise((resolve, reject) => {
    ffmpeg.on('error', (err) => reject(new Error(`could not run ffmpeg (${err.message}); install it or set FFMPEG`)));
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  const frames = Math.round(duration * FPS);
  const started = Date.now();
  for (let i = 0; i < frames; i += 1) {
    const image = await frameAt(win, i / FPS);
    await write(ffmpeg.stdin, image.toBitmap());
    if (i % FPS === 0) console.log(`frame ${i}/${frames}`);
  }
  ffmpeg.stdin.end();
  await finished;
  const mb = (file) => `${(fs.statSync(file).size / 1048576).toFixed(1)} MB`;
  console.log(`${frames} frames in ${Math.round((Date.now() - started) / 1000)} s`);
  console.log(`${mp4} (${mb(mp4)})\n${webp} (${mb(webp)})`);
}

async function run() {
  widgetPage(fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8'));
  protocol.handle('stage', serve);
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, zoomFactor: ZOOM }
  });
  win.webContents.setFrameRate(FPS);
  await win.loadURL('stage://honeybee/promo/stage.html');
  const duration = await win.webContents.executeJavaScript('stage.ready');
  const stillsAt = process.argv.indexOf('--stills');
  if (stillsAt > 0) await stills(win, process.argv[stillsAt + 1].split(',').map(Number));
  else await video(win, duration);
}

app.on('window-all-closed', () => {});
app.whenReady()
  .then(run)
  .then(() => app.exit(0), (err) => {
    console.error(err);
    app.exit(1);
  });
