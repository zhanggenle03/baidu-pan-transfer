#!/bin/sh
set -eu
node scripts/build.mjs
cd dist
rm -f baidu-transfer-helper-chromium.zip baidu-transfer-helper-firefox.xpi SHA256SUMS.txt
(cd chromium && zip -qr ../baidu-transfer-helper-chromium.zip .)
(cd firefox && zip -qr ../baidu-transfer-helper-firefox.xpi .)
shasum -a 256 baidu-transfer-helper-chromium.zip baidu-transfer-helper-firefox.xpi userscript/baidu-transfer-helper.user.js > SHA256SUMS.txt
printf 'Packaged install files and checksums.\n'
