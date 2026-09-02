const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3600;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    }
  }
  console.log('\nCalorie Counter running! Your food, weight, and settings are saved on the');
  console.log('device you open this on, nothing is stored on this server.');
  console.log(`  Local:   http://localhost:${PORT}`);
  addresses.forEach(addr => console.log(`  Network: http://${addr}:${PORT}  <-- open this on your phone (same WiFi)`));
  console.log('');
  console.log('Note: over plain http, browsers disable offline mode and home screen install.');
  console.log('Serve it over https (e.g. the GitHub Pages deploy in this repo) to install it');
  console.log('as a full offline home-screen app.');
  console.log('');
});
