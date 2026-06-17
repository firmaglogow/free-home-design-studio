# FREE HOME Design - portfolio studia

Responsywna strona portfolio i oferty studia FREE HOME Design.

## Uruchomienie

Kliknij dwukrotnie `start.command`, a następnie otwórz:

http://127.0.0.1:4174/index.html

Możesz też uruchomić serwer ręcznie:

```bash
python3 -m http.server 4174 --bind 127.0.0.1
```

Strona nie wymaga instalowania zależności ani procesu budowania.

## Publikacja

Repozytorium jest przygotowane pod GitHub Pages. W ustawieniach repozytorium
wybierz `Settings` -> `Pages` -> `Deploy from a branch`, a potem gałąź `main`
i katalog `/root`.

## Pliki

- `index.html` - treść, portfolio, oferta, SEO i semantyczna struktura strony
- `styles.css` - pełny wygląd desktopowy i mobilny
- `app.js` - menu, FAQ, animacje i aktywna nawigacja
- `assets/free-home-design-logo.svg` - pełne logo poziome
- `assets/free-home-design-icon.svg` - sygnet używany na telefonie
- `assets/portfolio/` - zrzuty ekranów wybranych realizacji
- `app-preview.png` - podgląd desktopowy
- `app-preview-mobile.png` - podgląd mobilny
