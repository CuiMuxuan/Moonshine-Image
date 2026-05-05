from .fcf import FcF
from .lama import AnimeLaMa, LaMa
from .ldm import LDM
from .manga import Manga
from .mat import MAT
from .mi_gan import MIGAN
from .opencv2 import OpenCV2
from .zits import ZITS

models = {
    LaMa.name: LaMa,
    AnimeLaMa.name: AnimeLaMa,
    LDM.name: LDM,
    ZITS.name: ZITS,
    MAT.name: MAT,
    FcF.name: FcF,
    OpenCV2.name: OpenCV2,
    Manga.name: Manga,
    MIGAN.name: MIGAN,
}
