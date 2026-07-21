#!/usr/bin/env bash
# One-time build. Requires Node.js + npm + internet (ONLY for this step).
# Produces: vendor/react*.js and app.js — after which the extension runs fully
# offline with no CDN and no runtime Babel (CSP-compliant MV3).
set -euo pipefail
cd "$(dirname "$0")"

REACT_VER="18.3.1"

echo "==> [1/3] Downloading React ${REACT_VER} into vendor/ ..."
mkdir -p vendor
curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/react/${REACT_VER}/umd/react.production.min.js"          -o vendor/react.production.min.js
curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/react-dom/${REACT_VER}/umd/react-dom.production.min.js"   -o vendor/react-dom.production.min.js

echo "==> [2/3] Installing Babel (dev-only, for compiling JSX) ..."
npm install --silent --no-audit --no-fund

echo "==> [3/3] Compiling app.jsx -> app.js ..."
node - <<'NODE'
const fs = require("fs");
const babel = require("@babel/core");
const src = fs.readFileSync("app.jsx", "utf8");
const out = babel.transformSync(src, { presets: ["@babel/preset-react"] }).code;
fs.writeFileSync("app.js", out);
console.log("    wrote app.js (" + out.length + " bytes)");
NODE

echo ""
echo "==> Done. Now load the extension:"
echo "    1. Open chrome://extensions (or edge://extensions)"
echo "    2. Enable 'Developer mode'"
echo "    3. Click 'Load unpacked' and select this folder."
