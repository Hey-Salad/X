#!/usr/bin/env python3
"""HeySaladX Aider - Enhanced version of Aider with HeySaladX branding."""

import os
import sys
import argparse
import logging

def parse_args():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description="HeySaladX Aider - AI pair programming")
    parser.add_argument("files", nargs="*", help="Files to edit")
    parser.add_argument("--message", "-m", help="Message describing the change")
    parser.add_argument("--deepseek-api-key", help="DeepSeek API key")
    parser.add_argument("--openai-api-key", help="OpenAI API key")
    parser.add_argument("--model", default="deepseek-chat", help="Model to use")
    parser.add_argument("--version", action="store_true", help="Show version")
    parser.add_argument("--verbose", action="store_true", help="Verbose output")
    return parser.parse_args()

def setup_logging(args):
    """Setup logging based on verbosity."""
    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=level, format="%(message)s")

def create_client(args):
    """Create a client for the selected model."""
    # This is a simplified version - in a real implementation, 
    # we'd have proper client initialization
    class SimpleClient:
        def run(self):
            print("🍳 HeySaladX Aider is cooking up some code...")
            if args.message:
                print(f"Message: {args.message}")
            if args.files:
                print(f"Files: {', '.join(args.files)}")
            print("\nThis is a simplified version. Full implementation would:")
            print("1. Use DeepSeek API for code generation")
            print("2. Implement cooking-themed spinner")
            print("3. Apply changes to files")
            print("4. Provide rich terminal UI")
    
    return SimpleClient()

def main():
    """Main entry point for the HeySaladX Aider command line interface."""
    args = parse_args()
    setup_logging(args)

    if args.version:
        print(f"heysaladx-aider 0.1.0")
        return

    # Check for API keys - prioritize DeepSeek, fallback to others
    has_deepseek = args.deepseek_api_key or os.getenv("DEEPSEEK_API_KEY")
    has_openai = args.openai_api_key or os.getenv("OPENAI_API_KEY")
    has_hf = os.getenv("HF_TOKEN")
    
    if not any([has_deepseek, has_openai, has_hf]):
        print("No API key found. Set one of:")
        print("  DEEPSEEK_API_KEY (recommended) - Get from: https://platform.deepseek.com/api_keys")
        print("  OPENAI_API_KEY")
        print("  HF_TOKEN")
        sys.exit(1)

    try:
        client = create_client(args)
        client.run()
    except KeyboardInterrupt:
        print("\n👋 Exiting HeySaladX Aider...")
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
