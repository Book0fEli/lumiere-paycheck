"""Verify a Lumière PayCheck receipt OFFLINE before letting an agent pay.

    pip install requests cryptography
"""
import base64
import json
import os
import time

import requests
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

KEY_URL = os.environ.get("PAYCHECK_URL", "https://lumierepaycheck.org") + "/.well-known/paycheck-receipt-key.json"


def _b64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


_key = None


def public_key() -> Ed25519PublicKey:
    global _key
    if _key is None:
        jwk = requests.get(KEY_URL, timeout=10).json()["keys"][0]
        _key = Ed25519PublicKey.from_public_bytes(_b64u(jwk["x"]))
    return _key


def verify_receipt(receipt: str, url: str, amount: str, pay_to: str, network: str | None = None) -> dict:
    body, sig = receipt.split(".")
    public_key().verify(_b64u(sig), body.encode())  # raises InvalidSignature if forged
    p = json.loads(_b64u(body))
    if p["outcome"] != "allow":
        raise ValueError("receipt is not an allow")
    if p["exp"] < time.time():
        raise ValueError("receipt expired")
    # Bind the receipt to THIS payment.
    if p["url"] != url or p["amount"] != amount or (p.get("payTo") or "").lower() != pay_to.lower():
        raise ValueError("receipt doesn't match this payment")
    if network and p.get("network") and p["network"] != network:
        raise ValueError("receipt is for a different network")
    return p
