from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_ROOT = REPO_ROOT / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from moonshine_server.moonshine.model_registry import (
    MODEL_MANIFEST,
    _model_license_metadata,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the built-in model registry as release JSON.")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.name}.tmp-{os.getpid()}")
    models = [
        {
            **model,
            "license": model.get("license") or _model_license_metadata(model),
        }
        for model in MODEL_MANIFEST
    ]
    payload = {
        "schemaVersion": 1,
        "models": models,
    }
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, output)
    print(json.dumps({"output": str(output), "models": len(payload["models"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
