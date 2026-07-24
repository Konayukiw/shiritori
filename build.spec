# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for しりとりBot

Build command:
    pyinstaller build.spec --clean --noconfirm

Output:
    dist/ShiritoriBot.exe

Notes:
- Dictionary SQLite files are downloaded/built on first run (not bundled).
- Flet desktop client is resolved at runtime:
    1. vendor/flet-windows.zip if present (bundled offline client)
    2. otherwise ~/.flet cache / GitHub download on first launch
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

PROJECT_ROOT = Path(".").resolve()


def _safe_submodules(package: str) -> list[str]:
    """Collect submodules, skipping optional test extras that pull heavy deps."""
    try:
        mods = collect_submodules(package)
    except Exception:
        return [package]
    return [
        m
        for m in mods
        if not m.startswith(f"{package}.testing")
        and ".tests" not in m
        and not m.endswith(".tests")
    ]


# Real non-code package data only (collect_all would also dump .py as datas).
flet_datas = collect_data_files("flet")
flet_desktop_datas = collect_data_files("flet_desktop")

# Optional offline Flet Windows client:
# place the release artifact at vendor/flet-windows.zip
# (from https://github.com/flet-dev/flet/releases → flet-windows.zip).
# flet_desktop looks for it under flet_desktop/app/<artifact>.
extra_datas: list[tuple[str, str]] = []
vendor_client = PROJECT_ROOT / "vendor" / "flet-windows.zip"
if vendor_client.is_file():
    extra_datas.append((str(vendor_client), str(Path("flet_desktop") / "app")))

hiddenimports = sorted(
    set(
        _safe_submodules("flet")
        + _safe_submodules("flet_desktop")
        + [
            # App package
            "shiritori_bot",
            "shiritori_bot.config",
            "shiritori_bot.core",
            "shiritori_bot.core.bot_word_selector",
            "shiritori_bot.core.kana_utils",
            "shiritori_bot.core.opponent_word_validator",
            "shiritori_bot.core.rules",
            "shiritori_bot.game",
            "shiritori_bot.game.session",
            "shiritori_bot.gui",
            "shiritori_bot.gui.app",
            # Direct deps
            "jaconv",
            # Flet runtime deps that analysis can miss under excludes/pruning
            "httpx",
            "httpcore",
            "anyio",
            "anyio._backends._asyncio",
            "sniffio",
            "h11",
            "certifi",
            "idna",
            "msgpack",
            "oauthlib",
            "repath",
            "rich",
            "rich.progress",
            "six",
            "six.moves",
        ]
    )
)

a = Analysis(
    ["bot/desktop/main.py"],
    pathex=[str(PROJECT_ROOT)],
    binaries=[],
    datas=flet_datas + flet_desktop_datas + extra_datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    excludes=[
        # Heavy / unused stacks that often get pulled transitively via optional imports
        "tkinter",
        "matplotlib",
        "scipy",
        "numpy",
        "pandas",
        "PIL",
        "cv2",
        "skimage",
        "notebook",
        "jupyter",
        "jupyter_client",
        "jupyter_core",
        "IPython",
        "ipykernel",
        "ipywidgets",
        "jedi",
        "parso",
        "debugpy",
        "tornado",
        "zmq",
        "pyzmq",
        "pytest",
        "nose",
        "unittest",
        "flet.testing",
        # Build/dev tools — not needed at runtime when flet_desktop is bundled
        "setuptools",
        "pip",
        "wheel",
        # Unused optional parsers / image stacks
        "lxml",
        "beautifulsoup4",
        "pycparser",
    ],
    runtime_hooks=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="ShiritoriBot",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
