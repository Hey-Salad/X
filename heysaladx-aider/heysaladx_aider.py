#!/usr/bin/env python3
"""
HeySaladX Aider - Enhanced version of Aider with HeySaladX branding and features.
"""

import os
import sys
from pathlib import Path

# Add the aider package to the path
aider_path = Path(__file__).parent / "aider"
sys.path.insert(0, str(aider_path))

from aider.main import main as aider_main
from aider.ui import CookingSpinner
import threading
import time

def heysaladx_banner():
    """Display HeySaladX branded banner."""
    banner = """
    🍅 HeySaladX Aider 🍳
    AI-Powered Code Assistant with Cooking Flair!
    
    Features:
    • Cooking-themed progress indicators
    • DeepSeek integration (recommended)
    • HeySaladX brand colors
    • Enhanced terminal UI
    
    Get started: heysaladx-aider --help
    """
    print(banner)

def main():
    """HeySaladX Aider main entry point."""
    if len(sys.argv) == 1 or "--help" in sys.argv or "-h" in sys.argv:
        heysaladx_banner()
    
    # Set default to DeepSeek if no model specified
    if not any(arg.startswith("--model") for arg in sys.argv):
        sys.argv.append("--model")
        sys.argv.append("deepseek-chat")
    
    aider_main()

if __name__ == "__main__":
    main()
