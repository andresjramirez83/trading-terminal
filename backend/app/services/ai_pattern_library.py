"""Local, persistent screenshot examples. No training is implied by saving a file."""
from __future__ import annotations

import base64
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple
from uuid import uuid4

PATTERN_ROOT = Path(os.getenv("AI_PATTERN_DIR") or (Path(__file__).resolve().parents[1] / "data" / "ai_patterns"))
MAX_IMAGE_BYTES = 5 * 1024 * 1024


def decode_image(data: str) -> Tuple[bytes, str]:
    if not isinstance(data, str) or not data.startswith("data:image/") or "," not in data:
        raise ValueError("Upload a PNG, JPEG, or WebP image as a data URL")
    header, raw = data.split(",", 1)
    kind = {"data:image/png;base64": "png", "data:image/jpeg;base64": "jpg", "data:image/webp;base64": "webp"}.get(header.lower())
    if not kind or len(raw) > MAX_IMAGE_BYTES * 4 // 3 + 16:
        raise ValueError("Only PNG, JPEG, and WebP up to 5 MB are supported")
    try:
        content = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise ValueError("Invalid image encoding") from exc
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("Image is empty or exceeds 5 MB")
    magic_ok = {
        "png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        "jpg": content.startswith(b"\xff\xd8\xff"),
        "webp": content.startswith(b"RIFF") and content[8:12] == b"WEBP",
    }[kind]
    if not magic_ok:
        raise ValueError("File content is not a valid image of the advertised type")
    return content, kind


def save_pattern(name: str, label: str, timeframe: str, note: str, image_data: str) -> Dict[str, Any]:
    content, kind = decode_image(image_data)
    safe_name = (name or "Reference pattern").strip()[:100]
    if not safe_name:
        raise ValueError("Pattern name is required")
    identifier = uuid4().hex
    item = {
        "id": identifier, "name": safe_name,
        "label": str(label or "interesting").strip().lower()[:32],
        "timeframe": str(timeframe or "5m").strip()[:16],
        "note": str(note or "").strip()[:1500],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "image_ext": kind,
    }
    PATTERN_ROOT.mkdir(parents=True, exist_ok=True)
    image_path = PATTERN_ROOT / f"{identifier}.{kind}"
    metadata_path = PATTERN_ROOT / f"{identifier}.json"
    image_path.write_bytes(content)
    try:
        metadata_path.write_text(json.dumps(item, indent=2), encoding="utf-8")
    except Exception:
        image_path.unlink(missing_ok=True)
        raise
    return item


def list_patterns() -> List[Dict[str, Any]]:
    if not PATTERN_ROOT.is_dir():
        return []
    out = []
    for path in PATTERN_ROOT.glob("*.json"):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(item, dict) and re.fullmatch(r"[0-9a-f]{32}", str(item.get("id", ""))):
                out.append(item)
        except (ValueError, OSError):
            continue
    return sorted(out, key=lambda p: str(p.get("created_at")), reverse=True)


def get_pattern_image(pattern_id: str) -> Tuple[Dict[str, Any], bytes]:
    if not re.fullmatch(r"[0-9a-f]{32}", pattern_id):
        raise ValueError("Invalid pattern id")
    info_path = PATTERN_ROOT / f"{pattern_id}.json"
    if not info_path.is_file():
        raise ValueError("Pattern not found")
    info = json.loads(info_path.read_text(encoding="utf-8"))
    ext = info.get("image_ext")
    if ext not in {"png", "jpg", "webp"}:
        raise ValueError("Unsupported saved image")
    return info, (PATTERN_ROOT / f"{pattern_id}.{ext}").read_bytes()
