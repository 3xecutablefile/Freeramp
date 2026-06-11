#!/usr/bin/env python3
import os, sys
from setuptools import setup

HERE = os.path.dirname(os.path.abspath(__file__))

DATA_FILES = [
    ('ui', [
        os.path.join(HERE, 'Resources', 'ui', 'index.html'),
        os.path.join(HERE, 'Resources', 'ui', 'renderer.js'),
    ]),
]

OPTIONS = {
    'argv_emulation': False,
    'packages': ['webview'],
    'site_packages': True,
    'plist': {
        'CFBundleName': 'VinciRamp',
        'CFBundleDisplayName': 'VinciRamp',
        'CFBundleIdentifier': 'com.vinciramp.app',
        'CFBundleVersion': '1',
        'CFBundleShortVersionString': '1.0',
        'CFBundleExecutable': 'VinciRamp',
        'NSHighResolutionCapable': True,
        'NSHumanReadableCopyright': 'VinciRamp — speed curve editor for DaVinci Resolve',
    },
    'iconfile': None,
}

setup(
    app=['main.py'],
    data_files=DATA_FILES,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
