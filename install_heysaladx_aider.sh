#!/bin/bash

echo "🍳 Installing HeySaladX Aider..."

# Clone the original aider
cd ~/heysalad-mcp
if [ ! -d "heysaladx-aider" ]; then
    git clone https://github.com/paul-gauthier/aider.git heysaladx-aider
fi

cd heysaladx-aider

# Create a simple setup.py for now since we don't have the full aider structure
cat > setup.py << 'EOF'
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

# Install in development mode
pip install -e .

echo "✅ HeySaladX Aider installed!"
echo ""
echo "Usage:"
echo "  heysaladx-aider [files] [options]"
echo ""
echo "Example:"
echo "  export DEEPSEEK_API_KEY=your_key"
echo "  heysaladx-aider src/server.py --message 'Add authentication middleware'"
