"""Verify a Lumière PayCheck watch alert before trusting it.

Signature header: x-paycheck-signature: sha256=<hex>
  <hex> = HMAC-SHA256(raw_body) keyed with sha256(token) as a lowercase hex string.
"""
import hashlib
import hmac


def verify_alert(raw_body: bytes, signature_header: str, token: str) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    key = hashlib.sha256(token.encode()).hexdigest().encode()
    expected = hmac.new(key, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature_header[len("sha256="):], expected)


# Flask example:
#
# @app.post("/alerts")
# def alerts():
#     if not verify_alert(request.get_data(), request.headers.get("x-paycheck-signature", ""), WATCH_TOKEN):
#         return "bad signature", 401
#     alert = request.get_json()
#     print(alert["type"], alert["url"], alert.get("events"))
#     return "ok"
