const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const svg192 = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="34" fill="#0B1120"/>
  <circle cx="96" cy="96" r="72" fill="none" stroke="#38BDF8" stroke-width="3" opacity="0.3"/>
  <text x="96" y="122" font-size="100" text-anchor="middle" fill="#38BDF8" font-family="Arial">&#x26A1;</text>
</svg>`;

const svg512 = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="90" fill="#0B1120"/>
  <circle cx="256" cy="256" r="192" fill="none" stroke="#38BDF8" stroke-width="8" opacity="0.3"/>
  <text x="256" y="325" font-size="270" text-anchor="middle" fill="#38BDF8" font-family="Arial">&#x26A1;</text>
</svg>`;

fs.writeFileSync(path.join(outDir, 'icon-192.svg'), svg192);
fs.writeFileSync(path.join(outDir, 'icon-512.svg'), svg512);

try {
  const sharp = require('sharp');
  Promise.all([
    sharp(Buffer.from(svg192)).png().toFile(path.join(outDir, 'icon-192.png')),
    sharp(Buffer.from(svg512)).png().toFile(path.join(outDir, 'icon-512.png')),
  ])
    .then(() => console.log('PNG icons generated OK'))
    .catch((e) => console.log('sharp PNG error:', e.message));
} catch (e) {
  console.log('sharp not installed — SVG icons written. PNG can be generated later.');
}
