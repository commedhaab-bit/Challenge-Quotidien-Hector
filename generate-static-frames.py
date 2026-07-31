"""Extrait la frame 7 (index 6) de chaque PNG anime du dossier exercices/
pour generer la version statique correspondante (nom-static.png),
utilisee sur l'accueil (renderExercisePicto, niveau 1 du repli). La frame 7
est en general plus representative du mouvement que la 1ere (souvent une
position de depart trop neutre). Les images a une seule frame gardent leur
logique d'origine (rien a choisir).

Usage: python generate-static-frames.py
"""

from pathlib import Path
from PIL import Image

EXERCICES_DIR = Path(__file__).parent / "exercices"
TARGET_FRAME_INDEX = 6  # frame 7 en base 1


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
            frame.save(dest)
        print(f"{src.name} -> {dest.name} (frame {frame_index + 1}/{n_frames})")


if __name__ == "__main__":
    main()
