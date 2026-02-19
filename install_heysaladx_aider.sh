#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIDER_DIR="${SCRIPT_DIR}/heysaladx-aider"
PYTHON=${PYTHON:-python3}

echo "🍳 Installing HeySaladX Aider..."

if [ -d "$AIDER_DIR" ]; then
  if [ -d "$AIDER_DIR/.git" ]; then
    echo "↻ Updating existing aider repository..."
    git -C "$AIDER_DIR" fetch --depth=1 origin main
    git -C "$AIDER_DIR" checkout main
    git -C "$AIDER_DIR" pull --ff-only
  else
    BACKUP_DIR="${AIDER_DIR}-backup-$(date +%s)"
    echo "⚠️  Directory already exists but isn't a git repo; moving to ${BACKUP_DIR}."
    mv "$AIDER_DIR" "$BACKUP_DIR"
    echo "➕ Cloning aider repository..."
    git clone https://github.com/paul-gauthier/aider.git "$AIDER_DIR"
  fi
else
  echo "➕ Cloning aider repository..."
  git clone https://github.com/paul-gauthier/aider.git "$AIDER_DIR"
fi

echo "📦 Ensuring setup.py is aligned with HeySaladX tooling..."
cat > "$AIDER_DIR/setup.py" <<'EOF'
from setuptools import setup, find_packages

setup(
    name="heysaladx-aider",
    version="0.1.0",
    description="HeySaladX Aider - AI pair programming with cooking flair",
    packages=find_packages(),
    entry_points={
        'console_scripts': [
            'heysaladx-aider=aider.main:main',
            'aider=aider.main:main',
        ],
    },
    install_requires=[
        "openai>=1.0.0",
        "requests",
        "click",
        "rich",
    ],
    python_requires=">=3.8",
)
EOF

echo "🔧 Installing in editable mode..."
"$PYTHON" -m pip install --upgrade pip setuptools wheel
"$PYTHON" -m pip install -e "$AIDER_DIR"

PYTHON_BIN="$($PYTHON -c 'import sys; print(sys.executable)')"
BIN_DIR="$(dirname "$PYTHON_BIN")"
if [ ! -f "$BIN_DIR/heysaladx-aider" ]; then
  echo "🛠️  Linking helper CLI..."
  ln -sf "$BIN_DIR/aider" "$BIN_DIR/heysaladx-aider"
fi

echo ""
echo "✅ HeySaladX Aider installed!"
echo ""
echo "Usage:"
echo "  heysaladx-aider [files] [options]"
echo ""
echo "Example:"
echo "  export DEEPSEEK_API_KEY=your_key"
echo "  heysaladx-aider src/server.py --message 'Add authentication middleware'"
