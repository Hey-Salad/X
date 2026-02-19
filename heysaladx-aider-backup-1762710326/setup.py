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
