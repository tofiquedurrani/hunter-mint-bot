# 🎯 Hunter Mint Bot — Fixed

Telegram NFT sniping bot with **FREE MINT** support.

## ✅ Kya Fix Hua

| Issue | Fix |
|---|---|
| Free mint pe fees aati thi | Ab direct contract `mint()` call hoti hai |
| Contract address nahi milta tha | OpenSea API se auto-detect hota hai |
| Sirf secondary listings check hoti thi | Free mint alag mode hai |

## 🆓 Free Mint Kaise Kaam Karta Hai

```
Pehle (broken):
  User → OpenSea listings check → koi listing nahi → ❌

Ab (fixed):
  User → OpenSea se contract address auto-detect
       → "Free Mint" button dikhta hai
       → Direct contract ka mint() call
       → Sirf gas fee lagti hai → ✅
```

Bot in function signatures try karta hai (ek ke baad ek):
- `mint(uint256 quantity)`
- `mint()`
- `publicMint(uint256 quantity)`
- `publicMint()`
- `freeMint(uint256 quantity)`
- `freeMint()`
- `claim(uint256 quantity)`
- `claim()`
- `safeMint(address to)`

## 🚀 VPS pe Deploy Karo

```bash
# 1. Files copy karo VPS pe
scp -r hunter-mint-bot/ ubuntu@YOUR_VPS_IP:~/

# 2. VPS pe login karo
ssh ubuntu@YOUR_VPS_IP

# 3. Dependencies install karo
cd hunter-mint-bot
npm install

# 4. .env file banao
cp .env.example .env
nano .env   # apni values dalo

# 5. Start karo
node index.js

# Background mein run karne ke liye (PM2):
npm install -g pm2
pm2 start index.js --name hunter-bot
pm2 save
pm2 startup
```

## 📋 .env Configuration

```env
TELEGRAM_BOT_TOKEN=    # @BotFather se
ALLOWED_USERS=         # Apna Telegram ID (@userinfobot se)
OPENSEA_API_KEY=       # opensea.io/reference/api-keys
WALLET_PRIVATE_KEY=    # MetaMask export private key
ETH_RPC_URL=           # Alchemy ya Infura URL
GAS_PRIORITY_FEE_GWEI=10
GAS_LIMIT_MULTIPLIER=1.3
POLL_INTERVAL_MS=2000
```

## 📱 Bot Commands

| Command | Kaam |
|---|---|
| `/start` | Naya hunt shuru karo |
| `/status` | Monitor ka status |
| `/stop` | Monitor band karo |
| `/wallet` | Balance aur address |

## ⚡ Flow

1. OpenSea collection URL bhejo
2. Bot contract address auto-detect karta hai
3. Agar free mint hai → `🆓 Free Mint (direct contract)` button dikhta hai
4. Quantity choose karo → Free Mint press karo
5. Bot seedha contract call karta hai — sirf gas pay karo
