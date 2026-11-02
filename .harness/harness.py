#!/usr/bin/env python3
"""The Gatekeeper: keeps the Feature Ledger honest across build sessions.

It uses only the Python standard library. The file contract it enforces is
described in references/ledger-schema.md.

Typical use, from the project root:
    python3 .harness/harness.py status
    python3 .harness/harness.py next
    python3 .harness/harness.py begin F3
    python3 .harness/harness.py pass F3 --ran "..." --saw "..." --method browser
"""

from __future__ import annotations

import argparse
import contextlib
import enum
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator, NoReturn, Optional, Sequence, TypeVar

SCHEMA_VERSION = 1
HARNESS_FOLDER_NAME = ".harness"
LEDGER_FILE_NAME = "ledger.json"
PROGRESS_FILE_NAME = "progress.md"
LOCK_FILE_NAME = ".lock"
SCRIPT_FILE_NAME = "harness.py"

MAX_FILE_BYTES = 1_000_000
MAX_ENTRIES = 300
MAX_CRITERIA_PER_ENTRY = 20
MAX_PROJECT_NAME_LENGTH = 80
MAX_TITLE_LENGTH = 120
MAX_CRITERION_LENGTH = 300
MAX_MESSAGE_LENGTH = 500
MAX_ORDER = 10_000
DEFAULT_START_CHECK_TIMEOUT_SECONDS = 120
MAX_START_CHECK_TIMEOUT_SECONDS = 1800
GIT_TIMEOUT_SECONDS = 10
START_CHECK_OUTPUT_TAIL_LINES = 40
LOCK_WAIT_SECONDS = 5.0
LOCK_RETRY_SECONDS = 0.05
LOCK_STALE_SECONDS = 30.0

ENTRY_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{7,40}$")
FINGERPRINT_PATTERN = re.compile(r"^[0-9a-f]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
SEAL_LINE_PATTERN = re.compile(r"^SEAL ([0-9a-f]{64}) (\S+) ids=(\S*)(?: (.*))?$")
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]+")

# Best-effort guard so secrets never land in the ledger or the log. It is not a scanner.
SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"(?i)\b(?:password|passwd|secret|api[_-]?key|token)\s*=\s*['\"]?[A-Za-z0-9/+_-]{12,}"),
)


class Status(str, enum.Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    PASSING = "passing"
    BLOCKED = "blocked"
    DEFERRED = "deferred"


class Category(str, enum.Enum):
    JOURNEY = "journey"
    QUALITY_FLOOR = "quality_floor"
    SAFETY = "safety"
    TEST = "test"


class EvidenceMethod(str, enum.Enum):
    BROWSER = "browser"
    COMMAND = "command"
    TEST = "test"
    USER = "user"


class Branch(str, enum.Enum):
    RAT = "rat"
    SLC = "slc"
    MLP = "mlp"
    CLASSIC = "classic"


class Move(str, enum.Enum):
    BEGIN = "begin"
    PASS = "pass"
    REOPEN = "reopen"
    BLOCK = "block"
    DEFER = "defer"
    RESTORE = "restore"


class Command(str, enum.Enum):
    INIT = "init"
    STATUS = "status"
    NEXT = "next"
    START_CHECK = "start-check"
    BEGIN = "begin"
    PASS = "pass"
    REOPEN = "reopen"
    BLOCK = "block"
    DEFER = "defer"
    RESTORE = "restore"
    RESEAL = "reseal"
    VERIFY = "verify"
    LOG = "log"


class LogKind(str, enum.Enum):
    BEGIN = "BEGIN"
    PASS = "PASS"
    REOPEN = "REOPEN"
    BLOCK = "BLOCK"
    DEFER = "DEFER"
    RESTORE = "RESTORE"
    NOTE = "NOTE"
    RESEAL = "RESEAL"
    START_CHECK = "START_CHECK"


class ExitCode(enum.IntEnum):
    OK = 0
    FAILED = 1
    BLOCK = 2  # The Claude Code Stop hook protocol reads exit code 2 as "do not stop yet".


class HarnessError(Exception):
    """A problem the user can fix. The message is shown as written."""


@dataclass(frozen=True)
class MoveRule:
    sources: frozenset[Status]
    target: Status
    needs_reason: bool


MOVE_RULES: dict[Move, MoveRule] = {
    Move.BEGIN: MoveRule(frozenset({Status.NOT_STARTED, Status.BLOCKED}), Status.IN_PROGRESS, False),
    Move.PASS: MoveRule(frozenset({Status.IN_PROGRESS}), Status.PASSING, False),
    Move.REOPEN: MoveRule(frozenset({Status.PASSING}), Status.IN_PROGRESS, True),
    Move.BLOCK: MoveRule(frozenset({Status.NOT_STARTED, Status.IN_PROGRESS}), Status.BLOCKED, True),
    Move.DEFER: MoveRule(
        frozenset({Status.NOT_STARTED, Status.IN_PROGRESS, Status.BLOCKED}), Status.DEFERRED, True
    ),
    Move.RESTORE: MoveRule(frozenset({Status.DEFERRED}), Status.NOT_STARTED, True),
}


@dataclass(frozen=True)
class Evidence:
    what_ran: str
    what_was_seen: str
    method: EvidenceMethod
    commit: str
    date: str


@dataclass(frozen=True)
class Entry:
    entry_id: str
    title: str
    category: Category
    order: int
    criteria: tuple[str, ...]
    status: Status
    evidence: Optional[Evidence]
    note: str
    seal: str


@dataclass(frozen=True)
class Ledger:
    project: str
    branch: Branch
    start_check: tuple[str, ...]
    start_check_timeout_seconds: int
    entries: tuple[Entry, ...]
    seal: str
    sealed_at: str


@dataclass(frozen=True)
class LoggedSeal:
    fingerprint: str
    entry_ids: tuple[str, ...]


@dataclass(frozen=True)
class HarnessPaths:
    root: Path
    folder: Path
    ledger_file: Path
    progress_file: Path
    lock_file: Path
    script_file: Path


def paths_for(root: Path) -> HarnessPaths:
    folder = root / HARNESS_FOLDER_NAME
    return HarnessPaths(
        root=root,
        folder=folder,
        ledger_file=folder / LEDGER_FILE_NAME,
        progress_file=folder / PROGRESS_FILE_NAME,
        lock_file=folder / LOCK_FILE_NAME,
        script_file=folder / SCRIPT_FILE_NAME,
    )


def utc_now_text() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Reading input: everything is parsed into fixed types at the edge.
# ---------------------------------------------------------------------------

EnumType = TypeVar("EnumType", bound=enum.Enum)


def reject_secret_like_text(text: str, label: str) -> None:
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            raise HarnessError(
                f"{label} looks like it contains a secret. Describe it instead of pasting it."
            )


def clean_text(raw_text: str, label: str, max_length: int) -> str:
    cleaned = " ".join(CONTROL_CHARACTERS.sub(" ", raw_text).split())
    if not cleaned:
        raise HarnessError(f"{label} cannot be empty.")
    if len(cleaned) > max_length:
        raise HarnessError(f"{label} is too long (the limit is {max_length} characters).")
    reject_secret_like_text(cleaned, label)
    return cleaned


def as_mapping(raw: object, where: str) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise HarnessError(f"{where} must be an object.")
    return raw


def read_text_field(mapping: dict[str, object], key: str, where: str, max_length: int) -> str:
    raw_value = mapping.get(key)
    if not isinstance(raw_value, str):
        raise HarnessError(f"{where}: '{key}' must be text.")
    return clean_text(raw_value, f"{where}: '{key}'", max_length)


def read_optional_text(mapping: dict[str, object], key: str, where: str, max_length: int) -> str:
    raw_value = mapping.get(key)
    if raw_value is None or raw_value == "":
        return ""
    return read_text_field(mapping, key, where, max_length)


def read_int(mapping: dict[str, object], key: str, where: str, minimum: int, maximum: int) -> int:
    raw_value = mapping.get(key)
    if isinstance(raw_value, bool) or not isinstance(raw_value, int):
        raise HarnessError(f"{where}: '{key}' must be a whole number.")
    if not minimum <= raw_value <= maximum:
        raise HarnessError(f"{where}: '{key}' must be between {minimum} and {maximum}.")
    return raw_value


def read_enum(
    mapping: dict[str, object], key: str, where: str, enum_type: type[EnumType]
) -> EnumType:
    raw_value = mapping.get(key)
    allowed = [member.value for member in enum_type]
    if raw_value not in allowed:
        raise HarnessError(f"{where}: '{key}' must be one of: {', '.join(allowed)}.")
    return enum_type(raw_value)


def read_text_list(
    mapping: dict[str, object], key: str, where: str, max_items: int, max_length: int
) -> tuple[str, ...]:
    raw_items = mapping.get(key)
    if not isinstance(raw_items, list) or not raw_items:
        raise HarnessError(f"{where}: '{key}' must be a list with at least one item.")
    if len(raw_items) > max_items:
        raise HarnessError(f"{where}: '{key}' has too many items (the limit is {max_items}).")
    cleaned_items = []
    for position, raw_item in enumerate(raw_items, start=1):
        if not isinstance(raw_item, str):
            raise HarnessError(f"{where}: item {position} of '{key}' must be text.")
        cleaned_items.append(clean_text(raw_item, f"{where}: item {position} of '{key}'", max_length))
    return tuple(cleaned_items)


def read_entry_id(mapping: dict[str, object], position: int) -> str:
    raw_value = mapping.get("id")
    if not isinstance(raw_value, str) or not ENTRY_ID_PATTERN.match(raw_value):
        raise HarnessError(
            f"Entry number {position}: 'id' must be 1 to 40 letters, digits, dashes or underscores."
        )
    return raw_value


def read_seal(mapping: dict[str, object], key: str, where: str) -> str:
    raw_value = mapping.get(key, "")
    if raw_value == "":
        return ""
    if not isinstance(raw_value, str) or not FINGERPRINT_PATTERN.match(raw_value):
        raise HarnessError(f"{where}: '{key}' must be empty or a 64 character fingerprint.")
    return raw_value


def read_timestamp(mapping: dict[str, object], key: str, where: str) -> str:
    raw_value = mapping.get(key)
    if not isinstance(raw_value, str) or not TIMESTAMP_PATTERN.match(raw_value):
        raise HarnessError(f"{where}: '{key}' must be a UTC time like 2026-10-11T09:30:00Z.")
    return raw_value


def parse_evidence(raw: object, where: str) -> Optional[Evidence]:
    if raw is None:
        return None
    mapping = as_mapping(raw, f"{where}: evidence")
    commit = mapping.get("commit")
    if not isinstance(commit, str) or not COMMIT_PATTERN.match(commit):
        raise HarnessError(f"{where}: evidence 'commit' must be a commit hash.")
    evidence_where = f"{where}: evidence"
    return Evidence(
        what_ran=read_text_field(mapping, "what_ran", evidence_where, MAX_MESSAGE_LENGTH),
        what_was_seen=read_text_field(mapping, "what_was_seen", evidence_where, MAX_MESSAGE_LENGTH),
        method=read_enum(mapping, "method", evidence_where, EvidenceMethod),
        commit=commit,
        date=read_timestamp(mapping, "date", evidence_where),
    )


def guard_status_details(
    entry_id: str, status: Status, evidence: Optional[Evidence], note: str
) -> None:
    if status is Status.PASSING and evidence is None:
        raise HarnessError(f"Entry {entry_id} is marked passing but has no evidence.")
    if status is not Status.PASSING and evidence is not None:
        raise HarnessError(f"Entry {entry_id} has evidence but is not passing.")
    if status in (Status.BLOCKED, Status.DEFERRED) and not note:
        raise HarnessError(f"Entry {entry_id} is {status.value} but has no reason in its note.")


def parse_entry(raw: object, position: int) -> Entry:
    mapping = as_mapping(raw, f"Entry number {position}")
    entry_id = read_entry_id(mapping, position)
    where = f"Entry {entry_id}"
    status = read_enum(mapping, "status", where, Status)
    evidence = parse_evidence(mapping.get("evidence"), where)
    note = read_optional_text(mapping, "note", where, MAX_MESSAGE_LENGTH)
    guard_status_details(entry_id, status, evidence, note)
    return Entry(
        entry_id=entry_id,
        title=read_text_field(mapping, "title", where, MAX_TITLE_LENGTH),
        category=read_enum(mapping, "category", where, Category),
        order=read_int(mapping, "order", where, 1, MAX_ORDER),
        criteria=read_text_list(mapping, "criteria", where, MAX_CRITERIA_PER_ENTRY, MAX_CRITERION_LENGTH),
        status=status,
        evidence=evidence,
        note=note,
        seal=read_seal(mapping, "seal", where),
    )


def guard_unique_entries(entries: Sequence[Entry]) -> None:
    seen_ids: set[str] = set()
    seen_orders: set[int] = set()
    for entry in entries:
        if entry.entry_id in seen_ids:
            raise HarnessError(f"Entry {entry.entry_id} appears more than once.")
        if entry.order in seen_orders:
            raise HarnessError(f"Entry {entry.entry_id} shares its order number with another entry.")
        seen_ids.add(entry.entry_id)
        seen_orders.add(entry.order)


def parse_start_check(mapping: dict[str, object], where: str) -> tuple[str, ...]:
    return read_text_list(mapping, "start_check", where, 20, MAX_CRITERION_LENGTH)


def read_timeout_seconds(mapping: dict[str, object], where: str) -> int:
    if "start_check_timeout_seconds" not in mapping:
        return DEFAULT_START_CHECK_TIMEOUT_SECONDS
    return read_int(mapping, "start_check_timeout_seconds", where, 1, MAX_START_CHECK_TIMEOUT_SECONDS)


def parse_ledger(raw: object) -> Ledger:
    where = "The ledger"
    mapping = as_mapping(raw, where)
    version = read_int(mapping, "schema_version", where, 1, 1_000)
    if version != SCHEMA_VERSION:
        raise HarnessError(f"The ledger uses schema version {version}; this script supports {SCHEMA_VERSION}.")
    raw_entries = mapping.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise HarnessError("The ledger must list at least one entry.")
    if len(raw_entries) > MAX_ENTRIES:
        raise HarnessError(f"The ledger has too many entries (the limit is {MAX_ENTRIES}).")
    entries = tuple(parse_entry(raw_entry, position) for position, raw_entry in enumerate(raw_entries, 1))
    guard_unique_entries(entries)
    return Ledger(
        project=read_text_field(mapping, "project", where, MAX_PROJECT_NAME_LENGTH),
        branch=read_enum(mapping, "branch", where, Branch),
        start_check=parse_start_check(mapping, where),
        start_check_timeout_seconds=read_timeout_seconds(mapping, where),
        entries=entries,
        seal=read_seal(mapping, "seal", where),
        sealed_at=str(mapping.get("sealed_at", "")),
    )


def parse_draft_entry(raw: object, position: int) -> Entry:
    mapping = as_mapping(raw, f"Draft entry number {position}")
    entry_id = read_entry_id(mapping, position)
    where = f"Draft entry {entry_id}"
    order = read_int(mapping, "order", where, 1, MAX_ORDER) if "order" in mapping else position
    return Entry(
        entry_id=entry_id,
        title=read_text_field(mapping, "title", where, MAX_TITLE_LENGTH),
        category=read_enum(mapping, "category", where, Category),
        order=order,
        criteria=read_text_list(mapping, "criteria", where, MAX_CRITERIA_PER_ENTRY, MAX_CRITERION_LENGTH),
        status=Status.NOT_STARTED,
        evidence=None,
        note="",
        seal="",
    )


def parse_draft(raw: object) -> Ledger:
    where = "The draft"
    mapping = as_mapping(raw, where)
    raw_entries = mapping.get("entries")
    if not isinstance(raw_entries, list) or not raw_entries:
        raise HarnessError("The draft must list at least one entry.")
    if len(raw_entries) > MAX_ENTRIES:
        raise HarnessError(f"The draft has too many entries (the limit is {MAX_ENTRIES}).")
    entries = tuple(parse_draft_entry(raw_entry, position) for position, raw_entry in enumerate(raw_entries, 1))
    guard_unique_entries(entries)
    return Ledger(
        project=read_text_field(mapping, "project", where, MAX_PROJECT_NAME_LENGTH),
        branch=read_enum(mapping, "branch", where, Branch),
        start_check=parse_start_check(mapping, where),
        start_check_timeout_seconds=read_timeout_seconds(mapping, where),
        entries=tuple(sorted(entries, key=lambda entry: entry.order)),
        seal="",
        sealed_at="",
    )


def load_json_file(path: Path, label: str) -> object:
    if not path.exists():
        raise HarnessError(f"{label} was not found at {path}.")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise HarnessError(f"{label} is larger than {MAX_FILE_BYTES} bytes, which is not expected.")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as problem:
        raise HarnessError(f"{label} is not valid JSON: {problem}") from problem


# ---------------------------------------------------------------------------
# Writing output: the ledger, the progress log, and the lock around them.
# ---------------------------------------------------------------------------


def evidence_to_json(evidence: Optional[Evidence]) -> Optional[dict[str, object]]:
    if evidence is None:
        return None
    return {
        "what_ran": evidence.what_ran,
        "what_was_seen": evidence.what_was_seen,
        "method": evidence.method.value,
        "commit": evidence.commit,
        "date": evidence.date,
    }


def entry_to_json(entry: Entry) -> dict[str, object]:
    return {
        "id": entry.entry_id,
        "title": entry.title,
        "category": entry.category.value,
        "order": entry.order,
        "criteria": list(entry.criteria),
        "status": entry.status.value,
        "evidence": evidence_to_json(entry.evidence),
        "note": entry.note,
        "seal": entry.seal,
    }


def ledger_to_json(ledger: Ledger) -> dict[str, object]:
    return {
        "schema_version": SCHEMA_VERSION,
        "project": ledger.project,
        "branch": ledger.branch.value,
        "start_check": list(ledger.start_check),
        "start_check_timeout_seconds": ledger.start_check_timeout_seconds,
        "seal": ledger.seal,
        "sealed_at": ledger.sealed_at,
        "entries": [entry_to_json(entry) for entry in ledger.entries],
    }


def write_text_atomically(target: Path, content: str) -> None:
    temporary_file = target.with_name(target.name + ".tmp")
    temporary_file.write_text(content, encoding="utf-8")
    os.replace(temporary_file, target)


def write_ledger(paths: HarnessPaths, ledger: Ledger) -> None:
    content = json.dumps(ledger_to_json(ledger), indent=2, ensure_ascii=False) + "\n"
    write_text_atomically(paths.ledger_file, content)


def read_ledger(paths: HarnessPaths) -> Ledger:
    if not paths.ledger_file.exists():
        raise HarnessError("No ledger found. Create one with the init command first.")
    return parse_ledger(load_json_file(paths.ledger_file, "The ledger"))


def append_log(paths: HarnessPaths, kind: LogKind, message: str) -> None:
    line = f"{utc_now_text()} {kind.value} {message}\n"
    with paths.progress_file.open("a", encoding="utf-8") as progress_handle:
        progress_handle.write(line)


def create_lock_file(lock_file: Path) -> bool:
    try:
        descriptor = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.close(descriptor)
    return True


def remove_stale_lock(lock_file: Path) -> None:
    try:
        lock_age_seconds = time.time() - lock_file.stat().st_mtime
    except FileNotFoundError:
        return
    if lock_age_seconds > LOCK_STALE_SECONDS:
        lock_file.unlink(missing_ok=True)


def acquire_lock(lock_file: Path) -> None:
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while not create_lock_file(lock_file):
        remove_stale_lock(lock_file)
        if time.monotonic() > deadline:
            raise HarnessError("The ledger is busy because another command is writing. Try again in a moment.")
        time.sleep(LOCK_RETRY_SECONDS)


@contextlib.contextmanager
def ledger_lock(paths: HarnessPaths) -> Iterator[None]:
    acquire_lock(paths.lock_file)
    try:
        yield
    finally:
        paths.lock_file.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# The Seal: a fingerprint of everything the agent must not change on its own.
# ---------------------------------------------------------------------------


def fingerprint_of(payload: object) -> str:
    canonical_text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical_text.encode("utf-8")).hexdigest()


def entry_fingerprint(entry: Entry) -> str:
    return fingerprint_of(
        {
            "id": entry.entry_id,
            "title": entry.title,
            "category": entry.category.value,
            "order": entry.order,
            "criteria": list(entry.criteria),
        }
    )


def ledger_fingerprint(ledger: Ledger) -> str:
    sealed_pairs = sorted([entry.entry_id, entry.seal] for entry in ledger.entries)
    return fingerprint_of(
        {
            "entries": sealed_pairs,
            "start_check": list(ledger.start_check),
            "start_check_timeout_seconds": ledger.start_check_timeout_seconds,
        }
    )


def seal_ledger(ledger: Ledger) -> Ledger:
    sealed_entries = tuple(replace(entry, seal=entry_fingerprint(entry)) for entry in ledger.entries)
    with_entry_seals = replace(ledger, entries=sealed_entries)
    return replace(with_entry_seals, seal=ledger_fingerprint(with_entry_seals), sealed_at=utc_now_text())


def format_seal_line(ledger: Ledger, reason: str) -> str:
    entry_ids = ",".join(entry.entry_id for entry in ledger.entries)
    return f"SEAL {ledger.seal} {ledger.sealed_at} ids={entry_ids} {reason}"


def latest_logged_seal(paths: HarnessPaths) -> Optional[LoggedSeal]:
    if not paths.progress_file.exists():
        return None
    latest: Optional[LoggedSeal] = None
    for line in paths.progress_file.read_text(encoding="utf-8").splitlines():
        match = SEAL_LINE_PATTERN.match(line)
        if match:
            entry_ids = tuple(item for item in match.group(3).split(",") if item)
            latest = LoggedSeal(fingerprint=match.group(1), entry_ids=entry_ids)
    return latest


def entry_seal_problems(ledger: Ledger) -> list[str]:
    problems = []
    for entry in ledger.entries:
        if not entry.seal:
            problems.append(f"Entry {entry.entry_id} has no seal.")
        elif entry.seal != entry_fingerprint(entry):
            problems.append(
                f"Entry {entry.entry_id}: its frozen fields changed after approval. "
                "Ask the user to approve a reseal."
            )
    return problems


def logged_seal_problems(paths: HarnessPaths, ledger: Ledger) -> list[str]:
    logged = latest_logged_seal(paths)
    if logged is None:
        return ["The progress log has no SEAL line, so the plan cannot be checked."]
    problems = []
    if logged.fingerprint != ledger.seal:
        problems.append("The ledger seal differs from the last SEAL line in the progress log.")
    current_ids = {entry.entry_id for entry in ledger.entries}
    for removed_id in sorted(set(logged.entry_ids) - current_ids):
        problems.append(f"Entry {removed_id} was removed. Entries are never deleted; defer them instead.")
    for added_id in sorted(current_ids - set(logged.entry_ids)):
        problems.append(f"Entry {added_id} is not in the last sealed plan. Ask the user to approve a reseal.")
    return problems


def state_problems(ledger: Ledger) -> list[str]:
    in_progress_ids = [entry.entry_id for entry in ledger.entries if entry.status is Status.IN_PROGRESS]
    if len(in_progress_ids) <= 1:
        return []
    return [f"More than one entry is in progress ({', '.join(in_progress_ids)}). Work on one at a time."]


def collect_problems(paths: HarnessPaths) -> list[str]:
    try:
        ledger = read_ledger(paths)
    except HarnessError as problem:
        return [str(problem)]
    seal_findings = []
    if ledger_fingerprint(ledger) != ledger.seal:
        seal_findings.append("The ledger seal does not match its entries or its Start Check.")
    return (
        entry_seal_problems(ledger)
        + seal_findings
        + logged_seal_problems(paths, ledger)
        + state_problems(ledger)
    )


# ---------------------------------------------------------------------------
# Commands.
# ---------------------------------------------------------------------------


def require_harness_folder(paths: HarnessPaths) -> None:
    if not paths.folder.is_dir():
        raise HarnessError(f"No {HARNESS_FOLDER_NAME} folder in {paths.root}. Run the init command first.")


def read_draft_file(draft_path: Path) -> Ledger:
    return parse_draft(load_json_file(draft_path, "The draft file"))


def install_script_copy(paths: HarnessPaths) -> None:
    source_file = Path(__file__).resolve()
    if paths.script_file.exists() and paths.script_file.resolve() == source_file:
        return
    shutil.copy2(source_file, paths.script_file)


def start_progress_log(paths: HarnessPaths, ledger: Ledger) -> None:
    header = "# Progress Log\n\nNewest entries at the bottom. SEAL lines are written by harness.py. Do not edit them.\n\n"
    seal_line = format_seal_line(ledger, "Ledger created.")
    note = f"{utc_now_text()} {LogKind.NOTE.value} Ledger created with {len(ledger.entries)} entries for {ledger.project} ({ledger.branch.value})."
    write_text_atomically(paths.progress_file, f"{header}{seal_line}\n{note}\n")


def run_init(paths: HarnessPaths, args: argparse.Namespace) -> ExitCode:
    if paths.ledger_file.exists():
        raise HarnessError("A ledger already exists here. Use the reseal command to change the plan.")
    draft = read_draft_file(Path(args.draft))
    paths.folder.mkdir(exist_ok=True)
    install_script_copy(paths)
    sealed_ledger = seal_ledger(draft)
    write_ledger(paths, sealed_ledger)
    start_progress_log(paths, sealed_ledger)
    print(f"Ledger created with {len(sealed_ledger.entries)} entries and sealed.")
    print(f"Next: run the Start Check with 'python3 {HARNESS_FOLDER_NAME}/{SCRIPT_FILE_NAME} start-check'.")
    return ExitCode.OK


def format_entry_line(entry: Entry) -> str:
    return f"{entry.entry_id:<8} {entry.status.value:<12} {entry.title}"


def run_status(paths: HarnessPaths, args: argparse.Namespace) -> ExitCode:
    ledger = read_ledger(paths)
    counts = Counter(entry.status for entry in ledger.entries)
    summary = " | ".join(f"{status.value.replace('_', ' ')} {counts[status]}" for status in Status)
    print(f"{ledger.project} ({ledger.branch.value}), sealed {ledger.sealed_at}")
    print(summary)
    for entry in ledger.entries:
        print(format_entry_line(entry))
    return ExitCode.OK


def pick_next_entry(ledger: Ledger) -> Optional[Entry]:
    for wanted_status in (Status.IN_PROGRESS, Status.NOT_STARTED):
        for entry in ledger.entries:
            if entry.status is wanted_status:
                return entry
    return None


def run_next(paths: HarnessPaths, args: argparse.Namespace) -> ExitCode:
    ledger = read_ledger(paths)
    next_entry = pick_next_entry(ledger)
    if next_entry is not None:
        print(f"{next_entry.entry_id}: {next_entry.title} ({next_entry.status.value})")
        for criterion in next_entry.criteria:
            print(f"  - {criterion}")
        return ExitCode.OK
    blocked_ids = [entry.entry_id for entry in ledger.entries if entry.status is Status.BLOCKED]
    if blocked_ids:
        print(f"Everything left is blocked: {', '.join(blocked_ids)}. Ask the user how to proceed.")
        return ExitCode.OK
    print("Nothing left to build. Run the verify command, then the final review.")
    return ExitCode.OK


def current_commit(root: Path) -> Optional[str]:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def build_evidence(args: argparse.Namespace, root: Path) -> Evidence:
    commit = (args.commit or current_commit(root) or "").lower()
    if not commit:
        raise HarnessError("No commit found. Commit the verified work first, or pass --commit.")
    if not COMMIT_PATTERN.match(commit):
        raise HarnessError("--commit must be a commit hash (7 to 40 hex characters).")
    return Evidence(
        what_ran=clean_text(args.ran, "--ran", MAX_MESSAGE_LENGTH),
        what_was_seen=clean_text(args.saw, "--saw", MAX_MESSAGE_LENGTH),
        method=EvidenceMethod(args.method),
        commit=commit,
        date=utc_now_text(),
    )


def find_entry(ledger: Ledger, entry_id: str) -> Entry:
    for entry in ledger.entries:
        if entry.entry_id == entry_id:
            return entry
    known_ids = ", ".join(entry.entry_id for entry in ledger.entries)
    raise HarnessError(f"There is no entry named {entry_id}. Known entries: {known_ids}.")


def guard_move_allowed(ledger: Ledger, entry: Entry, move: Move) -> None:
    rule = MOVE_RULES[move]
    if entry.status not in rule.sources:
        allowed = ", ".join(sorted(status.value for status in rule.sources))
        raise HarnessError(
            f"Entry {entry.entry_id} is {entry.status.value}, and '{move.value}' only works from: {allowed}."
        )
    if move is not Move.BEGIN:
        return
    for other in ledger.entries:
        if other.status is Status.IN_PROGRESS and other.entry_id != entry.entry_id:
            raise HarnessError(
                f"Entry {other.entry_id} is already in progress. Finish it, block it, or defer it first."
            )


def replace_entry(ledger: Ledger, updated: Entry) -> Ledger:
    entries = tuple(updated if entry.entry_id == updated.entry_id else entry for entry in ledger.entries)
    return replace(ledger, entries=entries)


def apply_move(entry: Entry, move: Move, reason: str, evidence: Optional[Evidence]) -> Entry:
    return replace(
        entry,
        status=MOVE_RULES[move].target,
        evidence=evidence,
        note=reason or entry.note,
    )


def read_reason(args: argparse.Namespace, move: Move) -> str:
    if not MOVE_RULES[move].needs_reason:
        return ""
    return clean_text(args.reason, "--reason", MAX_MESSAGE_LENGTH)


def describe_move(entry: Entry, move: Move, reason: str) -> str:
    if move is Move.PASS and entry.evidence is not None:
        return f"{entry.entry_id} passing (method {entry.evidence.method.value}, commit {entry.evidence.commit})"
    suffix = f": {reason}" if reason else ""
    return f"{entry.entry_id} {MOVE_RULES[move].target.value}{suffix}"


def run_move(paths: HarnessPaths, args: argparse.Namespace) -> ExitCode:
    move = Move(args.command)
    reason = read_reason(args, move)
    with ledger_lock(paths):
        ledger = read_ledger(paths)
        entry = find_entry(ledger, args.entry_id)
        guard_move_allowed(ledger, entry, move)
        evidence = build_evidence(args, paths.root) if move is Move.PASS else None
        moved_entry = apply_move(entry, move, reason, evidence)
        write_ledger(paths, replace_entry(ledger, moved_entry))
        description = describe_move(moved_entry, move, reason)
        append_log(paths, LogKind[move.name], description)
    print(description)
    return ExitCode.OK


def run_log(paths: HarnessPaths, args: argparse.Namespace) -> ExitCode:
    message = clean_text(args.message, "--message", MAX_MESSAGE_LENGTH)
    with ledger_lock(paths):
        append_log(paths, LogKind.NOTE, message)
    print("Noted.")
    return ExitCode.OK


def tail_lines(text: str, count: int) -> str:
    return "\n".join(text.strip().splitlines()[-count:])


def run_start_check_process(ledger: Ledger, root: Path) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            list(ledger.start_check),
            cwd=root,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=ledger.start_check_timeout_seconds,
            check=False,
        )
    except FileNotFoundError as problem:
        raise HarnessError(f"The Start Check command was not found: {ledger.start_check[0]}") from problem
    except subprocess.TimeoutExpired as problem:
        raise HarnessError(
            f"The Start Check did not finish within {ledger.start_check_timeout_seconds} seconds."
        ) from problem


def run_start_check(paths: HarnessPaths, args: argparse.Namespace) -> ExitCode:
    ledger = read_ledger(paths)
    completed = run_start_check_process(ledger, paths.root)
    output_tail = tail_lines(completed.stdout + "\n" + completed.stderr, START_CHECK_OUTPUT_TAIL_LINES)
    passed = completed.returncode == 0
    with ledger_lock(paths):
        append_log(paths, LogKind.START_CHECK, "passed" if passed else f"failed with code {completed.returncode}")
    if output_tail:
        print(output_tail)
    print("Start Check passed." if passed else f"Start Check FAILED (code {completed.returncode}). Fix this before new work.")
    return ExitCode.OK if passed else ExitCode.FAILED


def reset_if_frozen_fields_changed(entry: Entry) -> tuple[Entry, bool]:
    if entry.seal == "":
        if entry.status is not Status.NOT_STARTED:
            raise HarnessError(f"New entry {entry.entry_id} must start as not_started.")
        return entry, False
    if entry.seal == entry_fingerprint(entry):
        return entry, False
    if entry.status is not Status.PASSING:
        return entry, True
    reset_entry = replace(entry, status=Status.NOT_STARTED, evidence=None, note="Reset by reseal: its criteria changed.")
    return reset_entry, True


def guard_nothing_removed(paths: HarnessPaths, ledger: Ledger) -> None:
    logged = latest_logged_seal(paths)
    if logged is None:
        return
    removed_ids = sorted(set(logged.entry_ids) - {entry.entry_id for entry in ledger.entries})
    if removed_ids:
        raise HarnessError(f"Entries are never deleted. Defer these instead: {', '.join(removed_ids)}.")


def run_reseal(paths: HarnessPaths, args: argparse.Namespace) -> ExitCode:
    if not args.user_approved:
        raise HarnessError(
            "A reseal changes the approved plan. Ask the user, then run it again with --user-approved."
        )
    reason = clean_text(args.reason, "--reason", MAX_MESSAGE_LENGTH)
    with ledger_lock(paths):
        edited_ledger = read_ledger(paths)
        guard_nothing_removed(paths, edited_ledger)
        checked = [reset_if_frozen_fields_changed(entry) for entry in edited_ledger.entries]
        changed_ids = [entry.entry_id for entry, was_changed in checked if was_changed or entry.seal == ""]
        reset_ledger = replace(edited_ledger, entries=tuple(entry for entry, _ in checked))
        resealed = seal_ledger(reset_ledger)
        write_ledger(paths, resealed)
        with paths.progress_file.open("a", encoding="utf-8") as progress_handle:
            progress_handle.write(format_seal_line(resealed, reason) + "\n")
        append_log(paths, LogKind.RESEAL, f"{reason} Changed or added: {', '.join(changed_ids) or 'none'}.")
    print(f"Resealed. Changed or added entries: {', '.join(changed_ids) or 'none'}.")
    return ExitCode.OK


def stop_hook_already_active() -> bool:
    if sys.stdin.isatty():
        return False
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return False
    return isinstance(payload, dict) and payload.get("stop_hook_active") is True


def build_problem_message(problems: Sequence[str]) -> str:
    listed = "\n".join(f"- {problem}" for problem in problems)
    return f"The harness check found problems. Fix them before finishing:\n{listed}"


def run_stop_hook(paths: HarnessPaths) -> ExitCode:
    if not paths.ledger_file.exists():
        return ExitCode.OK
    problems = collect_problems(paths)
    if not problems:
        return ExitCode.OK
    message = build_problem_message(problems)
    if stop_hook_already_active():
        # Claude is already continuing because of this hook. Stop looping and tell the user instead.
        print(json.dumps({"continue": False, "stopReason": message}))
        return ExitCode.OK
    print(message, file=sys.stderr)
    return ExitCode.BLOCK


def run_verify(paths: HarnessPaths, args: argparse.Namespace) -> ExitCode:
    if args.stop_hook:
        return run_stop_hook(paths)
    problems = collect_problems(paths)
    if not problems:
        print("Ledger check passed: seal intact, evidence complete.")
        return ExitCode.OK
    print(build_problem_message(problems), file=sys.stderr)
    return ExitCode.FAILED


COMMAND_HANDLERS: dict[Command, Callable[[HarnessPaths, argparse.Namespace], ExitCode]] = {
    Command.INIT: run_init,
    Command.STATUS: run_status,
    Command.NEXT: run_next,
    Command.START_CHECK: run_start_check,
    Command.BEGIN: run_move,
    Command.PASS: run_move,
    Command.REOPEN: run_move,
    Command.BLOCK: run_move,
    Command.DEFER: run_move,
    Command.RESTORE: run_move,
    Command.RESEAL: run_reseal,
    Command.VERIFY: run_verify,
    Command.LOG: run_log,
}

# Verify handles a missing ledger itself, so the Stop hook stays silent in projects without a harness.
COMMANDS_THAT_NEED_THE_FOLDER = frozenset(Command) - {Command.INIT, Command.VERIFY}


# ---------------------------------------------------------------------------
# Command line.
# ---------------------------------------------------------------------------


class UsageErrorParser(argparse.ArgumentParser):
    """Reports usage mistakes with exit code 1.

    argparse normally exits with 2, but the Stop hook protocol reads 2 as "do not stop yet",
    so a typo in a command must never be able to block Claude from finishing.
    """

    def error(self, message: str) -> NoReturn:
        self.print_usage(sys.stderr)
        self.exit(int(ExitCode.FAILED), f"{self.prog}: error: {message}\n")


def add_move_parser(subparsers: argparse._SubParsersAction, common: argparse.ArgumentParser, move: Move) -> None:
    parser = subparsers.add_parser(move.value, parents=[common], help=f"Move an entry with '{move.value}'.")
    parser.add_argument("entry_id", help="The entry id, for example F3.")
    if MOVE_RULES[move].needs_reason:
        parser.add_argument("--reason", required=True, help="Why, in one plain sentence.")
    if move is Move.PASS:
        parser.add_argument("--ran", required=True, help="What you ran or did to verify.")
        parser.add_argument("--saw", required=True, help="What you observed.")
        parser.add_argument("--method", required=True, choices=[method.value for method in EvidenceMethod])
        parser.add_argument("--commit", help="The commit that holds the verified work. Defaults to HEAD.")


def build_parser() -> argparse.ArgumentParser:
    parser = UsageErrorParser(prog=SCRIPT_FILE_NAME, description="Keeps the Feature Ledger honest.")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", default=".", help="The project root. Defaults to the current folder.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_parser = subparsers.add_parser(Command.INIT.value, parents=[common], help="Create and seal the ledger.")
    init_parser.add_argument("--draft", required=True, help="A draft file listing the entries.")
    subparsers.add_parser(Command.STATUS.value, parents=[common], help="Show every entry.")
    subparsers.add_parser(Command.NEXT.value, parents=[common], help="Show the entry to work on.")
    subparsers.add_parser(Command.START_CHECK.value, parents=[common], help="Run the Start Check.")
    for move in Move:
        add_move_parser(subparsers, common, move)

    reseal_parser = subparsers.add_parser(Command.RESEAL.value, parents=[common], help="Approve a plan change.")
    reseal_parser.add_argument("--reason", required=True)
    reseal_parser.add_argument("--user-approved", action="store_true", dest="user_approved")

    verify_parser = subparsers.add_parser(Command.VERIFY.value, parents=[common], help="Check seal and evidence.")
    verify_parser.add_argument("--stop-hook", action="store_true", dest="stop_hook", help="Use the Claude Code Stop hook protocol.")

    log_parser = subparsers.add_parser(Command.LOG.value, parents=[common], help="Add a note to the progress log.")
    log_parser.add_argument("--message", required=True)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    command = Command(args.command)
    paths = paths_for(Path(args.root).resolve())
    try:
        if command in COMMANDS_THAT_NEED_THE_FOLDER:
            require_harness_folder(paths)
        return int(COMMAND_HANDLERS[command](paths, args))
    except HarnessError as problem:
        print(f"Problem: {problem}", file=sys.stderr)
        return int(ExitCode.FAILED)


if __name__ == "__main__":
    sys.exit(main())
