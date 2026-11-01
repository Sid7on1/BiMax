// Test the actual ESM renderer dependency through a CJS bundle, preserving React's single runtime.
const { buildSync } = require('../app/node_modules/esbuild');
const path = require('node:path');
const fs = require('node:fs');
module.exports = () => {
  const directory = path.join(__dirname, '../node_modules/.cache/bimax-jest');
  fs.mkdirSync(directory, {recursive:true});
  buildSync({entryPoints:[path.join(__dirname,'../app/node_modules/streamdown/dist/index.js')], bundle:true, platform:'node', format:'cjs', target:'node22', external:['react','react/*','react-dom','react-dom/*'], outfile:path.join(directory,'streamdown.cjs')});
};
