"""Extrait la 1ere frame de chaque PNG anime du dossier exercices/
pour generer la version statique correspondante (nom-static.png),
utilisee sur l'accueil (renderExercisePicto, niveau 1 du repli).

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
            im.seek(0)
            frame = im.convert("RGBA")
            frame.save(dest)
        print(f"{src.name} -> {dest.name}")


if __name__ == "__main__":
    main()
