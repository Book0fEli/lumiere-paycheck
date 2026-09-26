# curl examples

```bash
# Score one endpoint (free)
curl "https://lumierepaycheck.org/v1/score?url=https://api.example.com/x"

# Spending rules (free): may I pay this endpoint 0.01 USDC to this wallet?
curl -X POST https://lumierepaycheck.org/v1/check-payment \
  -H "content-type: application/json" \
  -d '{"url":"https://api.example.com/x","amount":"10000","payTo":"0xSellerWallet","rules":{"maxAmount":"50000"}}'

# Top endpoints and catalog stats (free)
curl "https://lumierepaycheck.org/v1/leaderboard?limit=10"
curl "https://lumierepaycheck.org/v1/stats"

# Paid routes return 402 with a payment quote; pay with any x402 client.
curl -i "https://lumierepaycheck.org/v1/report?url=https://api.example.com/x"
```

PowerShell:

```powershell
Invoke-RestMethod "https://lumierepaycheck.org/v1/score?url=https://api.example.com/x"
Invoke-RestMethod -Method Post -Uri https://lumierepaycheck.org/v1/check-payment -ContentType "application/json" `
  -Body '{"url":"https://api.example.com/x","amount":"10000","payTo":"0xSellerWallet"}'
```
