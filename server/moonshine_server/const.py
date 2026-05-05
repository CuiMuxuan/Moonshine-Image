import os

MPS_UNSUPPORT_MODELS = [
    "lama",
    "anime-lama",
    "ldm",
    "zits",
    "mat",
    "fcf",
    "cv2",
    "manga",
]

DEFAULT_MODEL = "lama"
AVAILABLE_MODELS = ["lama", "anime-lama", "ldm", "zits", "mat", "fcf", "manga", "cv2", "migan"]

NO_HALF_HELP = "Use full precision model weights when the selected model supports it."
LOW_MEM_HELP = "Enable low memory mode when the selected model supports it."

DEFAULT_MODEL_DIR = os.path.abspath(
    os.getenv("XDG_CACHE_HOME", os.path.join(os.path.expanduser("~"), ".cache"))
)

MODEL_DIR_HELP = f"""
Model directory. By default models are stored in {DEFAULT_MODEL_DIR}
"""

OUTPUT_DIR_HELP = """
Result images will be saved to output directory automatically.
"""

MASK_DIR_HELP = """
You can view masks in FileManager.
"""

INPUT_HELP = """
If input is image, it will be loaded by default.
If input is directory, you can browse and select image in file manager.
"""

QUALITY_HELP = """
Image encoding quality, 0-100. Default is 95.
"""

INTERACTIVE_SEG_HELP = "Enable interactive segmentation using Segment Anything."
INTERACTIVE_SEG_MODEL_HELP = "Model size: mobile_sam < vit_b < vit_l < vit_h. Bigger model size means better segmentation but slower speed."
REMOVE_BG_HELP = "Enable remove background plugin."
REMOVE_BG_DEVICE_HELP = "Device for remove background plugin. 'cuda' only supports briaai models."
ANIMESEG_HELP = "Enable anime segmentation plugin. Always run on CPU."
REALESRGAN_HELP = "Enable RealESRGAN super resolution."
GFPGAN_HELP = "Enable GFPGAN face restore. To also enhance background, use with --enable-realesrgan."
RESTOREFORMER_HELP = "Enable RestoreFormer face restore. To also enhance background, use with --enable-realesrgan."
INBROWSER_HELP = "Automatically launch Moonshine Server in a new tab on the default browser."
