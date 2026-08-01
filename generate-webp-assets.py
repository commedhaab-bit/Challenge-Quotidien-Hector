"""Genere une version WebP (format moderne, bien plus compact que le PNG/APNG)
de chaque image du dossier exercices/, EN PLUS du PNG source (jamais a la place :
les .png restent les fichiers maitres, les .webp sont une optimisation de
diffusion). L'appli (renderExercisePicto / fiche detail) essaie d'abord le
.webp et retombe automatiquement sur le .png existant si absent (onerror),
donc ce script est sans risque a relancer meme partiellement.

- *-static.png (miniatures fixes, listes Aujourd'hui/Défis) -> WebP statique,
  qualite 82 (fichiers deja petits, on privilegie la qualite visuelle).
- *.png (illustrations animees plein cadre, fiche detail) -> WebP anime,
  qualite 75, memes frames et durees que la source APNG (perte de poids bien
  plus importante ici, d'ou une qualite un peu plus compressee, sur un
  affichage plus grand donc moins sensible aux artefacts par pixel).

Usage: python generate-webp-assets.py
"""

from pathlib import Path
from PIL import Image, ImageSequence

EXERCICES_DIR = Path(__file__).parent / "exercices"
STATIC_QUALITY = 82
ANIMATED_QUALITY = 75


def convert_static(src: Path) -> tuple[int, int]:
    dest = src.with_suffix(".webp")
    with Image.open(src) as im:
        im.convert("RGBA").save(dest, "WEBP", quality=STATIC_QUALITY, method=6)
    return src.stat().st_size, dest.stat().st_size


def convert_animated(src: Path) -> tuple[int, int]:
    dest = src.with_suffix(".webp")
    with Image.open(src) as im:
        n_frames = getattr(im, "n_frames", 1)
        if n_frames <= 1:
            im.convert("RGBA").save(dest, "WEBP", quality=ANIMATED_QUALITY, method=6)
            return src.stat().st_size, dest.stat().st_size

        frames = []
        durations = []
        for frame in ImageSequence.Iterator(im):
            frames.append(frame.convert("RGBA").copy())
            durations.append(frame.info.get("duration", 100))

        loop = im.info.get("loop", 0)
        frames[0].save(
            dest,
            "WEBP",
            save_all=True,
            append_images=frames[1:],
            duration=durations,
            loop=loop,
            quality=ANIMATED_QUALITY,
            method=6,
        )
    return src.stat().st_size, dest.stat().st_size


def main():
    sources = sorted(EXERCICES_DIR.glob("*.png"))
    if not sources:
        print(f"Aucun PNG source trouve dans {EXERCICES_DIR}")
        return

    total_before = 0
    total_after = 0
    for src in sources:
        is_static = src.stem.endswith("-static")
        before, after = (convert_static if is_static else convert_animated)(src)
        total_before += before
        total_after += after
        pct = 100 * (1 - after / before) if before else 0
        print(f"{src.name:32s} {before/1024:8.0f} KB -> {after/1024:8.0f} KB  (-{pct:.0f}%)")

    print(f"\nTotal : {total_before/1024/1024:.1f} MB -> {total_after/1024/1024:.1f} MB "
          f"(-{100*(1 - total_after/total_before):.0f}%)")


if __name__ == "__main__":
    main()
