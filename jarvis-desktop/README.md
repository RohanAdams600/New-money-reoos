# Jarvis — Windows Desktop Assistant

Voice-controlled assistant that runs on your PC, talks back, and can open apps,
type, and manage windows — asking you first, every time.

**Step 1 of 6 is what's in this folder: the scaffold.** Nothing talks or clicks
yet. Get `check_setup.py` printing all green, then the next step gets built.

---

## Setup (do this on your Windows PC)

### 0. Get Python 3.12

Download it from <https://www.python.org/downloads/release/python-3129/> —
scroll to "Windows installer (64-bit)".

**On the first screen of the installer, tick "Add python.exe to PATH"** before
clicking Install. If you skip that, Windows says `python is not recognized`.

> Not 3.14. PyAudio — the package that reads your microphone — has no prebuilt
> version for 3.14, so pip tries to compile it and fails. That is the exact
> `pipwin install pyaudio` error. 3.11, 3.12 and 3.13 all work; 3.12 is the
> safe pick.

### 1. Open this folder in a terminal

Open the `jarvis-desktop` folder in File Explorer, click the address bar at the
top, type `cmd`, and press Enter. A black window opens, already in the right
place.

### 2. Run the setup script

```
setup.bat
```

That's it — it builds the virtual environment, installs all ten packages, and
runs the setup check. It takes two or three minutes the first time.

<details>
<summary>Or type the commands yourself</summary>

```
py -3.12 -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python check_setup.py
```
</details>

### 3. Add your key

```
copy .env.example .env
notepad .env
```

Paste your Anthropic key after `ANTHROPIC_API_KEY=` (get one at
<https://console.anthropic.com> → API Keys), save, close.

Leave `ELEVENLABS_API_KEY` blank for now — Jarvis will use the Windows voice
that's already on your PC, which costs nothing and works offline.

### 4. Check it

```
python check_setup.py
```

Every line should say `[ OK ]`. If one says `[FAIL]`, fix that one first — the
lines under it are usually just knock-on effects.

---

## Coming back later

The virtual environment has to be switched on each time you open a new
terminal:

```
.venv\Scripts\activate
```

You'll see `(.venv)` at the start of the line when it's on.

---

## What's here

```
jarvis-desktop/
├── requirements.txt    the ten packages, version-pinned
├── .env.example        template for your keys — copy to .env
├── .gitignore          keeps .env and .venv out of git
├── setup.bat           one-click: venv + install + check
├── check_setup.py      the doctor. Run this when anything breaks.
├── system_tools.py     Step 2 — the hands (apps, typing, windows, browser)
├── voice_engine.py     Step 3 — the ears and the mouth
├── brain.py            Step 4 — Claude, deciding which tool to use
├── app_ui.py           Step 5 — the HUD window
└── main.py             Step 6 — starts everything together
```

The five `.py` files after `check_setup.py` are placeholders. Opening one just
tells you it isn't built yet.

---

## Design notes

**Model.** `claude-sonnet-5`. The original spec said Claude 3.5 Sonnet, but
`claude-3-5-sonnet-20241022` was retired on 28 Oct 2025 and now returns a 404 —
building on it would fail on the first request. Sonnet 5 also rejects
`temperature`, `top_p` and `top_k` with a 400, so the brain won't send them.

**Safety is structural, not a instruction in a prompt.** Jarvis will only ever
be able to call the specific functions listed in `system_tools.py`. There is no
"run this command" tool and there won't be one: `os_type_text` plus a command
prompt plus Enter is arbitrary code execution, so Command Prompt, PowerShell,
Windows Terminal, WSL and the Run dialog are permanently excluded from the apps
Jarvis can open. It cannot read your saved passwords, cannot touch your card
details, cannot install anything, and cannot send email. With
`JARVIS_AUTO_APPROVE=false` (the default) it asks before every action that
changes anything.

**Voice degrades gracefully.** No ElevenLabs key means the Windows SAPI voice,
not an error. The app runs with zero optional keys.
