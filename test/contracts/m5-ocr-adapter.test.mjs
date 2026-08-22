import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(".");

function runPython(source) {
  const python = process.env.PYTHON || process.env.PYTHON3 || "python";
  const result = spawnSync(python, ["-c", source], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: path.join(root, "server") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("M5 adapter reports only bounded local artifact health states without loading a runtime", () => {
  const output = runPython(`
import hashlib
import tempfile
from pathlib import Path
from server.moonshine_server.ocr_adapter import RapidOcrAdapter

payload = b'local-onnx-artifact'
manifest = {
    'schema_version': 'ocr-component/v1', 'engine_id': 'ocr_rapid_onnx_mobile',
    'engine_version': '1.0.0', 'model_revision': 'ppocr-mobile-r1',
    'model_sha256': hashlib.sha256(payload).hexdigest(), 'size_bytes': len(payload),
    'license_id': 'Apache-2.0', 'languages': ['zh-Hans', 'en'],
    'runtime_flavor': 'cpu', 'supports_gpu': False, 'supports_orientation': True,
    'memory_limit_mb': 1024, 'source_kind': 'offline_bundle', 'default': True,
}
with tempfile.TemporaryDirectory() as directory:
    artifact = Path(directory) / 'component.onnx'
    created = []
    adapter = RapidOcrAdapter(manifest, artifact, runtime_factory=lambda _path: created.append(True))
    assert adapter.health()['status'] == 'missing'
    artifact.write_bytes(b'wrong')
    assert adapter.health()['status'] == 'integrity_error'
    artifact.write_bytes(payload)
    assert adapter.health()['status'] == 'ready'
    assert created == []
    assert RapidOcrAdapter(manifest, artifact, runtime_flavor='cu130', runtime_factory=lambda _path: object()).health()['status'] == 'incompatible'
    assert set(adapter.health()) == {'engine_id', 'status', 'enabled'}
print('health-ok')
`);
  assert.equal(output, "health-ok");
});

test("M5 adapter lazily normalizes fake RapidOCR regions from in-memory bytes", () => {
  const output = runPython(`
import hashlib
import tempfile
from pathlib import Path
from server.moonshine_server.ocr_adapter import RapidOcrAdapter

payload = b'local-onnx-artifact'
manifest = {
    'schema_version': 'ocr-component/v1', 'engine_id': 'ocr_rapid_onnx_mobile',
    'engine_version': '1.0.0', 'model_revision': 'ppocr-mobile-r1',
    'model_sha256': hashlib.sha256(payload).hexdigest(), 'size_bytes': len(payload),
    'license_id': 'Apache-2.0', 'languages': ['zh-Hans', 'en'],
    'runtime_flavor': 'cpu', 'supports_gpu': False, 'supports_orientation': True,
    'memory_limit_mb': 1024, 'source_kind': 'offline_bundle', 'default': True,
}
class FakeRapidOCR:
    def run(self, image):
        assert image == b'pixels'
        return ([[[1, 2], [11, 2], [11, 7], [1, 7]], '  moonshine  ', 0.91], 0.001)
with tempfile.TemporaryDirectory() as directory:
    artifact = Path(directory) / 'component.onnx'
    artifact.write_bytes(payload)
    constructed = []
    def factory(received_path):
        assert received_path == artifact
        constructed.append(True)
        return FakeRapidOCR()
    adapter = RapidOcrAdapter(manifest, artifact, runtime_factory=factory)
    assert constructed == []
    result = adapter.recognize(b'pixels')
    assert constructed == [True]
    assert result == [{
        'polygon': [[1.0, 2.0], [11.0, 2.0], [11.0, 7.0], [1.0, 7.0]],
        'bbox': [1.0, 2.0, 11.0, 7.0], 'text': 'moonshine', 'confidence': 0.91,
        'language': 'und', 'engine_id': 'ocr_rapid_onnx_mobile', 'engine_version': '1.0.0',
    }]
print('recognize-ok')
`);
  assert.equal(output, "recognize-ok");
});

test("M5 adapter rejects filesystem path inputs and malformed runtime results", () => {
  const output = runPython(`
import hashlib
import tempfile
from pathlib import Path
from server.moonshine_server.ocr_adapter import OcrAdapterInputError, OcrAdapterResultError, RapidOcrAdapter

payload = b'local-onnx-artifact'
manifest = {
    'schema_version': 'ocr-component/v1', 'engine_id': 'ocr_rapid_onnx_mobile',
    'engine_version': '1.0.0', 'model_revision': 'ppocr-mobile-r1',
    'model_sha256': hashlib.sha256(payload).hexdigest(), 'size_bytes': len(payload),
    'license_id': 'Apache-2.0', 'languages': ['zh-Hans', 'en'],
    'runtime_flavor': 'cpu', 'supports_gpu': False, 'supports_orientation': True,
    'memory_limit_mb': 1024, 'source_kind': 'offline_bundle', 'default': True,
}
class InvalidRuntime:
    def run(self, _image):
        return [[[[1, 2], [3, 2], [3, 4]], 'bad', 1.2]]
with tempfile.TemporaryDirectory() as directory:
    artifact = Path(directory) / 'component.onnx'
    artifact.write_bytes(payload)
    adapter = RapidOcrAdapter(manifest, artifact, runtime_factory=lambda _path: InvalidRuntime())
    for path_input in ('C:/private/input.png', Path('private/input.png')):
        try:
            adapter.recognize(path_input)
        except OcrAdapterInputError as error:
            assert 'private' not in str(error)
        else:
            raise AssertionError('path input accepted')
    try:
        adapter.recognize(b'pixels')
    except OcrAdapterResultError:
        pass
    else:
        raise AssertionError('invalid polygon/confidence accepted')
print('negative-ok')
`);
  assert.equal(output, "negative-ok");
});
