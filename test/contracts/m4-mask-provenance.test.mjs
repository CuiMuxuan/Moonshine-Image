import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runPython(source) {
  const python = process.env.PYTHON || process.env.PYTHON3 || 'python';
  const result = spawnSync(python, ['-c', source], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: path.join(ROOT, 'server') },
  });
  assert.equal(
    result.status,
    0,
    `python contract failed (status ${result.status}): ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

test('M4 mask operation logs replay deterministically across coordinate spaces', () => {
  const output = runPython(String.raw`
from server.moonshine_server.mask_provenance import (
    append_operation, compute_mask_hash, new_operation_log, replay_hash, replay_mask,
    normalized_to_pixel, pixel_to_normalized,
)

log = new_operation_log(5, 4)
log = append_operation(log, {
    'op_id': 'paint-0', 'kind': 'paint', 'coordinate_space': 'pixels',
    'points': [{'x': 1, 'y': 1}, {'x': 2, 'y': 1}],
})
log = append_operation(log, {
    'op_id': 'erase-1', 'kind': 'erase', 'coordinate_space': 'normalized',
    'points': [{'x': 0.5, 'y': 1 / 3}],
})
mask_a = replay_mask(log)
mask_b = replay_mask(log)
assert mask_a == mask_b
assert replay_hash(log) == compute_mask_hash(5, 4, mask_a)
assert normalized_to_pixel(1, 1, 5, 4) == {'x': 4, 'y': 3}
assert pixel_to_normalized(4, 3, 5, 4) == {'x': 1.0, 'y': 1.0}
assert len(mask_a) == 20 and set(mask_a) <= {0, 255}
control_log = append_operation(new_operation_log(2, 2), {'op_id': 'clear', 'kind': 'clear'})
control_log = append_operation(control_log, {'op_id': 'invert', 'kind': 'invert'})
assert replay_mask(control_log) == b'\xff' * 4
print(replay_hash(log))
`);
  assert.match(output, /^[a-f0-9]{64}$/);
});

test('M4 sidecar binds source, provenance, operation log, and replay hash', () => {
  const output = runPython(String.raw`
from server.moonshine_server.mask_provenance import build_sidecar, new_operation_log, append_operation

log = append_operation(
    new_operation_log(3, 3),
    {'op_id': 'rect-0', 'kind': 'rectangle', 'coordinate_space': 'pixels',
     'points': [{'x': 0, 'y': 0}, {'x': 1, 'y': 1}]},
)
sidecar = build_sidecar(
    sidecar_id='sidecar-m4-001',
    source_image_sha256='a' * 64,
    width=3,
    height=3,
    operation_log=log,
    provenance={'producer': 'ui', 'source': 'image-editor', 'engine_version': 'spike-1'},
    job_id='job-m4-001',
    artifact_id='artifact-mask-m4-001',
)
assert sidecar['schema_version'] == 'mask-sidecar/v1'
assert sidecar['coordinate_space'] == 'source_pixels'
assert sidecar['source_image_sha256'] == 'a' * 64
assert sidecar['mask']['sha256'] == sidecar['mask']['sha256'].lower()
assert sidecar['operation_log']['schema_version'] == 'mask-operation-log/v1'
assert sidecar['provenance']['producer'] == 'ui'
assert sidecar['replay']['deterministic'] is True
print(sidecar['mask']['sha256'])
`);
  assert.match(output, /^[a-f0-9]{64}$/);
});

test('M4 rejects unsafe coordinates, source overwrite, and incomplete staging', () => {
  const output = runPython(String.raw`
import os
import tempfile
from server.moonshine_server.mask_provenance import (
    IncompleteStagingError, InvalidCoordinateError, InvalidOperationError,
    MaskProvenanceError, UnsafePublishTargetError, append_operation,
    build_sidecar, new_operation_log, replay_mask, validate_publish_target,
)

def expect(error, fn):
    try:
        fn()
    except error:
        return
    raise AssertionError(f'expected {error.__name__}')

expect(InvalidCoordinateError, lambda: append_operation(
    new_operation_log(3, 3),
    {'op_id': 'bad', 'kind': 'paint', 'coordinate_space': 'pixels', 'points': [{'x': 3, 'y': 0}]},
))
expect(InvalidCoordinateError, lambda: append_operation(
    new_operation_log(3, 3),
    {'op_id': 'bad', 'kind': 'paint', 'coordinate_space': 'normalized', 'points': [{'x': -0.1, 'y': 0.5}]},
))
expect(InvalidOperationError, lambda: append_operation(
    new_operation_log(3, 3),
    {'op_id': 'missing-space', 'kind': 'paint', 'points': [{'x': 0, 'y': 0}]},
))
expect(InvalidOperationError, lambda: append_operation(
    new_operation_log(3, 3),
    {'op_id': 'bad-space-type', 'kind': 'paint', 'coordinate_space': [], 'points': [{'x': 0, 'y': 0}]},
))
expect(InvalidOperationError, lambda: append_operation(
    new_operation_log(3, 3),
    {'op_id': 'bad-kind-type', 'kind': [], 'coordinate_space': 'pixels', 'points': [{'x': 0, 'y': 0}]},
))
expect(InvalidOperationError, lambda: append_operation(
    {'schema_version': 'mask-operation-log/v1', 'width': 3, 'height': 3, 'operations': [None]},
    {'op_id': 'bad-existing', 'kind': 'clear'},
))
expect(InvalidOperationError, lambda: append_operation(
    {'schema_version': 'mask-operation-log/v1', 'width': 3, 'height': 3,
     'operations': [{'op_id': 'bad-existing', 'sequence': 9, 'kind': 'clear'}]},
    {'op_id': 'new', 'kind': 'clear'},
))
expect(InvalidOperationError, lambda: append_operation(
    new_operation_log(3, 3),
    {'op_id': 'bool-sequence', 'sequence': False, 'kind': 'clear'},
))
expect(InvalidOperationError, lambda: append_operation(
    new_operation_log(3, 3),
    {'op_id': 'float-sequence', 'sequence': 0.0, 'kind': 'clear'},
))
expect(InvalidCoordinateError, lambda: append_operation(
    new_operation_log(3, 3),
    {'op_id': 'huge', 'kind': 'paint', 'coordinate_space': 'pixels', 'points': [{'x': 10 ** 1000, 'y': 0}]},
))
expect(InvalidOperationError, lambda: replay_mask({
    'schema_version': 'mask-operation-log/v1', 'width': 2, 'height': 2,
    'operations': [{'op_id': 'bad', 'sequence': 1, 'kind': 'clear', 'coordinate_space': 'pixels'}],
}))
expect(InvalidOperationError, lambda: replay_mask({
    'schema_version': 'mask-operation-log/v1', 'width': 1, 'height': 1,
    'operations': [{'op_id': 'bad-sequence', 'sequence': False, 'kind': 'clear'}],
}))
expect(MaskProvenanceError, lambda: build_sidecar(
    sidecar_id='bad-orientation', source_image_sha256='a' * 64, width=1, height=1,
    operation_log=new_operation_log(1, 1), provenance={'producer': 'ui'}, source_orientation=True,
))
expect(MaskProvenanceError, lambda: build_sidecar(
    sidecar_id='bad-producer-type', source_image_sha256='a' * 64, width=1, height=1,
    operation_log=new_operation_log(1, 1), provenance={'producer': []},
))
expect(UnsafePublishTargetError, lambda: validate_publish_target(
    'C:/workspace/source.png', 'C:/workspace/source.png', 'complete'))
expect(IncompleteStagingError, lambda: validate_publish_target(
    'C:/workspace/source.png', 'C:/workspace/out.mask.png', 'writing'))
expect(IncompleteStagingError, lambda: replay_mask(
    {'schema_version': 'mask-operation-log/v1', 'width': 1, 'height': 1, 'operations': []},
    staging_state='cancelled'))
expect(MaskProvenanceError, lambda: build_sidecar(
    sidecar_id='sidecar-bad-producer', source_image_sha256='a' * 64,
    width=1, height=1, operation_log=new_operation_log(1, 1),
    provenance={'producer': 'manual'}))
base_log = new_operation_log(1, 1, base_mask=b'\x00')
expect(InvalidOperationError, lambda: replay_mask(base_log))
assert replay_mask(base_log, initial_mask=b'\x00') == b'\x00'
expect(IncompleteStagingError, lambda: validate_publish_target(
    'C:/workspace/source.png', 'C:/workspace/out.mask.png', []))
with tempfile.TemporaryDirectory() as directory:
    source = os.path.join(directory, 'source.png')
    output = os.path.join(directory, 'alias.mask.png')
    with open(source, 'wb') as handle:
        handle.write(b'source')
    try:
        os.link(source, output)
    except OSError:
        raise AssertionError('hardlink fixture could not be created')
    expect(UnsafePublishTargetError, lambda: validate_publish_target(source, output, 'complete'))
print('rejections-ok')
`);
  assert.equal(output, 'rejections-ok');
});
