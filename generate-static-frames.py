"""Extrait la frame 7 (index 6) de chaque PNG anime du dossier exercices/
pour generer la version statique correspondante (nom-static.png),
utilisee sur l'accueil (renderExercisePicto, niveau 1 du repli). La frame 7
est en general plus representative du mouvement que la 1ere (souvent une
position de depart trop neutre). Les images a une seule frame gardent leur
logique d'origine (rien a choisir).

Redimensionne aussi la frame extraite a une resolution raisonnable : ces
miniatures ne sont jamais affichees a plus de 64px CSS (voir .exercise-picto
dans index.html), or les sources sont a 360-1024px de cote — 6 a 16x plus de
pixels que necessaire. RESIZE_TO_PX vise le double de la taille d'affichage
(retina) tout en restant tres largement suffisant.

Usage: python generate-static-frames.py
Puis (recommande) : python generate-webp-assets.py, pour generer la version
WebP — bien plus legere — de ces PNG statiques (et des PNG animes).
"""

from pathlib import Path
from PIL import Image

EXERCICES_DIR = Path(__file__).parent / "exercices"
TARGET_FRAME_INDEX = 6  # frame 7 en base 1
RESIZE_TO_PX = 128  # 2x la taille d'affichage reelle (64px CSS), suffisant en retina


def main():
    sources = sorted(
        p for p in EXERCICES_DIR.glob("*.png")
        if not p.stem.endswith("-static")
    )

    if not sources:
        print(f"Aucun PNG source trouve dans {EXERCICES_DIR}")
        return

    for src in sources:
        dest = src.with_name(f"{src.stem}-static.png")
        with Image.open(src) as im:
            n_frames = getattr(im, "n_frames", 1)
            if n_frames <= 1:
                frame_index = 0  # image a un seul frame : logique d'origine inchangee
            else:
                # si l'animation compte moins de 7 frames, se rabat sur la derniere disponible
                frame_index = min(TARGET_FRAME_INDEX, n_frames - 1)
            im.seek(frame_index)
            frame = im.convert("RGBA")
            frame.thumbnail((RESIZE_TO_PX, RESIZE_TO_PX), Image.LANCZOS)
            frame.save(dest, optimize=True)
        print(f"{src.name} -> {dest.name} (frame {frame_index + 1}/{n_frames}, {frame.size[0]}x{frame.size[1]})")


if __name__ == "__main__":
    main()
