// Builds the Dock/Desktop icon: Contents/Resources/AppIcon.icns.
//
//   node scripts/make-icon.mjs
//
// Development-only — the .icns it produces is committed, so a normal install
// never runs this and needs neither Playwright nor a browser.
//
// Each size is vector-rendered at its own resolution in headless Chromium
// rather than downscaled from one big raster, so the 16px Dock-adjacent sizes
// stay legible instead of turning to mush.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Playwright is a developer tool here, not a dependency of the app, so it is
// usually installed globally rather than in node_modules. Try the normal
// resolution first and fall back to the global root.
function loadChromium() {
  for (const id of ["playwright", "@playwright/test"]) {
    try {
      return require(id).chromium;
    } catch {
      /* try the next one */
    }
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    for (const id of ["playwright", "@playwright/test"]) {
      const candidate = join(globalRoot, id);
      if (existsSync(candidate)) return require(candidate).chromium;
    }
  } catch {
    /* fall through to the error below */
  }
  throw new Error(
    "Playwright not found. Install it with: npm install -g playwright"
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const resourcesDir = join(here, "..", "Chinese Drills.app", "Contents", "Resources");

// icns entry types that hold PNG data, and the pixel size each expects.
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];
const SIZES = [...new Set(ICNS_TYPES.map(([, s]) => s))];

// 汉 — the character in 汉语, "Chinese". One glyph reads at 16px where a word
// would not, and it says what the app is without a word of English.
const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#4d90fe"/>
      <stop offset="100%" stop-color="#1a73e8"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" fill="url(#bg)"/>
  <text x="512" y="512" fill="#ffffff"
        font-family="'Noto Sans SC','Source Han Sans SC','PingFang SC','Hiragino Sans GB','WenQuanYi Zen Hei','Microsoft YaHei',sans-serif"
        font-size="640" font-weight="600"
        text-anchor="middle" dominant-baseline="central">汉</text>
</svg>`;

const chromium = loadChromium();

function chromiumExecutablePath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  try {
    for (const dir of readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()) {
      const bin = join(root, dir, "chrome-linux", "chrome");
      if (existsSync(bin)) return bin;
    }
    const plain = join(root, "chromium");
    if (existsSync(plain)) return plain;
  } catch {
    /* use the managed browser */
  }
  return undefined;
}

const executablePath = chromiumExecutablePath();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 1200 } });

const pngBySize = {};
for (const size of SIZES) {
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(size)}`
  );
  pngBySize[size] = await page.locator("svg").screenshot({ omitBackground: true });
  console.log(`rendered ${size}x${size} (${pngBySize[size].length} bytes)`);
}
// A 256px copy to eyeball before committing the binary.
await page.setContent(
  `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg(256)}`
);
const preview = await page.locator("svg").screenshot({ omitBackground: true });
await browser.close();

// Pack the .icns: 'icns' magic + big-endian total length, then one
// [type][length][png] chunk per entry.
const chunks = ICNS_TYPES.map(([type, size]) => {
  const png = pngBySize[size];
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(png.length + 8, 4);
  return Buffer.concat([head, png]);
});
const body = Buffer.concat(chunks);
const magic = Buffer.alloc(8);
magic.write("icns", 0, "ascii");
magic.writeUInt32BE(body.length + 8, 4);
const icns = Buffer.concat([magic, body]);

mkdirSync(resourcesDir, { recursive: true });
writeFileSync(join(resourcesDir, "AppIcon.icns"), icns);
console.log(`wrote AppIcon.icns (${icns.length} bytes, ${ICNS_TYPES.length} entries)`);

const previewPath = process.env.ICON_PREVIEW;
if (previewPath) {
  writeFileSync(previewPath, preview);
  console.log(`wrote preview ${previewPath}`);
}
