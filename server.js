// server.js
const { serveHTTP } = require('stremio-addon-sdk');
const addonInterface = require('./addon'); // exports builder.getInterface()

const PORT = process.env.PORT || 7000;

serveHTTP(addonInterface, { port: PORT });
console.log(`Stremio add-on running on http://127.0.0.1:${PORT}/manifest.json`);
console.log(`HTTP addon accessible at: http://localhost:${PORT}/manifest.json`);
