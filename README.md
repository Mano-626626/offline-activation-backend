# Copy this file to ".env" and fill in real values.
# NEVER commit the real .env file to GitHub — it contains your bot's secret token.

# Get this from @BotFather in Telegram (the message it sent you when you
# created the bot with /newbot, or via /mybots -> API Token).
BOT_TOKEN=123456789:AAExampleTokenGoesHereReplaceThis

# Any long random string you make up yourself — used to verify that incoming
# webhook requests really come from Telegram. Generate one with:
#   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
WEBHOOK_SECRET=change-this-to-a-random-string

# The Mini App's origin(s), comma-separated, allowed to call this API.
# Example: https://your-username.github.io
# Use * only for local testing, never in production.
ALLOWED_ORIGINS=*

# Port the server listens on locally (hosting platforms usually set this for you).
PORT=3000

# Your backend's own public HTTPS URL once deployed (e.g. Render gives you one).
# Needed so this server can tell Wallet Pay where to send payment confirmations.
PUBLIC_URL=https://your-backend.onrender.com

# --- Crypto top-ups via Telegram Wallet (Wallet Pay) — optional ---
# Get this from https://pay.wallet.tg after creating a merchant account.
#
# IMPORTANT: whichever Telegram account creates that merchant store and
# generates this key is the account that actually RECEIVES the crypto funds.
# To have crypto payments land on @RutuLljko's Wallet, @RutuLljko must be the
# one who signs in at pay.wallet.tg and creates the merchant store — the API
# key it gives you then goes here. There's no way to redirect funds to a
# different account after the fact via config; it's tied to who owns the key.
#
# Leave blank to disable the crypto top-up option (Stars top-ups still work
# fine without this). See lib/walletpay.js for important caveats before
# accepting real crypto payments.
WALLET_PAY_API_KEY=
