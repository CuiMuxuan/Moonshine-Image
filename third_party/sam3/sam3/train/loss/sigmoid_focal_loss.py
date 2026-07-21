# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved

# pyre-unsafe

"""Triton kernel for faster and memory efficient sigmoid focal loss"""

import torch
import torch.nn.functional as F
from sam3._moonshine_compat import disable_triton, get_triton_modules, triton_enabled


if triton_enabled():
    triton, tl = get_triton_modules()
    from torch._inductor.runtime.triton_helpers import libdevice
else:
    class _DisabledTriton:
        @staticmethod
        def jit(function):
            return function

    class _DisabledTritonLanguage:
        constexpr = object()

    class _DisabledLibdevice:
        def __getattr__(self, name):
            raise RuntimeError("Triton focal-loss kernels are unavailable")

    triton = _DisabledTriton()
    tl = _DisabledTritonLanguage()
    libdevice = _DisabledLibdevice()

"""

The sigmoid focal loss is defined as:

    prob = inputs.sigmoid()
    ce_loss = F.binary_cross_entropy_with_logits(inputs, targets, reduction="none")
    p_t = prob * targets + (1 - prob) * (1 - targets)
    alpha_t = alpha * targets + (1 - alpha) * (1 - targets)
    loss = alpha_t * ce_loss * ((1 - p_t) ** gamma)

Where alpha and gamma are scalar parameters, inputs are the logits, targets the float targets.

We implement two versions of the sigmoid focal loss: with and without sum reduction.
The latter is implemented with built-in reduction to avoid materializing wrt the output of the loss.
This can help save a bit of peak memory.

The reduction version is implemented using somewhat of a hack. Pytorch's generated kernels usually do the point-wise operation in a first kernel, and implement the reduction another kernel launched on a grid of size 1, where the reduction happens as a for loop in the triton kernel.
Since we want to fuse those two kernels, that is not a good idea: we'd have to launch the overall kernel on a grid of size 1, which is obviously inefficient.
On the other hand, typical CUDA algorithms for reduction (eg reduction tree) are hard to implement in triton due to the lack of thread sync primitives.
We settle for a version that abuses triton's atomic_add: we can have all threads simply add to the same location.
In practice, this is not good, since it creates a massive bottleneck on the semaphore for that single memory location. So instead, we create M reduction locations. Each thread will simply write to thread_id%M. The python code can finally sum over the M reductions.
M = 32 works fine in benchmarking tests. The forward is a tiny bit slower compared to the non-reduced kernel, but the backward breaks even due to one less memory allocation.
"""


@triton.jit
def _inner_focal_loss_fwd(inputs, targets, alpha, gamma):
    inv_targets = 1 - targets
    # Sigmoid
    sig = tl.sigmoid(inputs)

    # Binary cross entropy with logits
    # In practice, we want the following:
    # bce_loss = -targets * tl.log(sig) - (1 - targets) * tl.log(1 - sig)
    # However, the above is not numerically stable.
    # We're also not directly taking the sum here, so the usual log-sum-exp trick doesn't apply
    # The bce can be reformulated, after algebraic manipulation, to
    # bce_loss = log(1 + exp(-x)) + x * (1-y)
    # This is still not stable, because for large (-x) the exponential will blow up.
    # We'll use the following alternate formulation:
    # bce_loss = max(x, 0) - x * y + log(1 + exp(-abs(x)))
    # Let's show that it's equivalent:
    # Case x>=0: abs(x) = x , max(x, 0) = x
    # so we get x - x * y + log(1 + exp(-x)) which is equivalent
    # Case x<0: abs(x) = -x, max(x, 0) = 0
    # we have log(1 + exp(-abs(x))) = log(1 + exp(x)) = log(exp(x)(1 + exp(-x))) = x+log(1 + exp(-x))
    # plugging it in, we get
    # 0 - x * y + x + log(1 + exp(-x)), which is also equivalent
    # Note that this is stable because now the exponent are guaranteed to be below 0.
    max_val = tl.clamp(inputs, min=0, max=1e9)
    bce_loss = max_val - inputs * targets + tl.log(1 + tl.exp(-tl.abs(inputs)))

    # Modulating factor
    p_t = sig * targets + (1 - sig) * inv_targets
    mod_factor = libdevice.pow(1 - p_t, gamma)

    # Alpha factor
    alpha_t = alpha * targets + (1 - alpha) * inv_targets

    # Final loss calculation
    return alpha_t * mod_factor * bce_loss


# Non-reduced version
@triton.jit
def sigmoid_focal_loss_fwd_kernel(
    inputs_ptr,
    targets_ptr,
    loss_ptr,
    alpha: float,
    gamma: float,
    n_elements: int,
    BLOCK_SIZE: tl.constexpr,
):
    pid = tl.program_id(axis=0)
    block_start = pid * BLOCK_SIZE
    offset = block_start + tl.arange(0, BLOCK_SIZE)
    mask = offset < n_elements

    # Load data
    inputs = tl.load(inputs_ptr + offset, mask=mask).to(tl.float32)
    targets = tl.load(targets_ptr + offset, mask=mask)

    final_loss = _inner_focal_loss_fwd(inputs, targets, alpha, gamma)

    # Store result
    tl.store(loss_ptr + offset, final_loss, mask=mask)


# version with reduction
@triton.jit
def sigmoid_focal_loss_fwd_kernel_reduce(
    inputs_ptr,
    targets_ptr,
    loss_ptr,
    alpha: float,
    gamma: float,
    n_elements: int,
    BLOCK_SIZE: tl.constexpr,
    REDUCE_SIZE: tl.constexpr,
):
    pid = tl.program_id(axis=0)
    block_start = pid * BLOCK_SIZE
    reduce_loc = pid % REDUCE_SIZE
    offset = block_start + tl.arange(0, BLOCK_SIZE)
    mask = offset < n_elements
    # Load data
    inputs = tl.load(inputs_ptr + offset, mask=mask).to(tl.float32)
    targets = tl.load(targets_ptr + offset, mask=mask)

    final_loss = _inner_focal_loss_fwd(inputs, targets, alpha, gamma) * mask

    fl = tl.sum(final_loss)

    # Store result
    tl.atomic_add(loss_ptr + reduce_loc, fl)


@triton.jit
def _inner_focal_loss_bwd(inputs, targets, alpha, gamma):
    inv_targets = 1 - targets

    # Recompute forward
    max_val = tl.clamp(inputs, min=0, max=1e9)
    bce_loss = max_val - inputs * targets + tl.log(1 + tl.exp(-tl.abs(inputs)))

    # Sigmoid
    sig = tl.sigmoid(inputs)
    inv_sig = 1 - sig

    # Modulating factor
    p_t = sig * targets + inv_sig * inv_targets
    tmp = libdevice.pow(1 - p_t, gamma - 1)
    mod_factor = tmp * (1 - p_t)

    # Alpha factor
    alpha_t = alpha * targets + (1 - alpha) * inv_targets

    # Now computing the derivatives
    d_pt = (2 * targets - 1) * sig * inv_sig
    d_mod_factor = -gamma * d_pt * tmp

    d_bce_loss = sig - targets

    return alpha_t * (d_bce_loss * mod_factor + d_mod_factor * bce_loss)


@triton.jit
def sigmoid_focal_loss_bwd_kernel(
    inputs_ptr,
    targets_ptr,
    grad_inputs_ptr,
    grad_out_ptr,
    alpha: float,
    gamma: float,
    n_elements: int,
    BLOCK_SIZE: tl.constexpr,
):
    pid = tl.program_id(axis=0)
    block_start = pid * BLOCK_SIZE
    offset = block_start + tl.arange(0, BLOCK_SIZE)
    mask = offset < n_elements
    input_ptrs = inputs_ptr + offset
    target_ptrs = targets_ptr + offset
    grad_input_ptrs = grad_inputs_ptr + offset
    grad_out_ptrs = grad_out_ptr + offset
    # Load data
    inputs = tl.load(input_ptrs, mask=mask).to(tl.float32)
    targets = tl.load(target_ptrs, mask=mask)
    grad_out = tl.load(grad_out_ptrs, mask=mask)
    d_loss = grad_out * _inner_focal_loss_bwd(inputs, targets, alpha, gamma)
    tl.store(grad_input_ptrs, d_loss, mask=mask)


@triton.jit
def sigmoid_focal_loss_bwd_kernel_reduce(
    inputs_ptr,
    targets_ptr,
    grad_inputs_ptr,
    grad_out_ptr,
    alpha: float,
    gamma: float,
    n_elements: int,
    BLOCK_SIZE: tl.constexpr,
):
    # The only difference is that the gradient is now a single scalar
    pid = tl.program_id(axis=0)
    block_start = pid * BLOCK_SIZE
    offset = block_start + tl.arange(0, BLOCK_SIZE)
    mask = offset < n_elements
    input_ptrs = inputs_ptr + offset
    target_ptrs = targets_ptr + offset
    grad_input_ptrs = grad_inputs_ptr + offset
    # Load data
    inputs = tl.load(input_ptrs, mask=mask).to(tl.float32)
    targets = tl.load(target_ptrs, mask=mask)
    grad_out = tl.load(grad_out_ptr)
    d_loss = grad_out * _inner_focal_loss_bwd(inputs, targets, alpha, gamma)
    tl.store(grad_input_ptrs, d_loss, mask=mask)


class SigmoidFocalLoss(torch.autograd.Function):
    BLOCK_SIZE = 256

    @staticmethod
    def forward(ctx, inputs, targets, alpha=0.25, gamma=2):
        n_elements = inputs.numel()
        assert targets.numel() == n_elements
        input_shape = inputs.shape
        inputs = inputs.view(-1).contiguous()
        targets = targets.view(-1).contiguous()
        loss = torch.empty(inputs.shape, dtype=torch.float32, device=inputs.device)
        grid = lambda meta: (triton.cdiv(n_elements, meta["BLOCK_SIZE"]),)
        sigmoid_focal_loss_fwd_kernel[grid](
            inputs, targets, loss, alpha, gamma, n_elements, SigmoidFocalLoss.BLOCK_SIZE
        )
        ctx.save_for_backward(inputs.view(input_shape), targets.view(input_shape))
        ctx.alpha = alpha
        ctx.gamma = gamma
        return loss.view(input_shape)

    @staticmethod
    def backward(ctx, grad_output):
        inputs, targets = ctx.saved_tensors
        alpha = ctx.alpha
        gamma = ctx.gamma
        n_elements = inputs.numel()
        input_shape = inputs.shape
        grad_inputs = torch.empty(
            inputs.shape, dtype=grad_output.dtype, device=grad_output.device
        )
        inputs_ptr = inputs.view(-1).contiguous()
        targets_ptr = targets.view(-1).contiguous()
        grad_output_ptr = grad_output.view(-1).contiguous()
        grad_inputs_ptr = grad_inputs
        assert grad_output.numel() == n_elements
        grid = lambda meta: (triton.cdiv(n_elements, meta["BLOCK_SIZE"]),)
        sigmoid_focal_loss_bwd_kernel[grid](
            inputs_ptr,
            targets_ptr,
            grad_inputs_ptr,
            grad_output_ptr,
            alpha,
            gamma,
            n_elements,
            SigmoidFocalLoss.BLOCK_SIZE,
        )
        return grad_inputs.view(input_shape), None, None, None


def _torch_sigmoid_focal_loss(inputs, targets, alpha=0.25, gamma=2):
    targets = targets.to(dtype=inputs.dtype)
    probabilities = inputs.sigmoid()
    cross_entropy = F.binary_cross_entropy_with_logits(inputs, targets, reduction="none")
    probability_target = probabilities * targets + (1 - probabilities) * (1 - targets)
    alpha_target = alpha * targets + (1 - alpha) * (1 - targets)
    return alpha_target * (1 - probability_target).pow(gamma) * cross_entropy


def triton_sigmoid_focal_loss(inputs, targets, alpha=0.25, gamma=2):
    if inputs.is_cuda and triton_enabled():
        try:
            return SigmoidFocalLoss.apply(inputs, targets, alpha, gamma)
        except Exception as error:
            disable_triton(error)
    return _torch_sigmoid_focal_loss(inputs, targets, alpha, gamma)


class SigmoidFocalLossReduced(torch.autograd.Function):
    BLOCK_SIZE = 256
    REDUCE_SIZE = 32

    @staticmethod
    def forward(ctx, inputs, targets, alpha=0.25, gamma=2):
        n_elements = inputs.numel()
        input_shape = inputs.shape
        inputs = inputs.view(-1).contiguous()
        targets = targets.view(-1).contiguous()
        loss = torch.zeros(
            SigmoidFocalLossReduced.REDUCE_SIZE,
            device=inputs.device,
            dtype=torch.float32,
        )
        grid = lambda meta: (triton.cdiv(n_elements, meta["BLOCK_SIZE"]),)
        sigmoid_focal_loss_fwd_kernel_reduce[grid](
            inputs,
            targets,
            loss,
            alpha,
            gamma,
            n_elements,
            SigmoidFocalLossReduced.BLOCK_SIZE,
            SigmoidFocalLossReduced.REDUCE_SIZE,
        )
        ctx.save_for_backward(inputs.view(input_shape), targets.view(input_shape))
        ctx.alpha = alpha
        ctx.gamma = gamma
        return loss.sum()

    @staticmethod
    def backward(ctx, grad_output):
        inputs, targets = ctx.saved_tensors
        alpha = ctx.alpha
        gamma = ctx.gamma
        n_elements = inputs.numel()
        input_shape = inputs.shape
        grad_inputs = torch.empty(
            inputs.shape, dtype=grad_output.dtype, device=grad_output.device
        )
        inputs_ptr = inputs.view(-1).contiguous()
        targets_ptr = targets.reshape(-1).contiguous()
        assert grad_output.numel() == 1
        grid = lambda meta: (triton.cdiv(n_elements, meta["BLOCK_SIZE"]),)
        sigmoid_focal_loss_bwd_kernel_reduce[grid](
            inputs_ptr,
            targets_ptr,
            grad_inputs,
            grad_output,
            alpha,
            gamma,
            n_elements,
            SigmoidFocalLossReduced.BLOCK_SIZE,
        )
        return grad_inputs.view(input_shape), None, None, None


def triton_sigmoid_focal_loss_reduce(inputs, targets, alpha=0.25, gamma=2):
    if inputs.is_cuda and triton_enabled():
        try:
            return SigmoidFocalLossReduced.apply(inputs, targets, alpha, gamma)
        except Exception as error:
            disable_triton(error)
    return _torch_sigmoid_focal_loss(inputs, targets, alpha, gamma).sum()
