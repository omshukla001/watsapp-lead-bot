# WhatsApp AI Lead Qualification Bot (Termux + Baileys)

AI-powered WhatsApp lead qualification bot for Bangalore engineering college
admissions (RVCE, BMSCE, PES, MSRIT). Runs entirely on your phone via Termux,
uses your existing WhatsApp number through Baileys (linked-device protocol),
and does conversation + scoring with Cerebras (LLaMA / Qwen). Leads go into
MongoDB Atlas.

No Facebook account, no Twilio, no ngrok needed.

## What it uses

- **Baileys** — connects to WhatsApp via QR code (like WhatsApp Web)
- **Cerebras AI** — LLM for conversation, language detection, lead scoring
- **MongoDB Atlas** — free cloud Mongo (no local install needed)
- **Termux:API** — phone vibration + notification on new leads
- **Express** — local admin dashboard at `localhost:3000/admin`

## Folder structure

```
whatsapp-lead-bot/
├── server.js                        # entry: starts Baileys + admin dashboard
├── package.json
├── .env.example
├── config/db.js
├── controllers/chatController.js    # conversation orchestration + scoring
├── services/
│   ├── baileysService.js            # WhatsApp connection (QR scan, send/receive)
│   ├── aiService.js                 # Cerebras LLM calls
│   ├── languageService.js           # English / Hindi / Hinglish detection
│   └── termuxNotify.js              # Android notification + vibration
├── routes/admin.js                  # /admin dashboard + JSON + CSV
├── models/
│   ├── leadModel.js
│   └── sessionModel.js
├── utils/parser.js
├── utils/logger.js
└── auth/                            # WhatsApp session (auto-created, gitignored)
```

## Setup on Termux (Android)

### 1. Install Termux + Termux:API

- Get **Termux** from F-Droid (the Play Store version is outdated): https://f-droid.org/packages/com.termux/
- Get **Termux:API** from the same source: https://f-droid.org/packages/com.termux.api/
- Open Termux once so it sets itself up.

### 2. Install dependencies inside Termux

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs git nano termux-api
termux-setup-storage   # tap "Allow" on the popup
```

Verify:
```bash
node -v && npm -v
termux-vibrate -d 200   # phone should buzz
```

### 3. Clone the repo

```bash
cd ~
git clone https://github.com/<your-username>/whatsapp-lead-bot.git
cd whatsapp-lead-bot
```

### 4. Install Node dependencies

```bash
npm install
```

### 5. Set up MongoDB Atlas (free)

1. Sign up at https://www.mongodb.com/cloud/atlas
2. Create a free **M0** cluster (any region near India is fine)
3. **Database Access** → add a user (username + password)
4. **Network Access** → Add IP → "Allow access from anywhere" (`0.0.0.0/0`)
5. **Connect → Drivers → Node.js** → copy the connection string

### 6. Get a Cerebras API key

1. Sign up at https://cloud.cerebras.ai
2. Generate an API key from the dashboard

### 7. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in:
```
MONGO_URI=mongodb+srv://<user>:<pass>@cluster0.xxxxx.mongodb.net/whatsapp_lead_bot
CEREBRAS_API_KEY=your_cerebras_api_key
ADMIN_PASSWORD=pick_anything
```

Save with `Ctrl+O` → Enter → `Ctrl+X`.

### 8. Run the bot — first time

```bash
npm start
```

You'll see a **QR code** in the terminal:

```
========================================
  Scan this QR with WhatsApp on your phone
  WhatsApp -> Settings -> Linked Devices -> Link a Device
========================================

█▀▀▀▀▀▀▀█▀▀▀█...
```

On your phone, in **WhatsApp**:
- Tap **Settings** → **Linked Devices** → **Link a Device**
- Point the camera at the QR in Termux

Once linked, you'll see:
```
[INFO] Baileys connected to WhatsApp
[INFO] Admin dashboard: http://localhost:3000/admin
```

The bot is now live on your WhatsApp number.

### 9. Test it

Send "hi" to your **own number from another phone** (or ask a friend). The bot
will reply through your WhatsApp.

You can also open the admin dashboard in your phone's browser:
- http://localhost:3000/admin
- Username: anything, Password: whatever you set as `ADMIN_PASSWORD`

### 10. Keep it running in the background

Termux will kill the process if you close it. To keep it alive:

```bash
# In Termux, acquire a wakelock so Android doesn't kill the process
termux-wake-lock

# Then start the bot
npm start
```

To stop: `Ctrl+C`, then `termux-wake-unlock`.

For auto-restart on crash, use `nohup`:
```bash
nohup npm start > logs/bot.out 2>&1 &
```

## How the bot works

1. User messages your WhatsApp number → Baileys delivers it to the bot
2. Bot detects the language (English / Hindi / Hinglish) on first message
3. Cerebras LLM walks the user through 5 questions:
   - Course interest (BTech, BCA, etc.)
   - Colleges in Bangalore
   - Admission timeline
   - Entrance exams (KCET, COMEDK, JEE)
   - Name
4. Once collected, the lead is **scored** (HIGH / MEDIUM / LOW) and saved to MongoDB
5. Your phone **vibrates and shows a notification** for each new lead
6. View all leads at `localhost:3000/admin`

## Re-linking WhatsApp

If WhatsApp logs the bot out (e.g. you unlinked the device manually):

```bash
npm run reset-auth   # deletes the auth/ folder
npm start            # scan a fresh QR
```

## Troubleshooting

**"Cannot find module '@whiskeysockets/baileys'"**
→ Run `npm install` again.

**QR keeps refreshing / phone won't scan**
→ Increase Termux font size (long-press screen → Style) or open Termux on a tablet.

**"Bad MAC" / decryption errors**
→ Delete `auth/` and re-link: `npm run reset-auth && npm start`.

**No vibration on new lead**
→ Make sure the **Termux:API** app is installed (not just the `termux-api` package).
   Test with `termux-vibrate -d 500`. If that fails, the app isn't connected.

**MongoDB connection refused**
→ Atlas Network Access must allow `0.0.0.0/0`. Phones don't have static IPs.

**Bot disconnects when phone screen turns off**
→ Run `termux-wake-lock` before `npm start`. Also disable battery optimization
   for Termux in Android settings.

## Caveats

- Baileys uses an **unofficial** WhatsApp protocol. For low-volume personal use
  this is fine; for mass cold-outreach WhatsApp may ban the number.
- The bot replies from **your personal WhatsApp number** — make sure that's what
  you want before scanning the QR.
- Your phone's WhatsApp keeps working alongside the bot (they're "linked devices",
  same as if you used WhatsApp Web on a laptop).

## Lead schema (MongoDB)

```json
{
  "name": "Aman",
  "phone_number": "+919876543210",
  "course_interest": "BTech",
  "colleges_interested": ["RVCE", "BMSCE"],
  "budget": "₹12L",
  "admission_timeline": "within 2 months",
  "exam_status": "KCET, COMEDK",
  "lead_score": "HIGH",
  "probability": 0.88,
  "summary": "Student interested in BTech, targeting RVCE and BMSCE...",
  "language_mode": "HINGLISH",
  "created_at": "2026-05-03T..."
}
```
