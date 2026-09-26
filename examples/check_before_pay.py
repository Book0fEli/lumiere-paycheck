"""Before paying any x402 endpoint, ask Lumière PayCheck whether this exact
payment (endpoint + amount + payout wallet) is safe.

    pip install requests
    python examples/check_before_pay.py https://api.example.com/x 10000 0xSellerWallet
"""
import sys
import requests

API = "https://lumierepaycheck.org"


def check_payment(url, amount=None, pay_to=None, max_amount=None):
    body = {"url": url, "amount": amount, "payTo": pay_to}
    if max_amount:
        body["rules"] = {"maxAmount": max_amount}
    r = requests.post(f"{API}/v1/check-payment", json=body, timeout=10)
    if r.status_code == 429:
        raise RuntimeError("rate limited: slow down or use /v1/score/batch")
    r.raise_for_status()
    return r.json()


if __name__ == "__main__" and len(sys.argv) > 1:
    url, amount, pay_to = (sys.argv[1:] + [None, None])[:3]
    d = check_payment(url, amount, pay_to, max_amount="50000")  # never more than $0.05
    print("allowed" if d["allow"] else "denied", "-", "; ".join(d["reasons"]))
    if d.get("observed"):
        print("monitored quote:", d["observed"])
