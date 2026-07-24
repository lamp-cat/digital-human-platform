"""数字人平台 API（V1）。

环境兼容说明：本机 Python 为 3.11.0b2（beta），其 typing 模块在计算
`__parameters__` 时与 typing_extensions(>=4.6) 的泛型别名实现不兼容，
导致 SQLAlchemy `class IteratorResult(Result[_TP])` 在类创建时抛出
"not a generic class"。这里在导入任何第三方库之前，将泛型参数数量
检查放宽（仅跳过 elen==0 的误报分支），不影响正常运行时行为。
"""

import typing as _typing

import typing_extensions as _te  # noqa: F401  确保 te 自身的补丁先就绪

_orig_check_generic = _typing._check_generic


def _lenient_check_generic(cls, parameters, elen=0):
    if not elen:
        return  # 3.11.0b2 beta 的误报，跳过
    return _orig_check_generic(cls, parameters, elen)


_typing._check_generic = _lenient_check_generic

__version__ = "1.0.0"
