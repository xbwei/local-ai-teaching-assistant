#!/usr/bin/env python3
"""Exercise positive and negative fixtures for architecture documentation."""

from __future__ import annotations

import runpy
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHECKER = runpy.run_path(
    str(ROOT / "scripts" / "ci" / "check-architecture-contracts.py"),
    run_name="architecture_contract_checker",
)
MODULES_DOC = ROOT / "docs" / "MODULES.md"
README = ROOT / "README.md"


def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise AssertionError(f"fixture anchor must occur exactly once: {old}")
    return text.replace(old, new, 1)


def expect_failure(name: str, action: Callable[[], None]) -> None:
    try:
        action()
    except ValueError:
        print(f"{name} negative fixture passed")
        return
    raise AssertionError(f"{name} negative fixture did not fail")


def main() -> int:
    text = MODULES_DOC.read_text(encoding="utf-8")
    section_fixture = "# Document\n## Target\nowned\n# Later\nnot-owned\n"
    selected = CHECKER["section"](section_fixture, "Target")
    if selected != "owned\n":
        raise AssertionError(
            f"section parser crossed a higher-level heading: {selected!r}"
        )
    print("higher-level section boundary fixture passed")

    ownership_fixture = replace_once(
        text,
        "| `shared-contracts` | `packages/contracts/` |",
        "| shared-contracts | `packages/contracts/` |",
    )
    expect_failure(
        "unquoted-ownership-module",
        lambda: CHECKER["validate_graph"](ownership_fixture),
    )

    graph_fixtures = {
        "cycle": replace_once(
            text,
            "| `shared-contracts` | — |",
            "| `shared-contracts` | `api-server` |",
        ),
        "provider-bypass": replace_once(
            text,
            "| `provider-adapters` | `shared-contracts`, `runtime-foundation` |",
            "| `provider-adapters` | `shared-contracts`, `runtime-foundation`, `policy-capability` |",
        ),
        "malformed-dependency-row": replace_once(
            text,
            "| `shared-contracts` | — |",
            "| `shared-contracts` |",
        ),
        "unquoted-dependency-module": replace_once(
            text,
            "| `shared-contracts` | — |",
            "| shared-contracts | — |",
        ),
    }
    for name, fixture in graph_fixtures.items():
        expect_failure(name, lambda fixture=fixture: CHECKER["validate_graph"](fixture))

    valid_links = " ".join(
        [
            "[encoded](docs/MODULES%2Emd)",
            "[query](docs/MODULES.md?view=1#contracts)",
            '[title](docs/MODULES.md "Module map")',
            '[angle](<docs/MODULES.md> "Module map")',
            "[root](/docs/MODULES.md)",
            "[blank](   )",
            "[mail](mailto:owner@example.com)",
            "[external](https://example.com/docs)",
        ]
    )
    CHECKER["validate_relative_links"](README, valid_links)
    print(
        "encoded, query, title, angle, root, blank, mailto, and external link "
        "fixtures passed"
    )

    expect_failure(
        "broken-relative-link",
        lambda: CHECKER["validate_relative_links"](
            README,
            "[missing](docs/does-not-exist.md)",
        ),
    )
    expect_failure(
        "repository-escape-link",
        lambda: CHECKER["validate_relative_links"](
            README,
            "[escape](../../outside.md)",
        ),
    )
    expect_failure(
        "malformed-angle-link",
        lambda: CHECKER["validate_relative_links"](
            README,
            "[malformed](<docs/MODULES.md)",
        ),
    )
    print("Architecture contract negative fixtures passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
