import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanCrmPortalDescription,
  listingPortalFooter,
  normalizeCrmPortalDescription,
} from "../lib/listing-description-policy.mjs";

const rawDescription = `**Opis na portale**
**Kompaktowe mieszkanie 31,1 m² na osiedlu Kopernika.**
**Dwa pokoje, nowa winda i balkon.**
Świetne jako pierwsze mieszkanie lub pod inwestycję – większość mebli zostaje.

**Lokalizacja**
Mieszkanie znajduje się przy ul. Oriona w Głogowie.

**Rozkład i powierzchnia**
Lokal ma 31,1 m² i dwa pokoje.

**Atuty ze zdjęć**
Nie dołączono zdjęć - sekcja do uzupełnienia po analizie fotografii.

**Kontrola danych**
Warto potwierdzić stan prawny.

**Pytania do właściciela**
Czy lokal ma piwnicę?`;

test("usuwa luźne trzecie zdanie i utrzymuje maksymalnie dwa zdania otwarcia", () => {
  const result = normalizeCrmPortalDescription(rawDescription, "apartment");
  assert.match(result, /^\*\*KOMPAKTOWE MIESZKANIE 31,1 M² NA OSIEDLU KOPERNIKA\. DWA POKOJE, NOWA WINDA I BALKON\.\*\*/);
  assert.doesNotMatch(result, /Świetne jako pierwsze mieszkanie/i);
  assert.match(result, /\*\*Lokalizacja\*\*/);
});

test("zwraca wyłącznie czysty opis portalowy", () => {
  const result = normalizeCrmPortalDescription(rawDescription, "apartment");
  for (const forbidden of ["Opis na portale", "Atuty ze zdjęć", "Kontrola danych", "Pytania do właściciela"]) {
    assert.doesNotMatch(result, new RegExp(forbidden, "i"));
  }
});

test("dodaje dokładnie jedną zatwierdzoną stopkę FREE HOME", () => {
  const result = normalizeCrmPortalDescription(rawDescription, "apartment");
  assert.equal(result.match(/FREE HOME nieruchomości Głogów/gi)?.length, 1);
  assert.ok(result.endsWith(listingPortalFooter("apartment")));
});

test("zastępuje samowolnie zmienioną stopkę właściwym wariantem", () => {
  const input = `**DOM GOTOWY DO ZAMIESZKANIA.**\n\n**Lokalizacja**\nDom znajduje się w Głogowie.\n\n**FREE HOME nieruchomości Głogów**\nDowolny tekst wymyślony przez model.`;
  const result = normalizeCrmPortalDescription(input, "house");
  assert.doesNotMatch(result, /Dowolny tekst wymyślony/);
  assert.ok(result.endsWith(listingPortalFooter("house")));
  assert.match(result, /prezentację tego domu/i);
});

test("sam filtr odcina materiały pomocnicze od opisu", () => {
  const result = cleanCrmPortalDescription(`**Opis na portale**\nTreść oferty.\n\n**Sugestie tytułów**\nTytuł 1`);
  assert.equal(result, "Treść oferty.");
});
