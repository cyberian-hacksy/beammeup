from __future__ import annotations

import argparse
import importlib.util
import platform
import subprocess
import sys
from pathlib import Path


APP_NAME = "BeamMeUp-Helper"
HELPER_DIR = Path(__file__).resolve().parent
ENTRYPOINT = HELPER_DIR / "server.py"
DIST_DIR = HELPER_DIR / "dist"
BUILD_DIR = HELPER_DIR / "build"
BUILD_REQUIREMENTS = HELPER_DIR / "requirements-build.txt"


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


def missing_build_dependencies(system: str | None = None) -> list[str]:
    required = ["PyInstaller"]
    if (system or platform.system()) == "Windows":
        required.append("pysetupdi")
    return [name for name in required if importlib.util.find_spec(name) is None]


def format_missing_build_dependencies_message(
    missing: list[str],
    python_executable: str = sys.executable,
) -> str:
    names = ", ".join(missing)
    return (
        f"Missing helper build dependencies: {names}\n"
        "Install the build requirements in this Python environment, then rerun the build:\n"
        f"{python_executable} -m pip install -r {BUILD_REQUIREMENTS}"
    )


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

    missing = missing_build_dependencies()
    if missing:
        print(format_missing_build_dependencies_message(missing), file=sys.stderr)
        return 2

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


def testMissingBuildDependencyMessageMentionsInstallCommand() -> bool:
    message = format_missing_build_dependencies_message(["PyInstaller"], "python")
    passed = (
        "PyInstaller" in message
        and "requirements-build.txt" in message
        and "python -m pip install" in message
    )
    print("helper build missing dependency message:", "PASS" if passed else "FAIL")
    return passed


if __name__ == "__main__":
    raise SystemExit(main())
