#!/usr/bin/env python3
"""Validate the documentation-owned module graph and roadmap ownership map."""

from __future__ import annotations

import os
import re
import sys
import urllib.parse
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULES_DOC = ROOT / "docs" / "MODULES.md"
ADR = ROOT / "docs" / "adr" / "0001-module-and-service-boundaries.md"


def fail(message: str) -> None:
    raise ValueError(message)


def section(text: str, heading: str, next_heading_level: int = 2) -> str:
    marker = f"{'#' * next_heading_level} {heading}\n"
    start = text.find(marker)
    if start < 0:
        fail(f"missing section: {heading}")
    start += len(marker)
    match = re.search(
        rf"^#{{1,{next_heading_level}}} ",
        text[start:],
        re.MULTILINE,
    )
    return text[start : start + match.start()] if match else text[start:]


def table_rows(section_text: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in section_text.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if not cells or all(re.fullmatch(r":?-+:?", cell) for cell in cells):
            continue
        rows.append(cells)
    return rows


def code_names(cell: str) -> list[str]:
    return re.findall(r"`([a-z][a-z0-9-]*)`", cell)


def validate_graph(text: str) -> None:
    ownership_rows = table_rows(section(text, "Target directory and ownership map"))
    if not ownership_rows or ownership_rows[0][:2] != ["Logical module", "Path"]:
        fail("module ownership table header is missing or malformed")
    owned: list[str] = []
    for row in ownership_rows[1:]:
        names = code_names(row[0])
        if len(names) != 1:
            fail(
                "module ownership row must have exactly one backticked module "
                f"name: {row[0]}"
            )
        owned.append(names[0])
    if len(owned) != len(set(owned)):
        fail("module ownership table contains duplicates")

    dependency_rows = table_rows(section(text, "Dependency rules"))
    if not dependency_rows or dependency_rows[0][:2] != ["Module", "May depend on"]:
        fail("dependency table header is missing or malformed")
    graph: dict[str, list[str]] = {}
    for row in dependency_rows[1:]:
        if len(row) < 2:
            fail(f"dependency row is missing columns: {row}")
        names = code_names(row[0])
        if len(names) != 1:
            fail(
                f"dependency row must have exactly one backticked module name: {row[0]}"
            )
        graph[names[0]] = code_names(row[1])

    if set(graph) != set(owned):
        fail(
            "dependency nodes do not match owned modules: "
            f"missing={sorted(set(owned) - set(graph))}, "
            f"extra={sorted(set(graph) - set(owned))}"
        )
    for module, dependencies in graph.items():
        unknown = set(dependencies) - set(graph)
        if unknown:
            fail(f"{module} has unknown dependencies: {sorted(unknown)}")
        if module in dependencies:
            fail(f"{module} depends on itself")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(module: str, trail: list[str]) -> None:
        if module in visiting:
            cycle_start = trail.index(module)
            fail("dependency cycle: " + " -> ".join(trail[cycle_start:] + [module]))
        if module in visited:
            return
        visiting.add(module)
        for dependency in graph[module]:
            visit(dependency, trail + [module])
        visiting.remove(module)
        visited.add(module)

    for module in graph:
        visit(module, [])

    if graph["web-portal"] != ["shared-contracts"]:
        fail("web-portal may import only shared-contracts")
    prohibited_provider_dependencies = {
        "policy-capability",
        "interaction-store",
        "knowledge-access",
        "retrieval",
        "safety-boundary",
    }
    found = prohibited_provider_dependencies.intersection(graph["provider-adapters"])
    if found:
        fail(f"provider-adapters owns prohibited dependencies: {sorted(found)}")


def validate_relative_links(path: Path, text: str) -> None:
    for raw_target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
        raw_target = raw_target.strip()
        if not raw_target:
            continue
        if raw_target.startswith("<"):
            closing_bracket = raw_target.find(">")
            if closing_bracket < 0:
                fail(f"malformed angle-bracket link in {path.relative_to(ROOT)}")
            target = raw_target[1:closing_bracket]
        else:
            target = raw_target.split(maxsplit=1)[0]
        if not target or target.startswith("#"):
            continue
        parsed = urllib.parse.urlsplit(target)
        if parsed.scheme or parsed.netloc:
            continue
        relative = urllib.parse.unquote(parsed.path)
        base = ROOT if relative.startswith("/") else path.parent
        candidate = (base / relative.lstrip("/")).resolve()
        try:
            candidate.relative_to(ROOT)
        except ValueError:
            fail(
                f"relative link escapes the repository in {path.relative_to(ROOT)}: {target}"
            )
        if relative and not candidate.exists():
            fail(f"broken relative link in {path.relative_to(ROOT)}: {target}")


def markdown_files() -> Iterator[Path]:
    ignored_directories = {".git", ".venv", "venv", "node_modules"}
    for directory, child_directories, files in os.walk(ROOT):
        child_directories[:] = sorted(
            child for child in child_directories if child not in ignored_directories
        )
        for name in sorted(files):
            if name.endswith(".md"):
                path = Path(directory) / name
                if path.is_file():
                    yield path


def main() -> int:
    try:
        if not MODULES_DOC.is_file() or not ADR.is_file():
            fail("the module map and ADR must both exist")
        modules_text = MODULES_DOC.read_text(encoding="utf-8")
        validate_graph(modules_text)
        for path in markdown_files():
            validate_relative_links(path, path.read_text(encoding="utf-8"))
    except ValueError as error:
        print(f"architecture-contract check failed: {error}", file=sys.stderr)
        return 1
    print("architecture-contract check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
