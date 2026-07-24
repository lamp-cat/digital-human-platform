# 保证从任意目录运行 pytest 时都能 import app
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
