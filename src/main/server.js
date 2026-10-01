'use strict';

// The local endpoint the agents report to.
//
// It listens on 127.0.0.1 only and accepts a request only when it
//   - carries honeybee's random token in the X-Honeybee header,
//   - names 127.0.0.1 or localhost as its host (no DNS-rebinding tricks),
//   - has no Origin header (so no web page can post to it).
//
// Hook requests are answered at once with an empty 200 - which both agents
// read as "no decision" - and processed afterwards, so honeybee can never hold
// up, block or steer an agent.

const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 4 * 1024 * 1024;

const ROUTES = new Set(['/claude/hook', '/claude/statusline', '/codex/hook', '/health']);

function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {object} opts.handlers  { claudeHook(p), claudeStatusLine(p) -> string, codexHook(p) }
 * @param {(msg: string) => void} [opts.log]
 */
function createServer({ token, handlers, log = () => {} }) {
  let boundPort = null;
  const stats = { accepted: 0, rejected: 0, lastAt: null };

  const server = http.createServer((req, res) => {
    const reject = (code, why) => {
      stats.rejected += 1;
      log(`rejected ${req.method} ${req.url}: ${why}`);
      res.writeHead(code, { 'Content-Type': 'text/plain' });
      res.end();
    };

    const route = String(req.url || '').split('?')[0];
    const host = String(req.headers.host || '').toLowerCase();
    if (req.headers.origin) return reject(403, 'browser origin');
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return reject(403, `host ${host}`);
    if (!tokenMatches(req.headers['x-honeybee'], token)) return reject(401, 'bad token');
    if (!ROUTES.has(route)) return reject(404, 'unknown route');

    if (route === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'honeybee', ok: true }));
      return;
    }
    if (req.method !== 'POST') return reject(405, 'not POST');

    const chunks = [];
    let size = 0;
    let oversize = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        oversize = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {});
    req.on('end', () => {
      stats.accepted += 1;
      stats.lastAt = Date.now();
      let payload = null;
      if (!oversize) {
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { payload = null; }
      } else {
        log(`ignored a ${size}-byte ${route} body`);
      }

      if (route === '/claude/statusline') {
        let text = '';
        try { text = payload ? String(handlers.claudeStatusLine(payload) || '') : ''; } catch (err) { log(`status line: ${err.message}`); }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(text);
        return;
      }

      // An empty 200: "no decision" to Claude Code, and no output for Codex
      // to add to the model's context.
      res.writeHead(200);
      res.end();
      if (!payload) return;
      setImmediate(() => {
        try {
          if (route === '/claude/hook') handlers.claudeHook(payload);
          else handlers.codexHook(payload);
        } catch (err) {
          log(`${route}: ${err.stack || err.message}`);
        }
      });
    });
  });

  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;

  return {
    stats,
    get port() { return boundPort; },
    listen(port) {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          boundPort = server.address().port;
          resolve(boundPort);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    }
  };
}

module.exports = { createServer, MAX_BODY };
