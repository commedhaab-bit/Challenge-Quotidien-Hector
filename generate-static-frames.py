"""Extrait la 2e frame de chaque PNG anime du dossier exercices/
pour generer la version statique correspondante (nom-static.png),
utilisee sur l'accueil (renderExercisePicto, niveau 1 du repli).
La 2e frame est utilisee plutot que la 1ere car le mouvement y est
generalement plus representatif de l'exercice.

Usage: python generate-static-frames.py
"""

from pathlib import Path
from PIL import Image

EXERCICES_DIR = Path(__file__).parent / "exercices"


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
            frame_index = 1 if getattr(im, "n_frames", 1) > 1 else 0
            im.seek(frame_index)
            frame = im.convert("RGBA")
            frame.save(dest)
        print(f"{src.name} -> {dest.name}")


if __name__ == "__main__":
    main()
