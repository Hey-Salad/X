#!/bin/bash

echo "🍳 Installing HeySaladX Aider..."

# Clone the original aider
cd ~/heysalad-mcp
if [ ! -d "heysaladx-aider" ]; then
    git clone https://github.com/paul-gauthier/aider.git heysaladx-aider
fi

cd heysaladx-aider

# Apply our modifications (you would have the actual patch files)
# This is where you'd apply the changes we discussed

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
