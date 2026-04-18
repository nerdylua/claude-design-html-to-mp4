#!/usr/bin/env node
// html-to-mp4 — General HTML → MP4 converter
// ─────────────────────────────────────────────────────────────────────────────
// USAGE
//   node convert.js <input.html> [options]
//
// OPTIONS
//   --out <file.mp4>       Output file (default: <input-basename>.mp4 next to input)
//   --fps <n>              Frames per second (default: 30)
//   --duration <sec>       Duration in seconds (required unless HTML sets window.__capture.duration)
//   --width <px>           Viewport width (default: 1920, or window.__capture.width)
//   --height <px>          Viewport height (default: 1080, or window.__capture.height)
//   --selector <css>       CSS selector of element to screenshot (default: full viewport,
//                          or window.__capture.selector, or [data-capture], or [data-stage-canvas])
//   --mode <auto|det|rt>   Capture mode. auto (default) uses deterministic if a capture
//                          handle is detected, else realtime. det = force deterministic.
//                          rt = force realtime (Playwright video → ffmpeg transcode).
//   --crf <0-51>           H.264 quality (default: 18, visually lossless)
//   --preset <name>        ffmpeg preset (default: slow)
//   --wait <sec>           Extra warm-up wait after page load (default: 1)
//   --port <n>             Local server port (default: 7891)
//   --query <string>       Query string appended to the page URL, e.g. "capture=1"
//   --keep-frames          Keep PNG frames after encoding
//   --no-server            Load file:// directly instead of via local HTTP server
//   --help                 Show this help
//
// DETERMINISTIC MODE — "Claude design" convention
// ─────────────────────────────────────────────────────────────────────────────
// For perfect, stutter-free captures the HTML can expose a global handle:
//
//   window.__capture = {
//     duration: 32,           // required — total seconds to render
//     fps: 30,                // optional — overrides --fps default
//     width: 1920,            // optional — viewport width
//     height: 1080,           // optional — viewport height
//     selector: '[data-capture]', // optional — element to screenshot
//     setTime(t) { ... },     // required — set current animation time (seconds)
//     setPlaying(b) { ... },  // optional — pause the internal clock
//   };
//
// The converter will pause the animation and call setTime(t) for each frame,
// guaranteeing deterministic output regardless of machine speed.
// Legacy alias: window.__animStage (same shape) is also recognized.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const { chromium } = require('playwright');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { pathToFileURL } = require('url');
const { execSync, spawnSync } = require('child_process');

// ── Arg parsing (no external deps) ────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.flags.help = true; continue; }
    if (a === '--keep-frames') { args.flags.keepFrames = true; continue; }
    if (a === '--no-server')   { args.flags.noServer   = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        console.error(`Missing value for --${key}`); process.exit(2);
      }
      args.flags[key] = val;
      i++;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function printHelp() {
  const help = fs.readFileSync(__filename, 'utf8')
    .split('\n')
    .filter(l => l.startsWith('//'))
    .slice(0, 45)
    .map(l => l.replace(/^\/\/ ?/, ''))
    .join('\n');
  console.log(help);
}

// ── MIME for the static server ────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm' : 'text/html; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.mjs' : 'application/javascript; charset=utf-8',
  '.jsx' : 'application/javascript; charset=utf-8',
  '.ts'  : 'application/javascript; charset=utf-8',
  '.tsx' : 'application/javascript; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif' : 'image/gif',
  '.webp': 'image/webp',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.json': 'application/json',
  '.mp3' : 'audio/mpeg', '.wav': 'audio/wav',
  '.mp4' : 'video/mp4', '.webm': 'video/webm',
};

function startServer(rootDir, port) {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.resolve(rootDir, '.' + urlPath);
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500);
        res.end(`Error: ${err.message}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ── Small utils ───────────────────────────────────────────────────────────────
function clearDir(dir) {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return; }
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { clearDir(p); fs.rmdirSync(p); }
    else fs.unlinkSync(p);
  }
}

const pad  = (n, w = 5) => String(n).padStart(w, '0');
const fmtT = s => {
  const m = Math.floor(s / 60);
  const ss = (s % 60).toFixed(1).padStart(4, '0');
  return `${m}:${ss}`;
};

function checkFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (r.error || r.status === null) {
    console.error('\nffmpeg not found on PATH.');
    console.error('Install from https://ffmpeg.org/download.html and re-run.\n');
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help) {
    printHelp();
    process.exit(0);
  }
  if (args._.length === 0) {
    printHelp();
    process.exit(1);
  }

  const inputArg = args._[0];
  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`); process.exit(1);
  }
  const inputStat = fs.statSync(inputPath);
  let htmlFile, rootDir;
  if (inputStat.isDirectory()) {
    rootDir = inputPath;
    const idx = path.join(rootDir, 'index.html');
    if (!fs.existsSync(idx)) {
      console.error(`Directory has no index.html: ${rootDir}`); process.exit(1);
    }
    htmlFile = 'index.html';
  } else {
    rootDir  = path.dirname(inputPath);
    htmlFile = path.basename(inputPath);
  }

  const baseName = path.basename(htmlFile, path.extname(htmlFile));
  const OUTPUT   = path.resolve(args.flags.out || path.join(rootDir, `${baseName}.mp4`));
  const PORT     = Number(args.flags.port || 7891);
  const WAIT_S   = Number(args.flags.wait || 1);
  const MODE_REQ = (args.flags.mode || 'auto').toLowerCase();
  const CRF      = String(args.flags.crf || 18);
  const PRESET   = args.flags.preset || 'slow';
  const USE_SERVER = !args.flags['no-server'] && !args.flags.noServer;

  // Defaults (may be overridden by window.__capture)
  let FPS      = Number(args.flags.fps || 30);
  let DURATION = args.flags.duration !== undefined ? Number(args.flags.duration) : null;
  let VP_W     = Number(args.flags.width  || 1920);
  let VP_H     = Number(args.flags.height || 1080);
  let SELECTOR = args.flags.selector || null;

  const FRAMES_DIR = path.join(rootDir, `.html-to-mp4-frames-${process.pid}`);

  console.log('html-to-mp4 — Claude design → MP4');
  console.log('─'.repeat(60));
  console.log(`  Input:   ${path.join(rootDir, htmlFile)}`);
  console.log(`  Output:  ${OUTPUT}`);
  console.log(`  Mode:    ${MODE_REQ}`);
  console.log('─'.repeat(60));

  checkFfmpeg();

  // Start static server (unless --no-server)
  const QUERY = args.flags.query ? (args.flags.query.startsWith('?') ? args.flags.query.slice(1) : args.flags.query) : '';
  let server = null, pageUrl;
  if (USE_SERVER) {
    server = await startServer(rootDir, PORT);
    pageUrl = `http://localhost:${PORT}/${encodeURI(htmlFile)}${QUERY ? '?' + QUERY : ''}`;
    console.log(`\nServing ${rootDir} at http://localhost:${PORT}`);
  } else {
    pageUrl = pathToFileURL(path.join(rootDir, htmlFile)).href + (QUERY ? '?' + QUERY : '');
    console.log(`\nUsing file:// URL (relative fetch()/ESM may fail without --server)`);
  }

  // Realtime video path needs recordVideo configured on context creation,
  // so we decide mode upfront for RT, but for AUTO we first probe the page.
  let browser, context, page;

  async function launch(recordVideo) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-web-security',
        '--hide-scrollbars',
      ],
    });
    const ctxOpts = {
      viewport: { width: VP_W, height: VP_H },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    };
    if (recordVideo) {
      ctxOpts.recordVideo = {
        dir: FRAMES_DIR,
        size: { width: VP_W, height: VP_H },
      };
    }
    context = await browser.newContext(ctxOpts);
    page = await context.newPage();
    page.on('console',   m => { if (m.type() === 'error') console.warn('  [browser]', m.text()); });
    page.on('pageerror', e => console.warn('  [page error]', e.message));
  }

  // ── AUTO / DETERMINISTIC path ────────────────────────────────────────────
  if (MODE_REQ === 'auto' || MODE_REQ === 'det') {
    await launch(false);
    console.log(`\nLoading ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 90_000 });
    console.log('  Page loaded');

    // Probe for capture handle (short wait)
    const handle = await page.evaluate(async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const h = window.__capture || window.__animStage;
        if (h && typeof h.setTime === 'function') {
          return {
            duration: typeof h.duration === 'number' ? h.duration : null,
            fps:      typeof h.fps === 'number' ? h.fps : null,
            width:    typeof h.width === 'number' ? h.width : null,
            height:   typeof h.height === 'number' ? h.height : null,
            selector: typeof h.selector === 'string' ? h.selector : null,
            hasSetPlaying: typeof h.setPlaying === 'function',
            kind: window.__capture ? '__capture' : '__animStage',
          };
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return null;
    });

    const forcedDet = MODE_REQ === 'det';
    if (!handle && forcedDet) {
      console.error('\n--mode=det requires window.__capture or window.__animStage. Not found.');
      await browser.close(); if (server) server.close(); process.exit(1);
    }

    if (handle) {
      console.log(`  Capture handle: window.${handle.kind} detected`);
      if (handle.duration && DURATION === null) DURATION = handle.duration;
      if (handle.fps    && !args.flags.fps)     FPS = handle.fps;
      if (handle.width  && !args.flags.width)   VP_W = handle.width;
      if (handle.height && !args.flags.height)  VP_H = handle.height;
      if (handle.selector && !SELECTOR)         SELECTOR = handle.selector;

      if (DURATION === null) {
        console.error('\nDuration unknown. Set window.__capture.duration or pass --duration.');
        await browser.close(); if (server) server.close(); process.exit(1);
      }

      // Re-size viewport if handle provided different dims
      if (VP_W !== 1920 || VP_H !== 1080) {
        await page.setViewportSize({ width: VP_W, height: VP_H });
      }

      // If no selector, default to known conventions or full page
      if (!SELECTOR) {
        const defaultSel = await page.evaluate(() => {
          if (document.querySelector('[data-capture]'))      return '[data-capture]';
          if (document.querySelector('[data-stage-canvas]')) return '[data-stage-canvas]';
          return null;
        });
        SELECTOR = defaultSel; // null → full page
      }

      await runDeterministic();
      await encode();
      return;
    }

    // No handle → fall back to realtime
    console.log('  No capture handle detected → falling back to realtime mode');
    await browser.close(); browser = null;
  }

  // ── REALTIME path ────────────────────────────────────────────────────────
  if (DURATION === null) {
    console.error('\nRealtime mode requires --duration <seconds>.');
    if (server) server.close();
    process.exit(1);
  }
  await runRealtime();
  await encode();

  // ── Deterministic frame-stepping ─────────────────────────────────────────
  async function runDeterministic() {
    const TOTAL = Math.ceil(DURATION * FPS);
    console.log(`\nDeterministic capture: ${TOTAL} frames  (${FPS}fps × ${DURATION}s)  ${VP_W}×${VP_H}`);
    clearDir(FRAMES_DIR);

    // Pause the internal clock if the handle supports it
    await page.evaluate(() => {
      const h = window.__capture || window.__animStage;
      if (h && typeof h.setPlaying === 'function') h.setPlaying(false);
    });
    await page.waitForTimeout(Math.round(WAIT_S * 1000));

    // Warm-up: seek to 0 so fonts/images finalize
    await page.evaluate(() => {
      const h = window.__capture || window.__animStage; h.setTime(0);
    });
    await page.waitForTimeout(500);

    const target = SELECTOR ? page.locator(SELECTOR).first() : null;
    const shot = async (file) => target
      ? target.screenshot({ path: file, type: 'png' })
      : page.screenshot({ path: file, type: 'png', fullPage: false });

    // Discard warm-up shot
    const wu = path.join(FRAMES_DIR, '_warmup.png');
    await shot(wu); fs.unlinkSync(wu);

    console.log('─'.repeat(60));
    const t0 = Date.now();
    for (let f = 0; f < TOTAL; f++) {
      const t = f / FPS;
      await page.evaluate(t => new Promise(resolve => {
        const h = window.__capture || window.__animStage;
        h.setTime(t);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }), t);
      await shot(path.join(FRAMES_DIR, `frame_${pad(f)}.png`));
      if (f % FPS === 0 || f === TOTAL - 1) {
        const el = (Date.now() - t0) / 1000;
        const pct = ((f + 1) / TOTAL * 100).toFixed(1);
        const fps_r = f > 0 ? (f / el).toFixed(1) : '…';
        const eta = f > 0 ? Math.round((el / (f + 1)) * (TOTAL - f - 1)) : '?';
        process.stdout.write(
          `  [${pct.padStart(5)}%]  frame ${String(f + 1).padStart(4)}/${TOTAL}` +
          `  t=${fmtT(t)}  ${fps_r} fps  ETA ${eta}s        \r`
        );
      }
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${TOTAL} frames in ${dt}s`);

    await browser.close(); browser = null;
    if (server) server.close();
  }

  // ── Realtime via Playwright recordVideo → ffmpeg transcode ───────────────
  async function runRealtime() {
    clearDir(FRAMES_DIR);
    await launch(true);
    console.log(`\nLoading ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 90_000 });
    console.log(`  Page loaded — recording for ${DURATION}s at ${VP_W}×${VP_H}`);
    await page.waitForTimeout(Math.round(WAIT_S * 1000));

    const t0 = Date.now();
    const tick = setInterval(() => {
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`  recording… ${el}s / ${DURATION}s   \r`);
    }, 500);
    await page.waitForTimeout(Math.round(DURATION * 1000));
    clearInterval(tick);

    // Closing the page/context flushes the video to disk
    const videoPromise = page.video() ? page.video().path() : null;
    await page.close();
    await context.close();
    await browser.close();
    browser = null;
    if (server) server.close();

    if (!videoPromise) {
      console.error('\nPlaywright did not produce a video.');
      process.exit(1);
    }
    const webm = await videoPromise;
    console.log(`\n  Raw capture: ${webm}`);
    // Leave file in place — encode() will pick it up.
    global.__rtVideoPath = webm;
  }

  // ── Encode ───────────────────────────────────────────────────────────────
  async function encode() {
    let cmd;
    if (global.__rtVideoPath) {
      // Realtime path: transcode webm → mp4
      const webm = global.__rtVideoPath;
      cmd =
        `ffmpeg -y -i "${webm}" ` +
        `-r ${FPS} ` +
        `-c:v libx264 -pix_fmt yuv420p -crf ${CRF} -preset ${PRESET} ` +
        `-vf "scale=${VP_W}:${VP_H},format=yuv420p" ` +
        `-movflags +faststart ` +
        `"${OUTPUT}"`;
    } else {
      // Deterministic path: frames → mp4
      const pattern = path.join(FRAMES_DIR, 'frame_%05d.png');
      cmd =
        `ffmpeg -y -framerate ${FPS} -i "${pattern}" ` +
        `-c:v libx264 -pix_fmt yuv420p -crf ${CRF} -preset ${PRESET} ` +
        `-vf "scale=${VP_W}:${VP_H},format=yuv420p" ` +
        `-movflags +faststart ` +
        `"${OUTPUT}"`;
    }

    console.log('\nEncoding MP4…');
    console.log(`  ${cmd}\n`);
    try { execSync(cmd, { stdio: 'inherit' }); }
    catch { console.error('\nffmpeg failed.'); process.exit(1); }

    const mb = (fs.statSync(OUTPUT).size / 1024 / 1024).toFixed(1);
    console.log(`\nDone → ${OUTPUT}  (${mb} MB)`);

    if (!args.flags.keepFrames && !args.flags['keep-frames']) {
      console.log('Cleaning working dir…');
      clearDir(FRAMES_DIR);
      try { fs.rmdirSync(FRAMES_DIR); } catch {}
    } else {
      console.log(`Kept working dir: ${FRAMES_DIR}`);
    }
  }
}

main().catch(err => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});