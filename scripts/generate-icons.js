const fs = require('fs');
const path = require('path');

fs.mkdirSync(path.join(__dirname, '..', 'public', 'icons'), { recursive: true });

const svgs = {
  'icon-192.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192">
  <rect width="192" height="192" rx="34" fill="#0B1120"/>
  <circle cx="96" cy="96" r="72" fill="none" stroke="#38BDF8" stroke-width="3" opacity="0.3"/>
  <text x="96" y="122" font-size="100" text-anchor="middle" fill="#38BDF8" font-family="Arial">&#x26A1;</text>
</svg>`,
  'icon-512.svg': `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="90" fill="#0B1120"/>
  <circle cx="256" cy="256" r="192" fill="none" stroke="#38BDF8" stroke-width="8" opacity="0.3"/>
  <text x="256" y="325" font-size="270" text-anchor="middle" fill="#38BDF8" font-family="Arial">&#x26A1;</text>
</svg>`,
};

const outDir = path.join(__dirname, '..', 'public', 'icons');

for (const [name, content] of Object.entries(svgs)) {
  fs.writeFileSync(path.join(outDir, name), content);
}

// Try to convert to PNG using sharp
try {
  const sharp = require('sharp');
  Promise.all([
    sharp(Buffer.from(svgs['icon-192.svg'])).png().toFile(path.join(outDir, 'icon-192.png')),
    sharp(Buffer.from(svgs['icon-512.svg'])).png().toFile(path.join(outDir, 'icon-512.png')),
  ])
    .then(() => console.log('PNG icons generated via sharp'))
    .catch((e) => console.log('sharp PNG failed, SVGs written instead:', e.message));
} catch (e) {
  console.log('sharp not available; SVG icons written. Run: npm install sharp && node scripts/generate-icons.js');
}
