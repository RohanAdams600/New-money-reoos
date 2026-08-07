"""Jarvis setup doctor.

Run this FIRST, before anything else:

    .venv\\Scripts\\activate
    python check_setup.py

It answers one question — "is this machine actually ready?" — and when the
answer is no it says which line to run to fix it. Nothing here touches your
desktop, your files, or the network. It only looks.
"""

from __future__ import annotations

import importlib
import platform
import sys
from pathlib import Path

# (import name, pip name, what it's for, is it required to boot)
DEPENDENCIES = [
    ("anthropic", "anthropic", "the brain (Claude)", True),
    ("speech_recognition", "SpeechRecognition", "hearing you", True),
    ("pyaudio", "PyAudio", "microphone access", True),
    ("pyttsx3", "pyttsx3", "the offline Windows voice", True),
    ("elevenlabs", "elevenlabs", "the ElevenLabs voice (optional at runtime)", False),
    ("pyautogui", "PyAutoGUI", "typing and hotkeys", True),
    ("pywinauto", "pywinauto", "opening and closing windows", True),
    ("psutil", "psutil", "seeing what's running", True),
    ("customtkinter", "customtkinter", "the HUD window", True),
    ("dotenv", "python-dotenv", "reading your .env file", True),
]

# PyAudio ships prebuilt wheels for 3.11/3.12/3.13 only. On 3.14 pip falls back
# to compiling from source, which needs the PortAudio C headers and a working
# MSVC toolchain — the failure most people hit as "pipwin install pyaudio".
MIN_PY = (3, 11)
MAX_PY = (3, 13)

OK = "  [ OK ]"
BAD = "  [FAIL]"
WARN = "  [warn]"


def heading(text: str) -> None:
    print(f"\n{text}\n" + "-" * len(text))


def check_python() -> bool:
    heading("1. Python version")
    v = sys.version_info
    print(f"  found: Python {v.major}.{v.minor}.{v.micro} ({platform.machine()})")
    if MIN_PY <= (v.major, v.minor) <= MAX_PY:
        print(f"{OK} 3.11-3.13 is what Jarvis needs.")
        return True
    print(f"{BAD} Jarvis needs Python 3.11, 3.12 or 3.13. You have {v.major}.{v.minor}.")
    print("       PyAudio has no prebuilt wheel outside that range, so the mic")
    print("       will refuse to install no matter what you try.")
    print("       Fix: install Python 3.12 from python.org, then rebuild the venv:")
    print("           py -3.12 -m venv .venv")
    print("           .venv\\Scripts\\activate")
    print("           pip install -r requirements.txt")
    return False


def check_platform() -> bool:
    heading("2. Operating system")
    print(f"  found: {platform.system()} {platform.release()}")
    if platform.system() == "Windows":
        print(f"{OK} Windows — pywinauto and the SAPI voices will work.")
        return True
    print(f"{WARN} Not Windows. The brain and the HUD run anywhere, but the")
    print("       desktop-control tools (pywinauto, SAPI voices) are Windows-only.")
    return True


def installed_version(pip_name: str) -> str:
    # Several of these (pyttsx3, python-dotenv) don't expose __version__, so ask
    # pip's own metadata rather than printing a useless "?".
    try:
        from importlib.metadata import version

        return version(pip_name)
    except Exception:
        return "?"


def check_dependencies() -> bool:
    heading("3. Packages")
    not_installed = []
    broken = []

    for module, pip_name, purpose, required in DEPENDENCIES:
        try:
            importlib.import_module(module)
        except ModuleNotFoundError as err:
            # Two very different problems wear the same exception. If the module
            # Python couldn't find IS this package, it just isn't installed. If
            # it's some other name, the package is installed but a piece it
            # depends on is absent — "pip install -r requirements.txt" won't fix
            # that, so don't say it will.
            if (err.name or "").split(".")[0] == module.split(".")[0]:
                print(f"{BAD if required else WARN} {pip_name:<18} not installed — {purpose}")
                if required:
                    not_installed.append(pip_name)
            else:
                print(f"{BAD if required else WARN} {pip_name:<18} installed, but won't load — {purpose}")
                print(f"         it needs '{err.name}', which isn't there")
                if required:
                    broken.append((pip_name, f"missing '{err.name}'"))
            continue
        except Exception as err:  # DLL load errors, display errors, bad configs
            print(f"{BAD if required else WARN} {pip_name:<18} installed, but won't load — {purpose}")
            print(f"         ({type(err).__name__}: {err})")
            if required:
                broken.append((pip_name, f"{type(err).__name__}: {err}"))
            continue

        print(f"{OK} {pip_name:<18} {installed_version(pip_name):<10} {purpose}")

    if not_installed:
        print(f"\n{BAD} Not installed: {', '.join(not_installed)}")
        print("       Fix:  pip install -r requirements.txt")
    if broken:
        print(f"\n{BAD} Installed but broken: {', '.join(n for n, _ in broken)}")
        print("       Reinstalling won't help — the package is there, something")
        print("       under it isn't. Show Claude the lines above.")

    return not (not_installed or broken)


def check_microphones() -> bool:
    heading("4. Microphones")
    try:
        import speech_recognition as sr

        names = sr.Microphone.list_microphone_names()
    except Exception as err:
        print(f"{BAD} Couldn't list microphones ({type(err).__name__}: {err})")
        return False

    if not names:
        print(f"{BAD} No microphone found. Plug one in, or check")
        print("       Settings > Privacy & security > Microphone and make sure")
        print('       "Let desktop apps access your microphone" is on.')
        return False

    print(f"{OK} {len(names)} input device(s):")
    for i, name in enumerate(names[:8]):
        print(f"         [{i}] {name}")
    if len(names) > 8:
        print(f"         ... and {len(names) - 8} more")
    return True


def check_voices() -> bool:
    heading("5. Voices")
    try:
        import pyttsx3

        engine = pyttsx3.init()
        voices = engine.getProperty("voices")
        engine.stop()
    except Exception as err:
        print(f"{BAD} Windows speech engine didn't start ({type(err).__name__}: {err})")
        return False

    if not voices:
        print(f"{BAD} No SAPI voices installed.")
        return False

    print(f"{OK} {len(voices)} offline voice(s) — Jarvis can talk with no API key:")
    for v in voices[:6]:
        print(f"         {v.name}")
    return True


def check_env() -> bool:
    heading("6. Your .env file")
    here = Path(__file__).resolve().parent
    env = here / ".env"
    if not env.exists():
        print(f"{WARN} No .env yet. Copy the example and paste your key in:")
        print("           copy .env.example .env")
        print("       Jarvis still starts without it, but the brain stays offline.")
        return True

    from dotenv import dotenv_values

    values = dotenv_values(env)
    key = (values.get("ANTHROPIC_API_KEY") or "").strip()
    if key:
        print(f"{OK} ANTHROPIC_API_KEY is set (ends ...{key[-4:]}).")
    else:
        print(f"{WARN} ANTHROPIC_API_KEY is blank — the brain will be offline.")

    eleven = (values.get("ELEVENLABS_API_KEY") or "").strip()
    print(
        f"{OK} ELEVENLABS_API_KEY set — Jarvis uses the ElevenLabs voice."
        if eleven
        else f"{WARN} ELEVENLABS_API_KEY blank — Jarvis uses the free Windows voice."
    )
    print(f"  model: {values.get('JARVIS_MODEL') or 'claude-sonnet-5 (default)'}")
    return True


def main() -> int:
    print("=" * 62)
    print("  JARVIS — setup check")
    print("=" * 62)

    # Ordered on purpose: a wrong Python version makes every later failure a
    # symptom of that one cause, so stop there rather than printing five
    # confusing errors.
    if not check_python():
        print("\nStop here and fix the Python version first.\n")
        return 1

    results = [
        check_platform(),
        check_dependencies(),
    ]
    if results[-1]:
        results.append(check_microphones())
        results.append(check_voices())
        results.append(check_env())

    heading("Result")
    if all(results):
        print("  Everything checks out. Step 1 is done.")
        print("  Tell Claude: \"Step 1 works, do Step 2.\"\n")
        return 0
    print("  Something above needs fixing. Work top to bottom — the first")
    print("  [FAIL] is usually the cause of the ones under it.\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
