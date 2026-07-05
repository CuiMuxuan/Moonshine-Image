import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import typer
from fastapi import FastAPI
from loguru import logger
from typer import Option
from typer_config import use_json_config

from moonshine_server.const import *
from moonshine_server.runtime import setup_model_dir, dump_environment_info, check_device
from moonshine_server.schema import Device, RealESRGANModel, RemoveBGModel

typer_app = typer.Typer(pretty_exceptions_show_locals=False, add_completion=False)


@typer_app.command(help="Install all plugins dependencies")
def install_plugins_packages():
    from moonshine_server.installer import install_plugins_package

    install_plugins_package()


@typer_app.command(help="Download an erase model")
def download(
    model: str = Option(
        ..., help=f"Erase model name, e.g. one of [{', '.join(AVAILABLE_MODELS)}]"
    ),
    model_dir: Path = Option(
        DEFAULT_MODEL_DIR,
        help=MODEL_DIR_HELP,
        file_okay=False,
        callback=setup_model_dir,
    ),
):
    from moonshine_server.download import cli_download_model

    cli_download_model(model)


@typer_app.command(name="list", help="List downloaded models")
def list_model(
    model_dir: Path = Option(
        DEFAULT_MODEL_DIR,
        help=MODEL_DIR_HELP,
        file_okay=False,
        callback=setup_model_dir,
    ),
):
    from moonshine_server.download import scan_models

    scanned_models = scan_models()
    for it in scanned_models:
        print(it.name)


@typer_app.command(help="Batch processing images")
def run(
    model: str = Option("lama"),
    device: Device = Option(Device.cpu),
    image: Path = Option(..., help="Image folders or file path"),
    mask: Path = Option(
        ...,
        help="Mask folders or file path. "
        "If it is a directory, the mask images in the directory should have the same name as the original image."
        "If it is a file, all images will use this mask."
        "Mask will automatically resize to the same size as the original image.",
    ),
    output: Path = Option(..., help="Output directory or file path"),
    config: Path = Option(
        None, help="Config file path. You can use dump command to create a base config."
    ),
    concat: bool = Option(
        False, help="Concat original image, mask and output images into one image"
    ),
    model_dir: Path = Option(
        DEFAULT_MODEL_DIR,
        help=MODEL_DIR_HELP,
        file_okay=False,
        callback=setup_model_dir,
    ),
):
    from moonshine_server.download import cli_download_model, scan_models

    scanned_models = scan_models()
    if model not in [it.name for it in scanned_models]:
        logger.info(f"{model} not found in {model_dir}, try to downloading")
        cli_download_model(model)

    from moonshine_server.batch_processing import batch_inpaint

    batch_inpaint(model, device, image, mask, output, config, concat)


@typer_app.command(help="Start Moonshine Server server")
@use_json_config()
def start(
    host: str = Option("127.0.0.1"),
    port: int = Option(8080),
    inbrowser: bool = Option(False, help=INBROWSER_HELP),
    model: str = Option(
        DEFAULT_MODEL,
        help=f"Erase models: [{', '.join(AVAILABLE_MODELS)}].",
    ),
    model_dir: Path = Option(
        DEFAULT_MODEL_DIR,
        help=MODEL_DIR_HELP,
        dir_okay=True,
        file_okay=False,
        callback=setup_model_dir,
    ),
    low_mem: bool = Option(False, help=LOW_MEM_HELP),
    no_half: bool = Option(False, help=NO_HALF_HELP),
    cpu_offload: bool = Option(False, help="Compatibility option; ignored by erase models."),
    disable_nsfw_checker: bool = Option(False, help="Compatibility option; ignored by erase models."),
    cpu_textencoder: bool = Option(False, help="Compatibility option; ignored by erase models."),
    local_files_only: bool = Option(False, help="Run without downloading remote model files."),
    sam_release_before_processing: bool = Option(
        True,
        help="Release cached SAM predictors before running image/video processing models.",
    ),
    device: Device = Option(Device.cpu),
    input: Optional[Path] = Option(None, help=INPUT_HELP),
    mask_dir: Optional[Path] = Option(
        None, help=MODEL_DIR_HELP, dir_okay=True, file_okay=False
    ),
    output_dir: Optional[Path] = Option(
        None, help=OUTPUT_DIR_HELP, dir_okay=True, file_okay=False
    ),
    quality: int = Option(95, help=QUALITY_HELP),
    enable_remove_bg: bool = Option(False, help=REMOVE_BG_HELP),
    remove_bg_device: Device = Option(Device.cpu, help=REMOVE_BG_DEVICE_HELP),
    remove_bg_model: RemoveBGModel = Option(RemoveBGModel.briaai_rmbg_1_4),
    enable_anime_seg: bool = Option(False, help=ANIMESEG_HELP),
    enable_realesrgan: bool = Option(False),
    realesrgan_device: Device = Option(Device.cpu),
    realesrgan_model: RealESRGANModel = Option(RealESRGANModel.realesr_general_x4v3),
    enable_gfpgan: bool = Option(False),
    gfpgan_device: Device = Option(Device.cpu),
    enable_restoreformer: bool = Option(False),
    restoreformer_device: Device = Option(Device.cpu),
):
    dump_environment_info()
    device = check_device(device)
    remove_bg_device = check_device(remove_bg_device)
    realesrgan_device = check_device(realesrgan_device)
    gfpgan_device = check_device(gfpgan_device)

    if input and not input.exists():
        logger.error(f"invalid --input: {input} not exists")
        exit(-1)
    if mask_dir and not mask_dir.exists():
        logger.error(f"invalid --mask-dir: {mask_dir} not exists")
        exit(-1)
    if input and input.is_dir() and not output_dir:
        logger.error(
            "invalid --output-dir: --output-dir must be set when --input is a directory"
        )
        exit(-1)
    if output_dir:
        output_dir = output_dir.expanduser().absolute()
        logger.info(f"Image will be saved to {output_dir}")
        if not output_dir.exists():
            logger.info(f"Create output directory {output_dir}")
            output_dir.mkdir(parents=True)
    if mask_dir:
        mask_dir = mask_dir.expanduser().absolute()

    model_dir = model_dir.expanduser().absolute()

    if local_files_only:
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_OFFLINE"] = "1"

    from moonshine_server.download import cli_download_model, scan_models

    scanned_models = scan_models()
    if model not in [it.name for it in scanned_models]:
        if input:
            logger.info(f"{model} not found in {model_dir}, try to downloading")
            cli_download_model(model)
        else:
            logger.warning(
                f"{model} not found in {model_dir}. Server will start without a loaded model."
            )

    from moonshine_server.api import Api
    from moonshine_server.schema import ApiConfig

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if inbrowser:
            webbrowser.open(f"http://localhost:{port}", new=0, autoraise=True)
        yield

    app = FastAPI(lifespan=lifespan)

    api_config = ApiConfig(
        host=host,
        port=port,
        inbrowser=inbrowser,
        model=model,
        no_half=no_half,
        low_mem=low_mem,
        cpu_offload=cpu_offload,
        disable_nsfw_checker=disable_nsfw_checker,
        local_files_only=local_files_only,
        cpu_textencoder=cpu_textencoder if device == Device.cuda else False,
        sam_release_before_processing=sam_release_before_processing,
        device=device,
        input=input,
        mask_dir=mask_dir,
        output_dir=output_dir,
        quality=quality,
        enable_remove_bg=enable_remove_bg,
        remove_bg_device=remove_bg_device,
        remove_bg_model=remove_bg_model,
        enable_anime_seg=enable_anime_seg,
        enable_realesrgan=enable_realesrgan,
        realesrgan_device=realesrgan_device,
        realesrgan_model=realesrgan_model,
        enable_gfpgan=enable_gfpgan,
        gfpgan_device=gfpgan_device,
        enable_restoreformer=enable_restoreformer,
        restoreformer_device=restoreformer_device,
    )
    print(api_config.model_dump_json(indent=4))
    api = Api(app, api_config)
    api.launch()


