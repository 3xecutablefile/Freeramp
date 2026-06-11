#!/usr/bin/env python3
import os
from setuptools import setup

HERE = os.path.dirname(os.path.abspath(__file__))
APP_PATH = os.path.join(HERE, 'Resources', 'app.py')

DATA_FILES = [
    ('ui', [
        os.path.join(HERE, 'Resources', 'ui', 'index.html'),
        os.path.join(HERE, 'Resources', 'ui', 'renderer.js'),
    ]),
]

OPTIONS = {
    'argv_emulation': False,
    'packages': ['webview'],
    'includes': ['apply_curve'],
    'excludes': ['tkinter', 'PyQt5', 'PySide2', 'PySide6', 'wx'],
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
}

setup(
    app=[APP_PATH],
    data_files=DATA_FILES,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
