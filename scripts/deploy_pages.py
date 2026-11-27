"""Publish the viewer to GitHub Pages: docs/ (app + data/) as a single commit on the gh-pages branch.

    python scripts\\deploy_pages.py

main never holds the game data (docs/data/ is git-ignored there); the gh-pages branch holds only the built site and
is replaced by one fresh commit on every deploy, so its history stays one commit long. Pages serves that branch.
Run scripts\\build_viewer.py first so docs/data/ is current.
"""
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "docs")
AUTHOR = ["-c", "user.name=Raven", "-c", "user.email=47097820+ArmoredRaven17@users.noreply.github.com"]


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True)


def main():
    if not os.path.isfile(os.path.join(DOCS, "data", "index.json")):
        sys.exit("docs/data is missing: run scripts\\build_viewer.py first")
    remote = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, check=True,
                            capture_output=True, text=True).stdout.strip()
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, check=True,
                          capture_output=True, text=True).stdout.strip()
    tmp = tempfile.mkdtemp(prefix="crv-pages-")
    try:
        site = os.path.join(tmp, "site")
        shutil.copytree(DOCS, site, ignore=shutil.ignore_patterns("__pycache__"))
        open(os.path.join(site, ".nojekyll"), "w").close()      # serve files as they are (no Jekyll processing)
        git("init", "-q", "-b", "gh-pages", cwd=site)
        git("add", "-A", cwd=site)
        git(*AUTHOR, "commit", "-q", "-m", f"Deploy viewer from main {head}", cwd=site)
        git("push", "-f", remote, "gh-pages", cwd=site)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("deployed main", head, "to gh-pages")


if __name__ == "__main__":
    main()
