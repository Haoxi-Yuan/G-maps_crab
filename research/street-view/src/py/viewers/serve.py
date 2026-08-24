#!/usr/bin/env python3
"""Local HTTP server for the megafused 3D viewer.

The Three.js viewer loads its point-cloud data via fetch() — browsers block
that on file:// URLs, so we need a real HTTP server. This wraps the Python
stdlib http.server with CORS headers, sensible MIME types, and a printed
URL pointing straight at the megafused viewer.

Usage:
  python3 src/py/viewers/serve.py data/raw/google_maps/spatial/<site>/<run-id>/   [--port 8765]
"""
import argparse
import http.server
import os
import socketserver
import sys


class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def guess_type(self, path):
        # Tell the browser "binary" so fetch().arrayBuffer() works cleanly
        for ext in ('.f32', '.u8', '.u16', '.bin'):
            if path.endswith(ext):
                return 'application/octet-stream'
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # Quieter than default; keeps the terminal usable
        sys.stderr.write(f'  {self.address_string()} - {fmt % args}\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('serve_dir', help='Directory to serve (typically the run dir)')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()

    serve_dir = os.path.abspath(args.serve_dir)
    if not os.path.isdir(serve_dir):
        print(f'Not a directory: {serve_dir}', file=sys.stderr)
        sys.exit(2)

    os.chdir(serve_dir)
    print(f'Serving {serve_dir}')
    print(f'  http://{args.host}:{args.port}/')

    candidates = ['3d_viewer_megafused.html', '3d_viewer_combined.html']
    for c in candidates:
        if os.path.exists(c):
            print(f'  http://{args.host}:{args.port}/{c}')
    print('  (Ctrl+C to stop)')
    print()

    with socketserver.ThreadingTCPServer((args.host, args.port), CORSHandler) as httpd:
        httpd.allow_reuse_address = True
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nstopped.')


if __name__ == '__main__':
    main()
