from __future__ import annotations

import argparse
import platform
import subprocess
import sys
from pathlib import Path


APP_NAME = "BeamMeUp-Helper"
HELPER_DIR = Path(__file__).resolve().parent
ENTRYPOINT = HELPER_DIR / "server.py"
DIST_DIR = HELPER_DIR / "dist"
BUILD_DIR = HELPER_DIR / "build"


def executable_name(system: str | None = None) -> str:
    return APP_NAME + ".exe" if (system or platform.system()) == "Windows" else APP_NAME


def build_pyinstaller_args(
    python_executable: str = sys.executable,
    system: str | None = None,
) -> list[str]:
    target_system = system or platform.system()
    args = [
        python_executable,
        "-m",
        "PyInstaller",
        "--clean",
        "--noconfirm",
        "--onefile",
        "--name",
        APP_NAME,
        "--distpath",
        str(DIST_DIR),
        "--workpath",
        str(BUILD_DIR),
        "--specpath",
        str(BUILD_DIR),
        "--collect-submodules",
        "bless",
        "--collect-submodules",
        "websockets",
    ]
    if target_system == "Windows":
        args.extend(["--hidden-import", "pysetupdi", "--collect-submodules", "pysetupdi"])
    args.append(str(ENTRYPOINT))
    return args


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build the Beam Me Up ARQ helper executable.")
    parser.add_argument(
        "--print-command",
        action="store_true",
        help="Print the PyInstaller command without running it.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    command = build_pyinstaller_args()
    if args.print_command:
        print(" ".join(command))
        return 0

    print(f"Building {APP_NAME} for {platform.system()}...")
    subprocess.run(command, check=True)
    output = DIST_DIR / executable_name()
    print(f"Built {output}")
    return 0


def testBuildCommandIncludesPlatformDependencies() -> bool:
    windows_args = build_pyinstaller_args("python", "Windows")
    linux_args = build_pyinstaller_args("python", "Linux")
    passed = (
        "--onefile" in windows_args
        and str(ENTRYPOINT) in windows_args
        and "pysetupdi" in windows_args
        and "pysetupdi" not in linux_args
        and executable_name("Windows").endswith(".exe")
        and executable_name("Darwin") == APP_NAME
    )
    print("helper build command platform deps:", "PASS" if passed else "FAIL")
    return passed


if __name__ == "__main__":
    raise SystemExit(main())
