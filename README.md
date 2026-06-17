# FREE HOME design Studio - portfolio studia

Responsywna strona portfolio i oferty studia FREE HOME design Studio.

## Uruchomienie

Kliknij dwukrotnie `start.command`, a następnie otwórz:

http://127.0.0.1:4174/index.html

Możesz też uruchomić serwer ręcznie:

```bash
python3 -m http.server 4174 --bind 127.0.0.1
```

Strona nie wymaga instalowania zależności ani procesu budowania.

## Publikacja

Repozytorium jest przygotowane pod GitHub Pages. Po włączeniu publikacji z
gałęzi `main` w ustawieniach repozytorium każdy `push` od razu odświeża stronę.
W katalogu głównym znajdują się pliki statyczne, więc nie ma tu żadnego buildu
ani zależności od Netlify.

Plik `CNAME` wskazuje domenę `nowoczesnaklimatyzacja.com.pl`, a `.nojekyll` wyłącza
obsługę Jekylla, żeby GitHub Pages serwował pliki dokładnie tak, jak są w repo.

## Pliki

- `index.html` - treść, portfolio, oferta, SEO i semantyczna struktura strony
- `styles.css` - pełny wygląd desktopowy i mobilny
- `app.js` - menu, FAQ, animacje i aktywna nawigacja
- `assets/free-home-design-logo.svg` - pełne logo poziome
- `assets/free-home-design-icon.svg` - sygnet używany na telefonie
- `assets/portfolio/` - zrzuty ekranów wybranych realizacji
- `app-preview.png` - podgląd desktopowy
- `app-preview-mobile.png` - podgląd mobilny
