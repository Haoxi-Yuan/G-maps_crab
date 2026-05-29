'use strict';

/**
 * proxy-fetch.js
 *
 * Proxy support for the image downloader, with ZERO npm dependencies.
 *
 * Why this exists: from inside the GFW, `googleusercontent.com` is only
 * reachable through a tunnel. This module lets the fetcher route its HTTPS
 * downloads through a local proxy (Clash/mihomo mixed port, a SOCKS5 server,
 * etc.) regardless of the host's VPN routing rules — making the program
 * portable across machines (set one env var / flag per device).
 *
 * Supported proxy URLs:
 *   http://host:port      — HTTP CONNECT tunnel (Clash "mixed" port speaks this)
 *   https://host:port     — HTTP CONNECT over TLS to the proxy
 *   socks5://host:port    — SOCKS5, client-side DNS
 *   socks5h://host:port   — SOCKS5, proxy-side DNS (preferred: avoids local DNS poisoning)
 *
 * Usage:
 *   const { makeProxyAgent, testProxy } = require('./proxy-fetch');
 *   https.globalAgent = makeProxyAgent('http://127.0.0.1:7897');   // route ALL https.get
 *   const r = await testProxy('http://127.0.0.1:7897');            // preflight check
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const { URL } = require('url');

// ─────────────────────────────────────────────────────────────────────────────
//  HTTP CONNECT tunnel → returns a raw socket connected to target host:port
// ─────────────────────────────────────────────────────────────────────────────

function httpConnect(proxy, targetHost, targetPort, timeoutMs, cb) {
  const isTLS = proxy.protocol === 'https:';
  const connectOpts = {
    host: proxy.hostname,
    port: proxy.port || (isTLS ? 443 : 80),
    timeout: timeoutMs,
  };
  const transport = isTLS ? tls : net;
  const proxySock = transport.connect(connectOpts, () => {
    let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`;
    req += `Host: ${targetHost}:${targetPort}\r\n`;
    if (proxy.username) {
      const auth = Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      ).toString('base64');
      req += `Proxy-Authorization: Basic ${auth}\r\n`;
    }
    req += 'Connection: keep-alive\r\n\r\n';
    proxySock.write(req);
  });

  let banner = '';
  const onData = (chunk) => {
    banner += chunk.toString('binary');
    const idx = banner.indexOf('\r\n\r\n');
    if (idx < 0) return; // wait for full status line + headers
    proxySock.removeListener('data', onData);
    const statusLine = banner.slice(0, banner.indexOf('\r\n'));
    const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
    const code = m ? parseInt(m[1], 10) : 0;
    if (code !== 200) {
      proxySock.destroy();
      return cb(new Error(`proxy CONNECT failed: ${statusLine.trim()}`));
    }
    // Any bytes after the header belong to the tunneled stream — push back.
    const leftover = banner.slice(idx + 4);
    if (leftover.length) proxySock.unshift(Buffer.from(leftover, 'binary'));
    cb(null, proxySock);
  };
  proxySock.on('data', onData);
  proxySock.on('error', cb);
  proxySock.on('timeout', () => { proxySock.destroy(new Error('proxy connect timeout')); });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SOCKS5 handshake → returns a raw socket connected to target host:port
// ─────────────────────────────────────────────────────────────────────────────

function socks5Connect(proxy, targetHost, targetPort, timeoutMs, cb) {
  const proxyDNS = proxy.protocol === 'socks5h:'; // resolve at proxy
  const sock = net.connect({
    host: proxy.hostname,
    port: proxy.port || 1080,
    timeout: timeoutMs,
  });
  let stage = 'greet';
  let buf = Buffer.alloc(0);
  let called = false;
  const done = (err, s) => { if (!called) { called = true; cb(err, s); } };

  sock.on('connect', () => {
    // Greeting: ver=5, 1 method, 0x00 (no-auth) or 0x02 (user/pass)
    const methods = proxy.username ? [0x00, 0x02] : [0x00];
    sock.write(Buffer.from([0x05, methods.length, ...methods]));
  });

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 'greet') {
      if (buf.length < 2) return;
      const method = buf[1];
      buf = buf.slice(2);
      if (method === 0x02 && proxy.username) {
        const u = Buffer.from(decodeURIComponent(proxy.username));
        const p = Buffer.from(decodeURIComponent(proxy.password || ''));
        sock.write(Buffer.concat([
          Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p,
        ]));
        stage = 'auth';
        return;
      }
      if (method !== 0x00) { sock.destroy(); return done(new Error('socks5: no acceptable auth method')); }
      sendRequest();
      return;
    }
    if (stage === 'auth') {
      if (buf.length < 2) return;
      const ok = buf[1] === 0x00;
      buf = buf.slice(2);
      if (!ok) { sock.destroy(); return done(new Error('socks5: auth failed')); }
      sendRequest();
      return;
    }
    if (stage === 'request') {
      if (buf.length < 4) return;
      const rep = buf[1];
      if (rep !== 0x00) { sock.destroy(); return done(new Error(`socks5: connect rep=${rep}`)); }
      // Skip BND.ADDR/PORT; for our purposes we don't need leftover handling
      done(null, sock);
    }
  });

  function sendRequest() {
    stage = 'request';
    let addr;
    if (proxyDNS) {
      const h = Buffer.from(targetHost);
      addr = Buffer.concat([Buffer.from([0x03, h.length]), h]); // domain
    } else if (net.isIPv4(targetHost)) {
      addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(targetHost.split('.').map(Number))]);
    } else {
      const h = Buffer.from(targetHost);
      addr = Buffer.concat([Buffer.from([0x03, h.length]), h]);
    }
    const port = Buffer.alloc(2); port.writeUInt16BE(targetPort, 0);
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, port]));
  }

  sock.on('error', done);
  sock.on('timeout', () => { sock.destroy(new Error('socks5 connect timeout')); });
}

// ─────────────────────────────────────────────────────────────────────────────
//  https.Agent that routes every connection through the proxy
// ─────────────────────────────────────────────────────────────────────────────

function makeProxyAgent(proxyUrl, agentOpts = {}) {
  const proxy = new URL(proxyUrl);
  const scheme = proxy.protocol;
  const tunnel = (scheme === 'socks5:' || scheme === 'socks5h:') ? socks5Connect : httpConnect;

  class ProxyHttpsAgent extends https.Agent {
    createConnection(options, cb) {
      const host = options.host || options.hostname;
      const port = options.port || 443;
      const timeoutMs = options.timeout || 25000;
      tunnel(proxy, host, port, timeoutMs, (err, rawSock) => {
        if (err) return cb(err);
        // Wrap the tunneled socket in TLS for the target host.
        const tlsSock = tls.connect({
          socket: rawSock,
          servername: host,
          ...agentOpts,
        }, () => cb(null, tlsSock));
        tlsSock.on('error', cb);
      });
    }
  }
  const agent = new ProxyHttpsAgent({ keepAlive: false, maxSockets: 64 });
  agent.__proxyUrl = proxyUrl;
  return agent;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Preflight: download a tiny, always-public googleusercontent asset
// ─────────────────────────────────────────────────────────────────────────────

function testProxy(proxyUrl, timeoutMs = 12000) {
  // Google's default avatar — public, never expires, served from the same CDN.
  const url = 'https://lh3.googleusercontent.com/a/default-user=s96-c';
  return new Promise((resolve) => {
    let agent;
    try { agent = proxyUrl ? makeProxyAgent(proxyUrl) : https.globalAgent; }
    catch (e) { return resolve({ ok: false, error: 'bad proxy url: ' + e.message }); }
    const u = new URL(url);
    const req = https.get({
      host: u.host, path: u.pathname + u.search, agent,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const isJpeg = buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;
        resolve({
          ok: res.statusCode === 200 && buf.length > 100,
          status: res.statusCode, bytes: buf.length, jpeg: isJpeg,
        });
      });
      res.on('error', (e) => resolve({ ok: false, error: e.message }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

module.exports = { makeProxyAgent, testProxy, httpConnect, socks5Connect };
