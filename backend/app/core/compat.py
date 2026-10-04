"""Small compatibility helpers.

`enum.StrEnum` only exists on Python 3.11+. This equivalent works everywhere and
behaves identically for our use: members compare as strings, and `str(member)`
returns the value rather than `ClassName.MEMBER`.

Using this instead of the stdlib version removes a hidden runtime requirement —
the code no longer breaks if it is ever run on an older interpreter.
"""

from __future__ import annotations

from enum import Enum


class StrEnum(str, Enum):
    """A string enum that stringifies to its value."""

    def __str__(self) -> str:  # noqa: D105
        return str(self.value)

    def __repr__(self) -> str:  # noqa: D105
        return f"{self.__class__.__name__}.{self.name}"
