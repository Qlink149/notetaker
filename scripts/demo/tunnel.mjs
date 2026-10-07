// Public https address for the demo web app (phones need https to use the microphone).
// Uses localtunnel: no account. Start `npm run demo` first.
import localtunnel from 'localtunnel';

const tunnel = await localtunnel({ port: 5173 });
const ip = await fetch('https://ipv4.icanhazip.com')
  .then((r) => r.text())
  .catch(() => '(your public IP)');
console.log(`
==================================================================
 Phones can open:  ${tunnel.url}
 The first visit on each phone may show a "tunnel reminder" page asking for a password:
 it is this computer's public IP address: ${ip.trim()}
 Then use the QR code on the Record page (set "Address phones should open" to the address above).
 Press Ctrl+C to close the tunnel.
==================================================================`);
tunnel.on('close', () => process.exit(0));
tunnel.on('error', (e) => console.error('tunnel error:', e.message));
