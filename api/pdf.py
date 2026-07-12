import json
import os
from http.server import BaseHTTPRequestHandler

from server.python_bridge import generate_bill, parse_passbook


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        expected = os.environ.get("BRIDGE_SECRET") or os.environ.get("JWT_SECRET")
        supplied = self.headers.get("X-Bridge-Secret", "")
        if not expected or supplied != expected:
            return self._json(401, {"ok": False, "error": "Unauthorized PDF service request."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length) or b"{}")
            action, payload = request.get("action"), request.get("payload") or {}
            if action == "parse_passbooks":
                result = {"passbooks": [parse_passbook(item) for item in payload.get("files", [])]}
            elif action == "generate_bill":
                result = generate_bill(payload)
            else:
                raise ValueError(f"Unknown PDF action: {action}")
            return self._json(200, {"ok": True, "result": result})
        except Exception as exc:
            return self._json(500, {"ok": False, "error": str(exc)})

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
